// Action Spa Parts — Warehouse Bubbles API
// Single POST endpoint that mirrors the Apps Script action protocol so the PWA
// front-end only needs its API_URL pointed here — no other changes.
//
// Env vars expected:
//   DATABASE_URL    Postgres connection (Railway auto-injects via ${{Postgres.DATABASE_URL}})
//   MANAGER_PIN     6-digit PIN for manager-only actions (required)
//   MANAGER_EMAIL   where manager notifications go (optional)
//   RESEND_API_KEY  if set, emails are sent via Resend; otherwise logged-only
//   GMAIL_USER / GMAIL_APP_PASSWORD  if set, the Box Counter low-stock alert is sent via Gmail
//   PORT            Railway sets this automatically

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { Pool } = pg;

const DATABASE_URL  = process.env.DATABASE_URL;
const MANAGER_PIN   = process.env.MANAGER_PIN || '1234';
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
// Front-end version. Bump on every front-end change (together with sw.js CACHE)
// so open apps detect the new version and show the "Update" banner.
const APP_VERSION = '114';
const PORT          = process.env.PORT || 3000;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set.');
  process.exit(1);
}
if (!process.env.MANAGER_PIN) {
  console.warn('WARNING: MANAGER_PIN is not set — using the default "1234". Set it in Railway → Variables.');
}

// SSL is only needed for Railway's public proxy URLs (rlwy.net / railway.app).
// Internal URLs (postgres.railway.internal) don't need or want SSL.
const sslNeeded = /\.rlwy\.net|\.railway\.app/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslNeeded ? { rejectUnauthorized: false } : false,
  max: 5,
});

// =================================================================
// Schema bootstrap
// =================================================================

// Runs once on every boot. Safe to re-run: only adds the team_wide column if
// it's missing, and only backfills from old "whole team" descriptions at the
// moment the column is first created (so a later manager un-check is respected).
async function ensureSchema() {
  // Manager-editable settings (key/value), loaded first so the rest of boot can
  // read them (e.g. closing days). Backs the in-app Settings screen.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )`);
  await loadSettings();

  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'rules' AND column_name = 'team_wide'`
  );
  if (!rows.length) {
    await pool.query(`ALTER TABLE rules ADD COLUMN team_wide BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`UPDATE rules SET team_wide = true WHERE description ILIKE '%whole team%'`);
    console.log('Schema: added rules.team_wide and backfilled from descriptions.');
  }

  // Admin accounts (email + password) and their login sessions. Created on
  // first boot after this deploy; safe to run every time (IF NOT EXISTS).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      pw_salt    TEXT NOT NULL,
      pw_hash    TEXT NOT NULL,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token      TEXT PRIMARY KEY,
      admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS admin_sessions_admin_idx ON admin_sessions(admin_id)`);
  // Self-signups start pending until an existing admin approves them.
  await pool.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false`);

  // End-of-day warehouse checklist: task definitions, daily runs (one assigned
  // worker per day), and per-task results (with admin flags).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checklist_tasks (
      id         SERIAL PRIMARY KEY,
      category   TEXT NOT NULL DEFAULT 'General',
      label      TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checklist_runs (
      id           SERIAL PRIMARY KEY,
      run_date     DATE NOT NULL UNIQUE,
      employee_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
      submitted_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // The assignee taps "Start" when they begin; we stamp started_at then. The
  // manager-only timer is submitted_at - started_at. Added later → ALTER for
  // existing DBs (older runs have NULL started_at and just show no timer).
  await pool.query(`ALTER TABLE checklist_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
  // When a manager applies the "not started by the deadline" penalty, we stamp
  // this so the flag can't be penalized twice.
  await pool.query(`ALTER TABLE checklist_runs ADD COLUMN IF NOT EXISTS late_penalized_at TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checklist_items (
      id         SERIAL PRIMARY KEY,
      run_id     INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
      task_id    INTEGER REFERENCES checklist_tasks(id) ON DELETE SET NULL,
      category   TEXT NOT NULL DEFAULT '',
      label      TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      checked    BOOLEAN NOT NULL DEFAULT FALSE,
      flagged    BOOLEAN NOT NULL DEFAULT FALSE,
      flag_note  TEXT,
      flagged_by TEXT,
      flagged_at TIMESTAMPTZ
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS checklist_items_run_idx ON checklist_items(run_id)`);
  // When each box is ticked we stamp checked_at, so the manager can see the time
  // between checks (pacing). Added later → ALTER for existing DBs.
  await pool.query(`ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ`);

  // Seed the standard tasks once (only if the table is empty). Ordered by the
  // real closing flow: restock → clean up → power down → climate → lock up →
  // (separate) tablet-on-charger last. Existing DBs are reordered by the
  // 'checklist_phase_reorder_v1' migration below.
  const { rows: tc } = await pool.query('SELECT COUNT(*)::int AS n FROM checklist_tasks');
  if (tc[0].n === 0) {
    await pool.query(`
      INSERT INTO checklist_tasks (category, label, sort_order) VALUES
        ('Restock for Tomorrow', 'Restock packing tape, labels, and shipping supplies at each station.', 10),
        ('Restock for Tomorrow', 'Refill all printer paper trays (label, packing slip, and document printers).', 20),
        ('Restock for Tomorrow', 'Replace any low or empty toner / ink and set out spares if needed.', 30),
        ('Clean Up', 'Aisles and walkways clear; pallets and carts put away.', 40),
        ('Clean Up', 'Trash and cardboard removed; recycling emptied.', 50),
        ('Clean Up', 'Workstations wiped down and organized for the next shift.', 60),
        ('Park & Power Down', 'Forklifts / pallet jacks parked and plugged in to charge.', 70),
        ('Park & Power Down', 'Scanners and handheld devices placed on chargers.', 80),
        ('Park & Power Down', 'Computers / monitors at workstations shut down or locked.', 90),
        ('Climate Off', 'All fans are turned OFF.', 100),
        ('Climate Off', 'All A/C units are turned OFF.', 110),
        ('Climate Off', 'Heaters / space heaters are turned OFF (if applicable).', 120),
        ('Lock Up & Leave', 'All gates are CLOSED and locked.', 130),
        ('Lock Up & Leave', 'All overhead / dock doors are CLOSED and secured.', 140),
        ('Lock Up & Leave', 'All entry doors locked.', 150),
        ('Lock Up & Leave', 'All exterior and interior LIGHTS are turned OFF.', 160),
        ('Before You Leave', 'Put the checklist tablet back on its charger.', 200)`);
    console.log('Schema: seeded 17 checklist tasks.');
  }

  // Box Counter: packaging box sizes with current inventory + optional per-size
  // low threshold. The Friday count overwrites quantity (a weekly cycle count).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS box_sizes (
      id              SERIAL PRIMARY KEY,
      size            TEXT NOT NULL UNIQUE,
      quantity        INTEGER NOT NULL DEFAULT 0,
      low_threshold   INTEGER,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      last_counted_at TIMESTAMPTZ,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const { rows: bsc } = await pool.query('SELECT COUNT(*)::int AS n FROM box_sizes');
  if (bsc[0].n === 0) {
    await pool.query(`
      INSERT INTO box_sizes (size, quantity, sort_order) VALUES
        ('5x5x4', 24, 10), ('6x6x6', 5, 20), ('8x6x4', 4, 30), ('8x6x6', 13, 40),
        ('8x8x8', 5, 50), ('10x6x4', 0, 60), ('12x6x6', 4, 70), ('12x9x3', 1, 80),
        ('12x9x4', 2, 90), ('12x9x7', 6, 100), ('12x10x10', 0, 110), ('12x12x12', 5, 120),
        ('14x6x4', 0, 130), ('16x12x8', 5, 140), ('16x16x6', 10, 150), ('16x16x10', 1, 160),
        ('16x16x16', 23, 170), ('18x6x6', 14, 180), ('20x5x5', 10, 190), ('20x8x8', 1, 200),
        ('20x10x6', 6, 210), ('20x16x8', 5, 220), ('20x18x4', 1, 230), ('20x20x4', 6, 240),
        ('24x6x6', 7, 250), ('26x12x12', 8, 260), ('28x12x6', 7, 270), ('28x18x6', 2, 280),
        ('29x17x7', 29, 290), ('29x17x12', 4, 300), ('32x17x16', 3, 310)`);
    console.log('Schema: seeded 31 box sizes.');
  }
  await pool.query(`ALTER TABLE box_sizes ADD COLUMN IF NOT EXISTS disregarded BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE box_sizes ADD COLUMN IF NOT EXISTS last_counted_by TEXT`);

  // Box Counter activity log — who entered/changed box info and when.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS box_activity (
      id        SERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
      person    TEXT NOT NULL DEFAULT '',
      action    TEXT NOT NULL,
      detail    TEXT NOT NULL DEFAULT ''
    )`);

  // Imported Resources: manager-curated external links shown on the home
  // launcher's "Imported Resources" screen. Anyone signed in can open them;
  // only managers add/edit/remove. Grouped by category on screen.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS resource_links (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      url         TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'Links',
      description TEXT NOT NULL DEFAULT '',
      icon        TEXT NOT NULL DEFAULT '🔗',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by  TEXT NOT NULL DEFAULT ''
    )`);
  const { rows: rlc } = await pool.query('SELECT COUNT(*)::int AS n FROM resource_links');
  if (rlc[0].n === 0) {
    await pool.query(
      `INSERT INTO resource_links (name, url, category, description, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['ActionComply', 'https://actioncomply-production.up.railway.app/login',
       'Compliance & Training',
       'State-mandated and OSHA training, certificates of completion, and policy acknowledgements — kept current for every member of the team.',
       '🛡️', 10]);
    console.log('Schema: seeded 1 resource link (ActionComply).');
  }

  // Employee of the Month votes. period = award month 'YYYY-MM' (the month that
  // just ended); one vote per employee per period (UNIQUE).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eom_votes (
      id          SERIAL PRIMARY KEY,
      period      TEXT NOT NULL,
      voter_name  TEXT NOT NULL,
      choice_name TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (period, voter_name)
    )`);

  // Manager-picked Employee-of-the-Month winner override — used to break a tie or
  // correct a result. A row here means that name is THE winner for the period
  // regardless of raw vote count; no row = winner is the top vote-getter.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eom_winners (
      period      TEXT PRIMARY KEY,
      winner_name TEXT NOT NULL,
      set_by      TEXT NOT NULL DEFAULT '',
      ts          TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  // Per-feature roster flags on employees. These let a manager take someone out
  // of the closing-checklist rotation or out of Employee-of-the-Month voting
  // WITHOUT fully deactivating them (which would also pull them from the
  // leaderboard and block their login). Default true = behaves as before.
  // One-time, at the moment the checklist flag is first created: take Angel out
  // of the closing rotation (manager request). Done only here so a later manager
  // toggle in Manage → People is respected and not overwritten on the next boot.
  {
    const { rows: cce } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'checklist_eligible'`);
    if (!cce.length) {
      await pool.query(`ALTER TABLE employees ADD COLUMN checklist_eligible BOOLEAN NOT NULL DEFAULT true`);
      const r = await pool.query(`UPDATE employees SET checklist_eligible = false WHERE name ILIKE 'angel%'`);
      console.log(`Schema: added employees.checklist_eligible (removed ${r.rowCount} "Angel" from rotation).`);
    }
  }
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS voting_eligible BOOLEAN NOT NULL DEFAULT true`);

  // Cycle-based closing-checklist rotation: a shuffled order of eligible closers
  // for the current cycle, reshuffled once everyone has had a turn. Singleton row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checklist_rotation (
      id          INTEGER PRIMARY KEY,
      cycle_order INTEGER[] NOT NULL DEFAULT '{}',
      cycle_start DATE
    )`);
  await pool.query(`INSERT INTO checklist_rotation (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // Morning-meeting credit: someone taps "I led the morning meeting" on the TV,
  // enters their PIN → a pending row here; a manager approves it in the app,
  // which awards bubbles under the existing "Morning Meeting" rule.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meeting_credits (
      id            SERIAL PRIMARY KEY,
      employee_id   INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      employee_name TEXT NOT NULL DEFAULT '',
      meeting_date  DATE NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
      amount        INTEGER,
      requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at   TIMESTAMPTZ,
      resolved_by   TEXT
    )`);

  // One-time data migrations (guarded so a later manager change isn't reverted).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  {
    // Angel works the warehouse ~1 day/week → never does the closing checklist
    // AND doesn't vote for Employee of the Month. Applied once; a manager can
    // still re-enable either later in Manage → People.
    const done = await pool.query(`SELECT 1 FROM app_migrations WHERE name = 'angel_one_day_week'`);
    if (!done.rows.length) {
      const r = await pool.query(
        `UPDATE employees SET checklist_eligible = false, voting_eligible = false WHERE name ILIKE 'angel%'`);
      await pool.query(`INSERT INTO app_migrations (name) VALUES ('angel_one_day_week') ON CONFLICT DO NOTHING`);
      console.log(`Schema: Angel out of checklist + voting (${r.rowCount} matched).`);
    }
  }

  {
    // The Box Counter activity log shipped (v71) AFTER the first counts were
    // already entered, so it started blank. One-time: reconstruct the history
    // from box_sizes — the original inventory setup plus every count already
    // done (grouped by who + Pacific day) — so the log isn't empty.
    const done = await pool.query(`SELECT 1 FROM app_migrations WHERE name = 'box_activity_backfill_v1'`);
    if (!done.rows.length) {
      const { rows: counts } = await pool.query(`
        SELECT last_counted_by AS by, max(last_counted_at) AS at, count(*)::int AS n
          FROM box_sizes
         WHERE last_counted_at IS NOT NULL AND coalesce(last_counted_by, '') <> ''
         GROUP BY last_counted_by, to_char(last_counted_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')
         ORDER BY max(last_counted_at)`);
      if (counts.length) {
        const mainBy = counts[counts.length - 1].by;  // most recent counter set up the original inventory
        const { rows: o } = await pool.query(`SELECT min(created_at) AS at, count(*)::int AS n FROM box_sizes`);
        await pool.query(
          `INSERT INTO box_activity (ts, person, action, detail) VALUES ($1, $2, 'setup', $3)`,
          [o[0].at, mainBy, `Entered the starting box inventory (${o[0].n} box sizes)`]);
        for (const c of counts) {
          await pool.query(
            `INSERT INTO box_activity (ts, person, action, detail) VALUES ($1, $2, 'count', $3)`,
            [c.at, c.by, `Counted ${c.n} box size${c.n === 1 ? '' : 's'}`]);
        }
        console.log(`Schema: backfilled Box Counter activity (${counts.length + 1} entries).`);
      }
      await pool.query(`INSERT INTO app_migrations (name) VALUES ('box_activity_backfill_v1') ON CONFLICT DO NOTHING`);
    }
  }

  {
    // Reorder the closing checklist into the real closing flow + rename the
    // category headers to phase names. Matches existing tasks by a distinctive
    // word in the label (labels unchanged). Also re-syncs any NOT-yet-completed
    // run (incl. today's) so the new order shows immediately; completed history
    // keeps its original order. Guarded so a later manual edit isn't reverted.
    const done = await pool.query(`SELECT 1 FROM app_migrations WHERE name = 'checklist_phase_reorder_v1'`);
    if (!done.rows.length) {
      const reorder = [
        [10,  'Restock for Tomorrow', 'packing tape'],
        [20,  'Restock for Tomorrow', 'printer paper'],
        [30,  'Restock for Tomorrow', 'toner'],
        [40,  'Clean Up',             'Aisles'],
        [50,  'Clean Up',             'Trash and cardboard'],
        [60,  'Clean Up',             'wiped down'],
        [70,  'Park & Power Down',    'Forklifts'],
        [80,  'Park & Power Down',    'Scanners and handheld'],
        [90,  'Park & Power Down',    'Computers'],
        [100, 'Climate Off',          'fans'],
        [110, 'Climate Off',          'A/C'],
        [120, 'Climate Off',          'Heaters'],
        [130, 'Lock Up & Leave',      'gates'],
        [140, 'Lock Up & Leave',      'overhead'],
        [150, 'Lock Up & Leave',      'entry doors'],   // entry doors locked BEFORE lights…
        [160, 'Lock Up & Leave',      'LIGHTS'],        // …lights OFF is the last action
        [200, 'Before You Leave',     'tablet'],
      ];
      let n = 0;
      for (const [ord, cat, sub] of reorder) {
        const like = '%' + sub + '%';
        const t = await pool.query(
          'UPDATE checklist_tasks SET category = $1, sort_order = $2 WHERE label ILIKE $3', [cat, ord, like]);
        n += t.rowCount;
        await pool.query(
          `UPDATE checklist_items SET category = $1, sort_order = $2
             WHERE label ILIKE $3 AND run_id IN (SELECT id FROM checklist_runs WHERE status = 'pending')`,
          [cat, ord, like]);
      }
      await pool.query(`INSERT INTO app_migrations (name) VALUES ('checklist_phase_reorder_v1') ON CONFLICT DO NOTHING`);
      console.log(`Schema: reordered closing checklist into phases (${n} tasks matched).`);
    }
  }

  // Clean up any not-yet-completed runs that landed on a closed day (e.g. a
  // Sunday run created before this rule existed). Leaves completed history alone.
  if (closedDows().length) {
    await pool.query(
      `DELETE FROM checklist_runs WHERE status = 'pending' AND EXTRACT(DOW FROM run_date)::int = ANY($1)`,
      [closedDows()]);
  }

  // ----- Label Printer: print queue + bridge heartbeat -----
  // Employee devices enqueue a job (no per-device software); a small "print
  // bridge" on the warehouse PC polls, sends the ZPL to the ZQ620 over the LAN
  // (raw TCP 9100), and acks. Jobs wait here until the bridge picks them up.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id           SERIAL PRIMARY KEY,
      code         TEXT NOT NULL,
      qty          INTEGER NOT NULL DEFAULT 1,
      zpl          TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT,
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      printed_at   TIMESTAMPTZ
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS print_jobs_status_idx ON print_jobs(status, id)`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS batch_id TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_bridge (
      id        INTEGER PRIMARY KEY,
      last_seen TIMESTAMPTZ
    )`);
  await pool.query(`INSERT INTO print_bridge (id, last_seen) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING`);
  // The bridge auth token is generated here (NOT hard-coded — the repo is public)
  // and shown to a manager in the app to paste into the bridge script. No Railway
  // env var needed. (PRINT_BRIDGE_TOKEN env still works too, if ever set.)
  await pool.query(`ALTER TABLE print_bridge ADD COLUMN IF NOT EXISTS token TEXT`);
  {
    const { rows: br } = await pool.query('SELECT token FROM print_bridge WHERE id = 1');
    if (!br.length || !br[0].token) {
      await pool.query('UPDATE print_bridge SET token = $1 WHERE id = 1',
        [crypto.randomBytes(24).toString('hex')]);
    }
  }

  // Cloud printing (Zebra SendFileToPrinter) — credentials are entered by a manager
  // in the app (stored here, never in the public repo).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cloud_print (
      id         INTEGER PRIMARY KEY,
      api_key    TEXT,
      tenant_id  TEXT,
      serial     TEXT,
      enabled    BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ
    )`);
  await pool.query(`INSERT INTO cloud_print (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // Optional manager-set cap on cloud calls per day (NULL = no app cap; Zebra's
  // own free tier is 100/day). Stops printing once the cap is hit so a runaway
  // day can't rack up overage charges.
  await pool.query(`ALTER TABLE cloud_print ADD COLUMN IF NOT EXISTS daily_limit INTEGER`);

  // Multiple Zebra cloud printers (same Zebra account = shared api_key/tenant in
  // cloud_print; each printer differs only by serial). A device picks which one
  // to print to. Seeded once from the old single cloud_print.serial.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS printers (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      serial     TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  {
    const { rows: pc } = await pool.query('SELECT COUNT(*)::int AS n FROM printers');
    if (pc[0].n === 0) {
      const { rows: cp } = await pool.query("SELECT serial FROM cloud_print WHERE id = 1");
      const s = cp.length ? (cp[0].serial || '') : '';
      if (s) {
        await pool.query("INSERT INTO printers (name, serial, sort_order) VALUES ($1, $2, 10)", ['Printer 1', s]);
        console.log('Schema: seeded printers from existing cloud serial.');
      }
    }
  }

  // ----- Label part descriptions (real label text instead of PLACEHOLDER) -----
  // Loaded from the weekly Distribution One export (SKU,Description). The print
  // path looks up each scanned code here. A token (auto-generated) lets the
  // headless weekly job POST a fresh CSV with no user login.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS part_descriptions (
      code        TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT ''
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS part_desc_lower_idx ON part_descriptions (lower(code))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS part_meta (
      id          INTEGER PRIMARY KEY,
      token       TEXT,
      last_import TIMESTAMPTZ,
      count       INTEGER NOT NULL DEFAULT 0
    )`);
  await pool.query(`INSERT INTO part_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // Parts whose website photo is WRONG (doesn't match the D1 part) — a manager
  // hides them from the confirm card. Stored lowercased for case-insensitive match.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS photo_hidden (
      code   TEXT PRIMARY KEY,
      hidden_by TEXT,
      ts     TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Weekly auto-refresh: a Railway-side worker fetches this URL every Saturday
  // 2:37 AM (Pacific) and reloads the descriptions. last_auto guards against
  // double-runs / restarts. (Railway can't reach the on-prem ERP, so it pulls a
  // published CSV rather than querying Distribution One directly.)
  await pool.query(`ALTER TABLE part_meta ADD COLUMN IF NOT EXISTS source_url TEXT`);
  await pool.query(`ALTER TABLE part_meta ADD COLUMN IF NOT EXISTS last_auto DATE`);
  {
    const { rows: pm } = await pool.query('SELECT token FROM part_meta WHERE id = 1');
    if (!pm.length || !pm[0].token) {
      await pool.query('UPDATE part_meta SET token = $1 WHERE id = 1', [crypto.randomBytes(24).toString('hex')]);
    }
  }

  // ----- Push notifications (Web Push / VAPID) -----
  // The server's VAPID keypair is generated here on first boot and stored in the
  // DB (NOT hard-coded — the repo is public, and we want zero Railway env setup
  // for the handoff). Same pattern as the print-bridge token above.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_keys (
      id          INTEGER PRIMARY KEY,
      public_key  TEXT,
      private_key TEXT,
      subject     TEXT
    )`);
  // Master on/off switch for the whole notifications feature, flipped by a
  // manager in the app. Default OFF — the feature ships dormant (proof of
  // concept) until a manager turns it on.
  await pool.query(`ALTER TABLE push_keys ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false`);
  // Each device that opts in stores its push subscription here, tied to the
  // logged-in person so we can target reminders (e.g. the checklist assignee).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         SERIAL PRIMARY KEY,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      subscriber TEXT,
      role       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen  TIMESTAMPTZ
    )`);
  await ensureVapid();
}

// ---------- Manager-editable settings (cached in memory; refreshed on write) ----------
let SETTINGS = {};
async function loadSettings() {
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    const s = {}; rows.forEach(r => { s[r.key] = r.value; });
    SETTINGS = s;
  } catch (e) { console.warn('loadSettings failed:', e && e.message); }
}
function settingStr(key, fallback) {
  const v = SETTINGS[key];
  return (v != null && v !== '') ? v : fallback;
}
function settingJson(key, fallback) {
  try { return SETTINGS[key] ? JSON.parse(SETTINGS[key]) : fallback; } catch { return fallback; }
}
async function setSetting(key, value) {
  const v = value == null ? '' : String(value);
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, v]);
  SETTINGS[key] = v;
}
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TILE_KEYS = ['bubbles', 'checklist', 'boxcounter', 'eom', 'label', 'resources'];
// Derived settings with sensible defaults.
function closedDows() {
  const a = settingJson('closed_dows', [0, 6]);
  return Array.isArray(a) ? a.map(Number).filter(n => n >= 0 && n <= 6) : [0, 6];
}
function boxCountDow() {
  const n = parseInt(settingStr('box_count_dow', '5'), 10);
  return (n >= 0 && n <= 6) ? n : 5;
}
function alertEmail() { return settingStr('alert_email', MANAGER_EMAIL); }
// Closing-checklist deadline: the assignee must tap Start by this time or the run
// is flagged late (a manager can then apply the penalty). Editable in Settings.
function lateFlagOn() { return settingStr('late_flag_on', '1') !== '0'; }
function checklistDeadline() { const d = settingStr('checklist_deadline', '16:45'); return /^\d{1,2}:\d{2}$/.test(d) ? d : '16:45'; }
function latePenalty() { const n = parseInt(settingStr('checklist_late_penalty', '10'), 10); return (n >= 0) ? n : 10; }
function deadlineLabel() {
  const [h, m] = checklistDeadline().split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM'; const h12 = ((h + 11) % 12) + 1;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
// The owner-set PIN works as the manager PIN; the env PIN always works too as a
// permanent admin recovery (staff never knew it, so it's invisible to them).
function managerPinMatches(p) {
  const s = String(p == null ? '' : p);
  const db = settingStr('manager_pin', '');
  if (db && s === db) return true;
  return s === String(MANAGER_PIN);
}
function tilesConfig() {
  const saved = settingJson('tiles', {});
  const cfg = {};
  TILE_KEYS.forEach(k => { cfg[k] = saved[k] !== false; });   // on unless explicitly turned off
  return cfg;
}

// Manager saves the Settings screen. Every field is optional — only provided
// ones change. Manager-only.
async function updateSettings(who, body) {
  if (!isManager(who)) return { error: 'Manager only' };
  const s = (body && body.settings) || {};
  if (typeof s.managerPin === 'string' && s.managerPin.trim() !== '') {
    const pin = cleanPin(s.managerPin);
    if (!pin) return { error: 'Manager PIN must be 4–6 digits.' };
    const { rows } = await pool.query('SELECT 1 FROM employees WHERE pin = $1 AND active = true LIMIT 1', [pin]);
    if (rows.length) return { error: 'That PIN is already used by an employee.' };
    await setSetting('manager_pin', pin);
  }
  if (typeof s.alertEmail === 'string') {
    const em = normalizeEmail(s.alertEmail);
    if (em && !validEmail(em)) return { error: 'Enter a valid alert email (or leave it blank).' };
    await setSetting('alert_email', em);
  }
  if (Array.isArray(s.closedDows)) {
    const arr = [...new Set(s.closedDows.map(Number).filter(n => n >= 0 && n <= 6))].sort();
    await setSetting('closed_dows', JSON.stringify(arr));
  }
  if (s.boxCountDow != null) {
    const n = parseInt(s.boxCountDow, 10);
    if (!(n >= 0 && n <= 6)) return { error: 'Pick a valid box-count day.' };
    await setSetting('box_count_dow', String(n));
  }
  if (s.lateFlagOn != null) {
    await setSetting('late_flag_on', s.lateFlagOn ? '1' : '0');
  }
  if (typeof s.checklistDeadline === 'string' && s.checklistDeadline.trim() !== '') {
    const d = s.checklistDeadline.trim();
    const m = /^(\d{1,2}):(\d{2})$/.exec(d);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { error: 'Deadline must be a valid time like 16:45.' };
    await setSetting('checklist_deadline', d);
  }
  if (s.checklistLatePenalty != null) {
    const n = parseInt(s.checklistLatePenalty, 10);
    if (!(n >= 0)) return { error: 'Penalty must be 0 or more.' };
    await setSetting('checklist_late_penalty', String(n));
  }
  if (s.tiles && typeof s.tiles === 'object') {
    const cur = settingJson('tiles', {});
    TILE_KEYS.forEach(k => { if (k in s.tiles) cur[k] = !!s.tiles[k]; });
    await setSetting('tiles', JSON.stringify(cur));
  }
  return { ok: true };
}

// =================================================================
// Helpers
// =================================================================

// Parse a whole number (allowing negatives). Returns null if not an integer.
function cleanInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const s = String(v == null ? '' : v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

// Validate a 4–6 digit PIN string. Returns the clean string or null.
function cleanPin(v) {
  const p = String(v == null ? '' : v).trim();
  return /^\d{4,6}$/.test(p) ? p : null;
}

// ---------- Admin password + session helpers ----------

const SESSION_DAYS = 30;        // how long an admin stays signed in
const MIN_PASSWORD = 8;         // minimum admin password length

function normalizeEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

// Hash a password with a per-user random salt (scrypt). Returns {salt, hash}.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return { salt, hash };
}

// Constant-time verify of a password against a stored salt+hash.
function verifyPassword(pw, salt, hash) {
  try {
    const calc = crypto.scryptSync(String(pw), salt, 64);
    const stored = Buffer.from(String(hash), 'hex');
    return calc.length === stored.length && crypto.timingSafeEqual(calc, stored);
  } catch {
    return false;
  }
}

function newSessionToken() { return crypto.randomUUID() + crypto.randomBytes(16).toString('hex'); }

// Create a login session for an admin and return its token.
async function createSession(adminId) {
  const token = newSessionToken();
  await pool.query(
    `INSERT INTO admin_sessions (token, admin_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, adminId, String(SESSION_DAYS)]
  );
  return token;
}

// Resolve a session token to an active admin, or null. Also drops stale rows.
async function adminForToken(token) {
  const t = String(token == null ? '' : token).trim();
  if (!t) return null;
  const { rows } = await pool.query(
    `SELECT a.id, a.name
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token = $1 AND s.expires_at > now() AND a.active = true
      LIMIT 1`,
    [t]
  );
  return rows.length ? { id: rows[0].id, name: rows[0].name } : null;
}

// Unified auth for every action. Prefers an admin session token; falls back to
// the PIN path (employee, or the break-glass MANAGER_PIN). Returns an identity
// { role, name, adminId? } or null.
async function resolveAuth(body) {
  const admin = await adminForToken(body && body.token);
  if (admin) return { role: 'manager', name: admin.name, adminId: admin.id };
  return roleForPin(body && body.pin);
}

function isManager(who) { return !!(who && who.role === 'manager'); }

async function roleForPin(pin) {
  const p = String(pin == null ? '' : pin).trim();
  if (!p) return null;
  if (managerPinMatches(p)) return { role: 'manager', name: 'Manager' };
  const { rows } = await pool.query(
    'SELECT name FROM employees WHERE pin = $1 AND active = true LIMIT 1',
    [p]
  );
  return rows.length ? { role: 'employee', name: rows[0].name } : null;
}

async function balanceFor(name) {
  const { rows } = await pool.query('SELECT balance FROM balances WHERE name = $1', [name]);
  return rows.length ? Number(rows[0].balance) : 0;
}

async function emailFor(name) {
  const { rows } = await pool.query('SELECT email FROM employees WHERE name = $1', [name]);
  return rows.length ? (rows[0].email || '') : '';
}

async function sendResend(to, subject, body) {
  if (!RESEND_API_KEY || !to) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Action Spa Parts Bubbles <onboarding@resend.dev>',
        to: [to],
        subject,
        text: body,
      }),
    });
    if (!r.ok) console.warn('Resend error:', r.status, await r.text());
  } catch (e) {
    console.warn('Resend exception:', e);
  }
}

// Gmail SMTP (app password). Used for the Box Counter low-stock alert so it can
// send without any domain/DNS setup. No-op unless GMAIL_USER + GMAIL_APP_PASSWORD are set.
let gmailTransport = null;
function getGmailTransport() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return gmailTransport;
}
async function sendGmail(to, subject, body) {
  const t = getGmailTransport();
  if (!t || !to) { console.log(`[gmail skipped — not configured] ${subject}`); return; }
  try {
    await t.sendMail({ from: `Action Spa Warehouse <${GMAIL_USER}>`, to, subject, text: body });
  } catch (e) {
    console.warn('Gmail send error:', e && e.message);
  }
}

async function notifyEmployee(name, subject, body) {
  const to = await emailFor(name);
  if (to) await sendResend(to, subject, body);
  else console.log(`[email skipped — no address for ${name}] ${subject}`);
}

async function notifyManager(subject, body) {
  const to = alertEmail();
  if (to) await sendResend(to, subject, body);
  else console.log(`[manager email skipped — no alert email set] ${subject}`);
}

function awardEmailBody(name, metric, amount, bal) {
  const n = Math.abs(amount);
  const plural = n === 1 ? '' : 's';
  const forMetric = metric ? ` for: ${metric}` : '';
  if (amount >= 0) {
    return {
      subject: `You earned ${n} bubble${plural}!`,
      body: `Hi ${name},\n\nYou just earned ${n} bubble${plural}${forMetric}.\nYour balance is now ${bal} bubbles.\n\n— Action Spa Parts`,
    };
  }
  return {
    subject: 'Bubbles deducted',
    body: `Hi ${name},\n\n${n} bubble${plural} were deducted${forMetric}.\nYour balance is now ${bal} bubbles.\n\n— Action Spa Parts`,
  };
}

// =================================================================
// Action handlers
// =================================================================

async function login(pin) {
  const r = await roleForPin(pin);
  return r || { error: 'Invalid PIN' };
}

async function getData(who) {
  if (!who) return { error: 'Not authorized' };
  const isManager = who.role === 'manager';

  // Run all reads in parallel for speed.
  const [balances, rules, rewards, myTx, myReq, pending, approved, allAwards] = await Promise.all([
    pool.query(`
      SELECT name AS "Name", balance AS "Balance",
             starting_balance AS "Starting", earned AS "Earned"
        FROM balances
       WHERE active = true
       ORDER BY name`),
    pool.query(`
      SELECT metric AS "Metric", bubbles AS "Bubbles",
             category AS "Category", description AS "Description",
             team_wide AS "TeamWide"
        FROM rules WHERE active = true ORDER BY id`),
    pool.query(`
      SELECT name AS "Reward", cost AS "Cost", description AS "Description"
        FROM rewards WHERE active = true ORDER BY id`),
    pool.query(`
      SELECT a.created_at AS "Timestamp", e.name AS "Name",
             a.metric AS "Metric", a.amount AS "Amount", a.awarded_by AS "By"
        FROM awards a JOIN employees e ON e.id = a.employee_id
       WHERE e.name = $1
       ORDER BY a.created_at DESC
       LIMIT 100`, [who.name]),
    pool.query(`
      SELECT r.id AS "_row", e.name AS "Name", r.reward_name AS "Reward",
             r.cost AS "Cost", r.status AS "Status"
        FROM redemptions r JOIN employees e ON e.id = r.employee_id
       WHERE e.name = $1
       ORDER BY r.created_at DESC
       LIMIT 15`, [who.name]),
    isManager
      ? pool.query(`
          SELECT r.id AS "_row", e.name AS "Name", r.reward_name AS "Reward",
                 r.cost AS "Cost", r.status AS "Status"
            FROM redemptions r JOIN employees e ON e.id = r.employee_id
           WHERE r.status = 'pending'
           ORDER BY r.created_at`)
      : Promise.resolve({ rows: [] }),
    isManager
      ? pool.query(`
          SELECT r.id AS "_row", e.name AS "Name", r.reward_name AS "Reward",
                 r.cost AS "Cost", r.status AS "Status"
            FROM redemptions r JOIN employees e ON e.id = r.employee_id
           WHERE r.status = 'approved'
           ORDER BY r.created_at`)
      : Promise.resolve({ rows: [] }),
    // Team activity feed — returned to EVERYONE now (employees see an
    // "Everyone else" section in Activity). This is the same non-sensitive data
    // already shown on the public /tv display. Only managers render delete
    // buttons (and deleteAward is manager-gated server-side).
    pool.query(`
      SELECT a.id AS "Id", a.created_at AS "Timestamp", e.name AS "Name",
             a.metric AS "Metric", a.amount AS "Amount", a.awarded_by AS "By"
        FROM awards a JOIN employees e ON e.id = a.employee_id
       ORDER BY a.created_at DESC
       LIMIT 500`),
  ]);

  const checklist = await checklistSummary(who);

  const meetingPending = isManager
    ? (await pool.query(
        `SELECT id AS "_row", employee_name AS "Name", to_char(meeting_date, 'YYYY-MM-DD') AS "Date"
           FROM meeting_credits WHERE status = 'pending' ORDER BY requested_at`)).rows
    : [];

  const meetingCreditAmount = isManager ? (await morningMeetingRule()).amount : null;

  // Open (unresolved) checklist flags — surfaced to the manager as notifications.
  const checklistFlags = isManager
    ? (await pool.query(
        `SELECT ci.id AS "itemId", ci.run_id AS "runId", ci.label AS "Label",
                ci.flag_note AS "Note", ci.flagged_by AS "By",
                to_char(r.run_date, 'YYYY-MM-DD') AS "Date", e.name AS "Assignee"
           FROM checklist_items ci
           JOIN checklist_runs r ON r.id = ci.run_id
           LEFT JOIN employees e ON e.id = r.employee_id
          WHERE ci.flagged = true
          ORDER BY r.run_date DESC, ci.sort_order LIMIT 50`)).rows
    : [];

  return {
    role: who.role,
    name: who.name,
    balances: balances.rows,
    rules: rules.rows,
    rewards: rewards.rows,
    myTransactions: myTx.rows,
    myRequests: myReq.rows,
    pending: pending.rows,
    approved: approved.rows,
    meetingPending,
    meetingCreditAmount,
    checklistFlags,
    allAwards: allAwards.rows,
    checklist,
    checklistPenalty: latePenalty(),
    lateFlagOn: lateFlagOn(),
    deadlineLabel: deadlineLabel(),
    tiles: tilesConfig(),
    settings: isManager ? {
      alertEmail: settingStr('alert_email', ''),
      closedDows: closedDows(),
      boxCountDow: boxCountDow(),
      managerPinSet: !!settingStr('manager_pin', ''),
      lateFlagOn: lateFlagOn(),
      checklistDeadline: checklistDeadline(),
      checklistLatePenalty: latePenalty(),
    } : null,
    version: APP_VERSION,
  };
}

// Public, no-PIN read for the always-on warehouse TV display (/tv).
// Returns ONLY non-sensitive data: the leaderboard, the earn rules, and the
// recent team activity feed. No emails, no PINs, no reward/redeem details.
async function getPublic() {
  const [balances, rules, activity] = await Promise.all([
    pool.query(`
      SELECT name AS "Name", balance AS "Balance"
        FROM balances
       WHERE active = true
       ORDER BY name`),
    pool.query(`
      SELECT metric AS "Metric", bubbles AS "Bubbles",
             category AS "Category", description AS "Description"
        FROM rules WHERE active = true ORDER BY id`),
    pool.query(`
      SELECT a.created_at AS "Timestamp", e.name AS "Name",
             a.metric AS "Metric", a.amount AS "Amount", a.awarded_by AS "By"
        FROM awards a JOIN employees e ON e.id = a.employee_id
       ORDER BY a.created_at DESC
       LIMIT 100`),
  ]);

  // Read-only checklist snapshot for the TV (no flag details — keep it non-shaming).
  const today = await todayStr();
  const run = await ensureTodayRun();
  const checklist = { today, assignee: null, status: null, total: 0, checked: 0, items: [], history: [] };
  if (run) {
    checklist.assignee = await nameForEmpId(run.employee_id);
    checklist.status = run.status;
    const { rows: items } = await pool.query(
      `SELECT category, label, checked FROM checklist_items WHERE run_id = $1 ORDER BY sort_order, id`, [run.id]);
    checklist.items = items;
    checklist.total = items.length;
    checklist.checked = items.filter(i => i.checked).length;
  }
  const { rows: hist } = await pool.query(`
    SELECT to_char(r.run_date, 'YYYY-MM-DD') AS run_date, r.status, e.name AS assignee,
           (SELECT COUNT(*)::int FROM checklist_items ci WHERE ci.run_id = r.id) AS total,
           (SELECT COUNT(*)::int FROM checklist_items ci WHERE ci.run_id = r.id AND ci.checked) AS checked
      FROM checklist_runs r LEFT JOIN employees e ON e.id = r.employee_id
     ORDER BY r.run_date DESC LIMIT 7`);
  checklist.history = hist;

  // Box Counter sizes + quantities (read-only for the TV).
  const { rows: boxSizes } = await pool.query(
    `SELECT size, quantity, low_threshold AS "lowThreshold"
       FROM box_sizes WHERE active = true ORDER BY sort_order, id`);

  // Imported Resources (curated links) — read-only for the TV wall display.
  const { rows: resources } = await pool.query(
    `SELECT name, url, category, description, icon
       FROM resource_links WHERE active = true ORDER BY sort_order, id`);

  return {
    balances: balances.rows,
    rules: rules.rows,
    activity: activity.rows,
    checklist,
    boxSizes,
    resources,
    tiles: tilesConfig(),
    checklistPenalty: latePenalty(),
    lateFlagOn: lateFlagOn(),
    deadlineLabel: deadlineLabel(),
    version: APP_VERSION,
  };
}

async function awardBubbles(who, name, metric, amount) {
  if (!isManager(who)) return { error: 'Invalid manager PIN' };
  if (!name || typeof amount !== 'number') return { error: 'Missing name or amount' };

  const { rows } = await pool.query('SELECT id FROM employees WHERE name = $1', [name]);
  if (!rows.length) return { error: 'Unknown employee: ' + name };

  await pool.query(
    'INSERT INTO awards (employee_id, metric, amount, awarded_by) VALUES ($1, $2, $3, $4)',
    [rows[0].id, metric || '', amount, who.name]
  );

  const bal = await balanceFor(name);
  const m = awardEmailBody(name, metric, amount, bal);
  await notifyEmployee(name, m.subject, m.body);

  const n = Math.abs(amount);
  const plural = n === 1 ? '' : 's';
  const verb = amount >= 0 ? 'awarded' : 'deducted';
  const dir  = amount >= 0 ? 'to' : 'from';
  const forMetric = metric ? ` for: ${metric}` : '';
  await notifyManager(
    `${verb[0].toUpperCase() + verb.slice(1)} ${n} bubble${plural} ${dir} ${name}`,
    `You ${verb} ${n} bubble${plural} ${dir} ${name}${forMetric}.\n${name}'s balance is now ${bal} bubbles.\n\n— Action Spa Parts`
  );

  return { ok: true };
}

async function awardTeam(who, metric, amount) {
  if (!isManager(who)) return { error: 'Invalid manager PIN' };
  if (typeof amount !== 'number') return { error: 'Missing amount' };

  // One INSERT writes a row per active employee.
  const ins = await pool.query(
    `INSERT INTO awards (employee_id, metric, amount, awarded_by, note)
     SELECT id, $1, $2, $3, 'Whole-team award'
       FROM employees WHERE active = true
     RETURNING employee_id`,
    [metric || '', amount, who.name]
  );

  const { rows: emps } = await pool.query(
    `SELECT name FROM employees WHERE active = true ORDER BY name`
  );

  // One balances query, then email each
  const { rows: balRows } = await pool.query('SELECT name, balance FROM balances');
  const balMap = {};
  balRows.forEach(b => { balMap[b.name] = Number(b.balance); });

  for (const e of emps) {
    const m = awardEmailBody(e.name, metric, amount, balMap[e.name] != null ? balMap[e.name] : 0);
    await notifyEmployee(e.name, m.subject, m.body);
  }

  const sign = amount > 0 ? '+' : '';
  const forMetric = metric ? ` for: ${metric}` : '';
  await notifyManager(
    `Awarded ${sign}${amount} to the whole team`,
    `You awarded ${sign}${amount} bubbles to all ${emps.length} employees${forMetric}.\n\n— Action Spa Parts`
  );

  return { ok: true, count: ins.rowCount };
}

async function reverseAward(who, name, metric, amount) {
  if (!isManager(who)) return { error: 'Invalid manager PIN' };
  if (!name || typeof amount !== 'number') return { error: 'Missing name or amount' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: emp } = await client.query('SELECT id FROM employees WHERE name = $1', [name]);
    if (!emp.length) { await client.query('ROLLBACK'); return { error: 'Unknown employee' }; }
    const employeeId = emp[0].id;

    // Find the most-recent matching original that isn't already flagged.
    const { rows: orig } = await client.query(
      `SELECT id FROM awards
        WHERE employee_id = $1 AND metric = $2 AND amount = $3 AND reversed_by_id IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [employeeId, metric || '', amount]
    );

    // Insert the reversal row.
    const { rows: rev } = await client.query(
      `INSERT INTO awards (employee_id, metric, amount, awarded_by, note)
       VALUES ($1, $2, $3, $4, 'Reversal')
       RETURNING id`,
      [employeeId, 'Undo: ' + (metric || ''), -amount, who.name]
    );
    const reversalId = rev[0].id;

    if (orig.length) {
      await client.query(
        `UPDATE awards SET reversed_by_id = $1, note = 'Reversed' WHERE id = $2`,
        [reversalId, orig[0].id]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const bal = await balanceFor(name);
  const sign = amount > 0 ? '+' : '';
  await notifyManager(
    `Reversed ${sign}${amount} (${metric}) for ${name}`,
    `You undid an award: ${metric} (${sign}${amount}) for ${name}.\n${name}'s balance is now ${bal} bubbles.\n\n— Action Spa Parts`
  );

  return { ok: true };
}

// Permanently delete a ledger entry (manager only). Pair-aware: deleting an
// award that was undone (or deleting the undo itself) removes BOTH rows, so an
// accidental credit-then-undo disappears cleanly. Deleting a standalone entry
// adjusts the balance accordingly (it's as if it never happened).
async function deleteAward(who, id) {
  if (!isManager(who)) return { error: 'Manager only' };
  const aid = cleanInt(id);
  if (aid === null) return { error: 'Bad entry id' };
  const { rows } = await pool.query('SELECT reversed_by_id FROM awards WHERE id = $1', [aid]);
  if (!rows.length) return { error: 'Entry not found' };
  const ids = [aid];
  if (rows[0].reversed_by_id != null) ids.push(rows[0].reversed_by_id);   // this row was undone → also drop its undo
  const { rows: rev } = await pool.query('SELECT id FROM awards WHERE reversed_by_id = $1', [aid]);
  rev.forEach(r => ids.push(r.id));                                       // this row IS an undo → also drop the original
  const del = await pool.query('DELETE FROM awards WHERE id = ANY($1)', [ids]);
  return { ok: true, deleted: del.rowCount };
}

async function requestRedemption(who, rewardName) {
  if (!who) return { error: 'Not authorized' };
  if (who.role !== 'employee') return { error: 'Only employees can redeem' };

  const { rows: rew } = await pool.query(
    'SELECT id, name, cost FROM rewards WHERE name = $1 AND active = true LIMIT 1',
    [rewardName]
  );
  if (!rew.length) return { error: 'Unknown reward' };
  const reward = rew[0];

  const bal = await balanceFor(who.name);
  if (bal < reward.cost) return { error: 'Not enough bubbles' };

  const { rows: emp } = await pool.query('SELECT id FROM employees WHERE name = $1', [who.name]);

  await pool.query(
    `INSERT INTO redemptions (employee_id, reward_id, reward_name, cost)
     VALUES ($1, $2, $3, $4)`,
    [emp[0].id, reward.id, reward.name, reward.cost]
  );

  await notifyManager(
    `New redemption request: ${reward.name}`,
    `${who.name} has requested "${reward.name}" (${reward.cost} bubbles).\nOpen the app to approve or deny.\n\n— Action Spa Parts`
  );

  return { ok: true };
}

async function resolveRedemption(who, redemptionId, approve) {
  if (!isManager(who)) return { error: 'Manager only' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT r.id, r.cost, r.reward_name, r.status, r.employee_id, e.name AS employee_name
         FROM redemptions r JOIN employees e ON e.id = r.employee_id
        WHERE r.id = $1 FOR UPDATE`,
      [Number(redemptionId)]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return { error: 'Bad row' }; }
    if (rows[0].status !== 'pending') { await client.query('ROLLBACK'); return { error: 'Already resolved' }; }
    const r = rows[0];

    if (approve) {
      const { rows: balRows } = await client.query('SELECT balance FROM balances WHERE name = $1', [r.employee_name]);
      const bal = Number(balRows[0].balance);
      if (bal < r.cost) {
        await client.query(`UPDATE redemptions SET status = 'denied', resolved_at = now() WHERE id = $1`, [r.id]);
        await client.query('COMMIT');
        await notifyEmployee(r.employee_name, `Redemption update: ${r.reward_name}`,
          `Hi ${r.employee_name},\n\nYour request for "${r.reward_name}" could not be approved — your balance dropped below the cost. Your balance is unchanged.\n\n— Action Spa Parts`);
        return { error: 'Insufficient balance — auto-denied' };
      }
      await client.query(
        `INSERT INTO awards (employee_id, metric, amount, awarded_by, note)
         VALUES ($1, $2, $3, $4, 'Redemption')`,
        [r.employee_id, 'Redeemed: ' + r.reward_name, -r.cost, who.name]
      );
      await client.query(
        `UPDATE redemptions SET status = 'approved', resolved_at = now(), approved_by = $2 WHERE id = $1`,
        [r.id, who.name]
      );
      await client.query('COMMIT');
      const newBal = await balanceFor(r.employee_name);
      await notifyEmployee(r.employee_name, `Redemption approved: ${r.reward_name}`,
        `Hi ${r.employee_name},\n\nYour request for "${r.reward_name}" (${r.cost} bubbles) was approved!\nYour balance is now ${newBal} bubbles.\n\n— Action Spa Parts`);
    } else {
      await client.query(`UPDATE redemptions SET status = 'denied', resolved_at = now() WHERE id = $1`, [r.id]);
      await client.query('COMMIT');
      await notifyEmployee(r.employee_name, `Redemption update: ${r.reward_name}`,
        `Hi ${r.employee_name},\n\nYour request for "${r.reward_name}" was not approved this time. Your balance is unchanged.\n\n— Action Spa Parts`);
    }
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function fulfillRedemption(who, redemptionId) {
  if (!isManager(who)) return { error: 'Manager only' };

  const { rows } = await pool.query(
    `UPDATE redemptions SET status = 'fulfilled', resolved_at = now()
      WHERE id = $1 AND status = 'approved'
      RETURNING (SELECT name FROM employees WHERE id = employee_id) AS employee_name, reward_name`,
    [Number(redemptionId)]
  );
  if (!rows.length) return { error: 'Not awaiting fulfillment' };
  const { employee_name, reward_name } = rows[0];

  await notifyEmployee(employee_name, `Reward delivered: ${reward_name}`,
    `Hi ${employee_name},\n\nYour reward "${reward_name}" has been handed out. Enjoy!\n\n— Action Spa Parts`);

  return { ok: true };
}

// The "Morning Meeting" earn rule (amount + exact label). Falls back to +5 /
// "Morning Meeting" if a manager hasn't set one up.
async function morningMeetingRule() {
  const { rows } = await pool.query(
    `SELECT metric, bubbles FROM rules
      WHERE active = true AND metric ILIKE '%morning meeting%' ORDER BY id LIMIT 1`);
  if (rows.length) return { metric: rows[0].metric, amount: Number(rows[0].bubbles) };
  return { metric: 'Morning Meeting', amount: 5 };
}

// Someone taps "I led the morning meeting" on the TV and enters their PIN.
// Creates a pending credit for a manager to approve. One claim per person/day.
async function requestMeetingCredit(who) {
  if (!who || who.role !== 'employee') return { error: 'Enter your personal PIN to claim the credit.' };
  const { rows: emp } = await pool.query('SELECT id FROM employees WHERE name = $1 AND active = true', [who.name]);
  if (!emp.length) return { error: 'Employee not found.' };
  const empId = emp[0].id;
  const today = (await pool.query(`SELECT to_char(${BIZ_DATE}, 'YYYY-MM-DD') AS d`)).rows[0].d;
  const dup = await pool.query(
    `SELECT 1 FROM meeting_credits WHERE employee_id = $1 AND meeting_date = $2 AND status IN ('pending','approved')`,
    [empId, today]);
  if (dup.rows.length) return { error: "You've already claimed the morning meeting today." };
  await pool.query(
    `INSERT INTO meeting_credits (employee_id, employee_name, meeting_date) VALUES ($1, $2, $3)`,
    [empId, who.name, today]);
  await notifyManager(
    'Morning meeting credit to approve',
    `${who.name} says they led the morning meeting today.\nOpen the app to approve or deny it.\n\n— Action Spa Parts`);
  return { ok: true };
}

// Manager approves/denies a pending morning-meeting credit. Approve → award the
// Morning Meeting rule's bubbles under that metric.
async function resolveMeetingCredit(who, id, approve) {
  if (!isManager(who)) return { error: 'Manager only' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, employee_id, employee_name, status FROM meeting_credits WHERE id = $1 FOR UPDATE`,
      [Number(id)]);
    if (!rows.length) { await client.query('ROLLBACK'); return { error: 'Bad row' }; }
    if (rows[0].status !== 'pending') { await client.query('ROLLBACK'); return { error: 'Already resolved' }; }
    const r = rows[0];
    if (approve) {
      const rule = await morningMeetingRule();
      await client.query(
        `INSERT INTO awards (employee_id, metric, amount, awarded_by, note)
         VALUES ($1, $2, $3, $4, 'Morning meeting (approved)')`,
        [r.employee_id, rule.metric, rule.amount, who.name]);
      await client.query(
        `UPDATE meeting_credits SET status = 'approved', amount = $2, resolved_at = now(), resolved_by = $3 WHERE id = $1`,
        [r.id, rule.amount, who.name]);
      await client.query('COMMIT');
      const bal = await balanceFor(r.employee_name);
      await notifyEmployee(r.employee_name, `You earned ${rule.amount} bubbles!`,
        `Hi ${r.employee_name},\n\nYour morning-meeting credit was approved — ${rule.amount} bubbles for leading it.\nYour balance is now ${bal} bubbles.\n\n— Action Spa Parts`);
    } else {
      await client.query(
        `UPDATE meeting_credits SET status = 'denied', resolved_at = now(), resolved_by = $2 WHERE id = $1`,
        [r.id, who.name]);
      await client.query('COMMIT');
    }
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// =================================================================
// Admin: manage rules, rewards, employees (manager only)
// =================================================================

// Full lists for the manager admin screens, including INACTIVE rows so the
// manager can turn things back on. Includes employee PINs (the manager needs
// them to onboard/remind staff).
async function getAdmin(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  const [rules, rewards, employees, checklistTasks] = await Promise.all([
    pool.query(`
      SELECT id, metric, bubbles, category, description,
             team_wide AS "teamWide", active
        FROM rules ORDER BY active DESC, id`),
    pool.query(`
      SELECT id, name, cost, description, active
        FROM rewards ORDER BY active DESC, id`),
    pool.query(`
      SELECT e.id, e.name, e.pin, e.email,
             e.starting_balance AS "startingBalance", e.active,
             e.checklist_eligible AS "checklistEligible",
             e.voting_eligible AS "votingEligible", b.balance
        FROM employees e JOIN balances b ON b.id = e.id
       ORDER BY e.active DESC, e.name`),
    pool.query(`
      SELECT id, category, label, sort_order AS "sortOrder", active
        FROM checklist_tasks ORDER BY active DESC, sort_order, id`),
  ]);
  return {
    rules: rules.rows, rewards: rewards.rows, employees: employees.rows,
    checklistTasks: checklistTasks.rows,
  };
}

// ---------- Rules ----------

async function addRule(who, r) {
  if (!isManager(who)) return { error: 'Manager only' };
  r = r || {};
  const metric = String(r.metric || '').trim();
  const bubbles = cleanInt(r.bubbles);
  if (!metric) return { error: 'Name is required' };
  if (bubbles === null) return { error: 'Bubbles must be a whole number (can be negative)' };
  await pool.query(
    `INSERT INTO rules (metric, bubbles, category, description, team_wide, active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [metric, bubbles, String(r.category || 'Other').trim() || 'Other',
     String(r.description || '').trim(), !!r.teamWide]
  );
  return { ok: true };
}

async function updateRule(who, r) {
  if (!isManager(who)) return { error: 'Manager only' };
  r = r || {};
  const id = cleanInt(r.id);
  const metric = String(r.metric || '').trim();
  const bubbles = cleanInt(r.bubbles);
  if (id === null) return { error: 'Bad rule id' };
  if (!metric) return { error: 'Name is required' };
  if (bubbles === null) return { error: 'Bubbles must be a whole number (can be negative)' };
  const { rowCount } = await pool.query(
    `UPDATE rules SET metric=$1, bubbles=$2, category=$3, description=$4, team_wide=$5 WHERE id=$6`,
    [metric, bubbles, String(r.category || 'Other').trim() || 'Other',
     String(r.description || '').trim(), !!r.teamWide, id]
  );
  if (!rowCount) return { error: 'Rule not found' };
  return { ok: true };
}

async function setRuleActive(who, id, active) {
  if (!isManager(who)) return { error: 'Manager only' };
  const rid = cleanInt(id);
  if (rid === null) return { error: 'Bad rule id' };
  await pool.query(`UPDATE rules SET active=$1 WHERE id=$2`, [!!active, rid]);
  return { ok: true };
}

// Permanently delete an earn rule. Awards store the metric as plain text (not a
// link to rules), so past awards are unaffected. Manager only.
async function deleteRule(who, id) {
  if (!isManager(who)) return { error: 'Manager only' };
  const rid = cleanInt(id);
  if (rid === null) return { error: 'Bad rule id' };
  const { rowCount } = await pool.query('DELETE FROM rules WHERE id = $1', [rid]);
  if (!rowCount) return { error: 'Rule not found' };
  return { ok: true };
}

// ---------- Rewards ----------

async function addReward(who, r) {
  if (!isManager(who)) return { error: 'Manager only' };
  r = r || {};
  const name = String(r.name || '').trim();
  const cost = cleanInt(r.cost);
  if (!name) return { error: 'Name is required' };
  if (cost === null || cost <= 0) return { error: 'Cost must be a positive whole number' };
  await pool.query(
    `INSERT INTO rewards (name, cost, description, active) VALUES ($1, $2, $3, true)`,
    [name, cost, String(r.description || '').trim()]
  );
  return { ok: true };
}

async function updateReward(who, r) {
  if (!isManager(who)) return { error: 'Manager only' };
  r = r || {};
  const id = cleanInt(r.id);
  const name = String(r.name || '').trim();
  const cost = cleanInt(r.cost);
  if (id === null) return { error: 'Bad reward id' };
  if (!name) return { error: 'Name is required' };
  if (cost === null || cost <= 0) return { error: 'Cost must be a positive whole number' };
  const { rowCount } = await pool.query(
    `UPDATE rewards SET name=$1, cost=$2, description=$3 WHERE id=$4`,
    [name, cost, String(r.description || '').trim(), id]
  );
  if (!rowCount) return { error: 'Reward not found' };
  return { ok: true };
}

async function setRewardActive(who, id, active) {
  if (!isManager(who)) return { error: 'Manager only' };
  const rid = cleanInt(id);
  if (rid === null) return { error: 'Bad reward id' };
  await pool.query(`UPDATE rewards SET active=$1 WHERE id=$2`, [!!active, rid]);
  return { ok: true };
}

// Permanently delete a reward (e.g. an accidental duplicate). Refuses if it has
// redemption history — the manager should turn it off instead to keep the record.
async function deleteReward(who, id) {
  if (!isManager(who)) return { error: 'Manager only' };
  const rid = cleanInt(id);
  if (rid === null) return { error: 'Bad reward id' };
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM redemptions WHERE reward_id = $1', [rid]);
  if (rows[0].n > 0) return { error: 'This reward has redemption history — turn it off instead of deleting.' };
  await pool.query('DELETE FROM rewards WHERE id = $1', [rid]);
  return { ok: true };
}

// ---------- Employees ----------

async function addEmployee(who, e) {
  if (!isManager(who)) return { error: 'Manager only' };
  e = e || {};
  const name = String(e.name || '').trim();
  if (!name) return { error: 'Name is required' };
  const startingBalance = cleanInt(e.startingBalance);
  if (startingBalance === null) return { error: 'Starting balance must be a whole number' };
  const email = String(e.email || '').trim();

  // PIN is optional at creation (a worker can be added before they get one),
  // but if given it must be valid, not the manager PIN, and unique.
  const rawPin = String(e.pin == null ? '' : e.pin).trim();
  let newPin = null;
  if (rawPin) {
    newPin = cleanPin(rawPin);
    if (!newPin) return { error: 'PIN must be 4–6 digits' };
    if (managerPinMatches(newPin)) return { error: 'That PIN is reserved for the manager' };
    const dupPin = await pool.query('SELECT 1 FROM employees WHERE pin = $1', [newPin]);
    if (dupPin.rows.length) return { error: 'That PIN is already in use by someone else' };
  }
  const dupName = await pool.query('SELECT 1 FROM employees WHERE lower(name) = lower($1)', [name]);
  if (dupName.rows.length) return { error: 'An employee with that name already exists' };

  await pool.query(
    `INSERT INTO employees (name, pin, email, starting_balance, active)
     VALUES ($1, $2, $3, $4, true)`,
    [name, newPin, email || null, startingBalance]
  );
  return { ok: true };
}

async function updateEmployee(who, e) {
  if (!isManager(who)) return { error: 'Manager only' };
  e = e || {};
  const id = cleanInt(e.id);
  if (id === null) return { error: 'Bad employee id' };
  const name = String(e.name || '').trim();
  if (!name) return { error: 'Name is required' };
  const startingBalance = cleanInt(e.startingBalance);
  if (startingBalance === null) return { error: 'Starting balance must be a whole number' };
  const email = String(e.email || '').trim();

  const dupName = await pool.query(
    'SELECT 1 FROM employees WHERE lower(name) = lower($1) AND id <> $2', [name, id]);
  if (dupName.rows.length) return { error: 'Another employee already has that name' };

  // PIN only changes if a (non-blank) value is supplied. Blank = leave as-is.
  const rawPin = String(e.pin == null ? '' : e.pin).trim();
  let newPin = null;
  if (rawPin) {
    newPin = cleanPin(rawPin);
    if (!newPin) return { error: 'PIN must be 4–6 digits' };
    if (managerPinMatches(newPin)) return { error: 'That PIN is reserved for the manager' };
    const dupPin = await pool.query('SELECT 1 FROM employees WHERE pin = $1 AND id <> $2', [newPin, id]);
    if (dupPin.rows.length) return { error: 'That PIN is already in use by someone else' };
  }

  if (newPin) {
    await pool.query(
      `UPDATE employees SET name=$1, email=$2, starting_balance=$3, pin=$4 WHERE id=$5`,
      [name, email || null, startingBalance, newPin, id]);
  } else {
    await pool.query(
      `UPDATE employees SET name=$1, email=$2, starting_balance=$3 WHERE id=$4`,
      [name, email || null, startingBalance, id]);
  }
  return { ok: true };
}

async function setEmployeeActive(who, id, active) {
  if (!isManager(who)) return { error: 'Manager only' };
  const eid = cleanInt(id);
  if (eid === null) return { error: 'Bad employee id' };
  await pool.query(`UPDATE employees SET active=$1 WHERE id=$2`, [!!active, eid]);
  return { ok: true };
}

// Take someone in/out of the nightly closing-checklist rotation without
// otherwise changing their account. Manager only.
async function setEmployeeChecklistEligible(who, id, eligible) {
  if (!isManager(who)) return { error: 'Manager only' };
  const eid = cleanInt(id);
  if (eid === null) return { error: 'Bad employee id' };
  await pool.query(`UPDATE employees SET checklist_eligible=$1 WHERE id=$2`, [!!eligible, eid]);
  return { ok: true };
}

// Take someone in/out of Employee-of-the-Month voting (as a candidate and a
// voter) without otherwise changing their account. Manager only.
async function setEmployeeVotingEligible(who, id, eligible) {
  if (!isManager(who)) return { error: 'Manager only' };
  const eid = cleanInt(id);
  if (eid === null) return { error: 'Bad employee id' };
  await pool.query(`UPDATE employees SET voting_eligible=$1 WHERE id=$2`, [!!eligible, eid]);
  return { ok: true };
}

// ---------- Admin accounts (login / signup / management) ----------

// Shared create path used by both public self-signup and manager "add admin".
// Returns { id, name } on success or { error } on failure.
async function createAdminRow(name, email, password, pending) {
  const nm = String(name || '').trim();
  const em = normalizeEmail(email);
  const pw = String(password == null ? '' : password);
  if (!nm) return { error: 'Name is required' };
  if (!validEmail(em)) return { error: 'Enter a valid email address' };
  if (pw.length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters` };
  const dup = await pool.query('SELECT 1 FROM admins WHERE lower(email) = $1', [em]);
  if (dup.rows.length) return { error: 'An admin with that email already exists' };
  const { salt, hash } = hashPassword(pw);
  const isPending = !!pending;
  const { rows } = await pool.query(
    `INSERT INTO admins (name, email, pw_salt, pw_hash, active, pending) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [nm, em, salt, hash, !isPending, isPending]   // pending accounts are inactive until approved
  );
  return { id: rows[0].id, name: nm };
}

// Public self-service signup. Anyone can request an account, but it's created
// PENDING and cannot log in until an existing admin (or the Manager PIN holder)
// approves it in Manage → Admins. The very first admin is auto-approved.
async function adminSignup(body) {
  body = body || {};
  // The very first admin bootstraps the system (auto-approved + logged in).
  // Everyone after must be approved by an existing admin (or the Manager PIN).
  const { rows: c } = await pool.query('SELECT COUNT(*)::int AS n FROM admins');
  const isFirst = c[0].n === 0;
  const res = await createAdminRow(body.name, body.email, body.password, !isFirst);
  if (res.error) return res;
  if (isFirst) {
    const token = await createSession(res.id);
    return { role: 'manager', name: res.name, token };
  }
  return { ok: true, pending: true, name: res.name };
}

async function adminLogin(body) {
  body = body || {};
  const em = normalizeEmail(body.email);
  const pw = String(body.password == null ? '' : body.password);
  if (!em || !pw) return { error: 'Enter your email and password' };
  const { rows } = await pool.query(
    'SELECT id, name, pw_salt, pw_hash, active FROM admins WHERE lower(email) = $1 LIMIT 1', [em]);
  const a = rows[0];
  if (!a || !a.active || !verifyPassword(pw, a.pw_salt, a.pw_hash)) {
    return { error: 'Invalid email or password' };   // generic — no account enumeration
  }
  const token = await createSession(a.id);
  return { role: 'manager', name: a.name, token };
}

async function adminLogout(body) {
  const t = String((body && body.token) || '').trim();
  if (t) await pool.query('DELETE FROM admin_sessions WHERE token = $1', [t]);
  return { ok: true };
}

async function listAdmins(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  const { rows } = await pool.query(
    `SELECT id, name, email, active, pending FROM admins ORDER BY pending DESC, active DESC, name`);
  return { admins: rows };
}

async function approveAdmin(who, id) {
  if (!isManager(who)) return { error: 'Manager only' };
  const aid = cleanInt(id);
  if (aid === null) return { error: 'Bad admin id' };
  await pool.query(`UPDATE admins SET pending = false, active = true WHERE id = $1 AND pending = true`, [aid]);
  return { ok: true };
}

async function denyAdmin(who, id) {
  if (!isManager(who)) return { error: 'Manager only' };
  const aid = cleanInt(id);
  if (aid === null) return { error: 'Bad admin id' };
  await pool.query(`DELETE FROM admins WHERE id = $1 AND pending = true`, [aid]);
  return { ok: true };
}

async function addAdmin(who, a) {
  if (!isManager(who)) return { error: 'Manager only' };
  const res = await createAdminRow((a || {}).name, (a || {}).email, (a || {}).password);
  return res.error ? res : { ok: true };
}

async function updateAdmin(who, a) {
  if (!isManager(who)) return { error: 'Manager only' };
  a = a || {};
  const id = cleanInt(a.id);
  if (id === null) return { error: 'Bad admin id' };
  const nm = String(a.name || '').trim();
  const em = normalizeEmail(a.email);
  if (!nm) return { error: 'Name is required' };
  if (!validEmail(em)) return { error: 'Enter a valid email address' };
  const dup = await pool.query('SELECT 1 FROM admins WHERE lower(email) = $1 AND id <> $2', [em, id]);
  if (dup.rows.length) return { error: 'Another admin already uses that email' };

  // Password only changes if a (non-blank) value is supplied. Blank = keep current.
  const pw = String(a.password == null ? '' : a.password);
  if (pw) {
    if (pw.length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters` };
    const { salt, hash } = hashPassword(pw);
    const { rowCount } = await pool.query(
      `UPDATE admins SET name=$1, email=$2, pw_salt=$3, pw_hash=$4 WHERE id=$5`,
      [nm, em, salt, hash, id]);
    if (!rowCount) return { error: 'Admin not found' };
  } else {
    const { rowCount } = await pool.query(
      `UPDATE admins SET name=$1, email=$2 WHERE id=$3`, [nm, em, id]);
    if (!rowCount) return { error: 'Admin not found' };
  }
  return { ok: true };
}

async function setAdminActive(who, id, active) {
  if (!isManager(who)) return { error: 'Manager only' };
  const aid = cleanInt(id);
  if (aid === null) return { error: 'Bad admin id' };
  await pool.query('UPDATE admins SET active=$1 WHERE id=$2', [!!active, aid]);
  if (!active) await pool.query('DELETE FROM admin_sessions WHERE admin_id=$1', [aid]); // revoke logins
  return { ok: true };
}

// =================================================================
// End-of-day checklist
// =================================================================

// "Today" anchored to US Pacific (PST/PDT) — the warehouse's local day. Constant,
// safe to inline. To change the warehouse timezone, swap the IANA name here.
const BIZ_DATE = "(now() AT TIME ZONE 'America/Los_Angeles')::date";

// Days with no closing checklist are the manager-editable `closed_dows` setting
// (default Sun+Sat) — see closedDows().

async function nameForEmpId(id) {
  if (id == null) return null;
  const { rows } = await pool.query('SELECT name FROM employees WHERE id = $1', [id]);
  return rows.length ? rows[0].name : null;
}

// Make sure today's run exists; if not, fairly pick a closer and snapshot the
// active tasks into it. Serialized by an advisory lock so two devices opening
// the app at once can't create two runs. Returns the run row (or null if there
// are no active employees to assign).
async function ensureTodayRun() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(76123451)');
    let { rows } = await client.query(`SELECT * FROM checklist_runs WHERE run_date = ${BIZ_DATE}`);
    if (rows.length) { await client.query('COMMIT'); return rows[0]; }

    // Don't create/assign a run on closed days (e.g. Sundays — office closed).
    const { rows: dowRows } = await client.query(`SELECT EXTRACT(DOW FROM ${BIZ_DATE})::int AS dow`);
    if (closedDows().includes(dowRows[0].dow)) { await client.query('ROLLBACK'); return null; }

    const { rows: tRows } = await client.query(`SELECT to_char(${BIZ_DATE}, 'YYYY-MM-DD') AS d`);
    const today = tRows[0].d;

    // Eligible closers (active + in the rotation), in ALPHABETICAL order — this list
    // IS the closing order. Angel etc. are excluded.
    const { rows: elig } = await client.query(
      'SELECT id FROM employees WHERE active = true AND checklist_eligible = true ORDER BY lower(name)');
    const eligibleIds = elig.map(r => r.id);
    if (!eligibleIds.length) { await client.query('ROLLBACK'); return null; }

    // Cycle rotation: walk straight down the alphabetical order, one closer per day.
    // We track only the cycle START; once everyone eligible has had a turn this cycle
    // we restart a fresh A→Z pass. No randomness, no recency reordering.
    const { rows: rotRows } = await client.query('SELECT cycle_start FROM checklist_rotation WHERE id = 1');
    let cycleStart = (rotRows[0] && rotRows[0].cycle_start) ? rotRows[0].cycle_start : null;

    // Who has already had a turn this cycle (by the run they were assigned).
    let goneSet = new Set();
    if (cycleStart) {
      const { rows: g } = await client.query(
        'SELECT DISTINCT employee_id FROM checklist_runs WHERE employee_id IS NOT NULL AND run_date >= $1', [cycleStart]);
      g.forEach(r => goneSet.add(r.employee_id));
    }
    let remaining = eligibleIds.filter(id => !goneSet.has(id));

    // New cycle when there's none yet or everyone eligible has gone: restart A→Z.
    if (!cycleStart || remaining.length === 0) {
      cycleStart = today;
      goneSet = new Set();
      remaining = eligibleIds.slice();
    }

    // Next closer = first person in alphabetical order who hasn't gone this cycle.
    const pickId = remaining[0];

    // Persist the alphabetical order + cycle start (cycle_order kept for back-compat).
    await client.query(
      'UPDATE checklist_rotation SET cycle_order = $1, cycle_start = $2 WHERE id = 1',
      [eligibleIds, cycleStart]);

    const ins = await client.query(
      `INSERT INTO checklist_runs (run_date, employee_id) VALUES (${BIZ_DATE}, $1) RETURNING *`,
      [pickId]);
    const run = ins.rows[0];
    await client.query(
      `INSERT INTO checklist_items (run_id, task_id, category, label, sort_order)
       SELECT $1, id, category, label, sort_order FROM checklist_tasks WHERE active = true`,
      [run.id]);
    await client.query('COMMIT');
    return run;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// Compact summary for getData (drives the red tab + alert).
async function checklistSummary(who) {
  const run = await ensureTodayRun();
  if (!run) return { date: null, assignee: null, status: null, mine: false, total: 0, checked: 0, flagged: 0 };
  const assignee = await nameForEmpId(run.employee_id);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE checked)::int AS checked,
            COUNT(*) FILTER (WHERE flagged)::int AS flagged
       FROM checklist_items WHERE run_id = $1`, [run.id]);
  let late = false;
  if (lateFlagOn()) {
    const { rows: lr } = await pool.query(
      `SELECT (CASE WHEN $1::timestamptz IS NOT NULL
                      THEN ($1::timestamptz AT TIME ZONE 'America/Los_Angeles') > (${BIZ_DATE} + $2::time)
                    WHEN $3 <> 'completed'
                      THEN (now() AT TIME ZONE 'America/Los_Angeles') > (${BIZ_DATE} + $2::time)
                    ELSE false END) AS late`,
      [run.started_at, checklistDeadline(), run.status]);
    late = !!lr[0].late;
  }
  return {
    date: run.run_date, assignee, status: run.status,
    mine: !!(who && who.role === 'employee' && assignee === who.name),
    total: rows[0].total, checked: rows[0].checked, flagged: rows[0].flagged,
    late, latePenalized: !!run.late_penalized_at, deadlineLabel: deadlineLabel(),
  };
}

// Recent runs (most recent first) with their items attached. Shared by the
// employee history view and the manager review.
async function runsWithItems(limit) {
  const { rows: runs } = await pool.query(`
    SELECT r.id, to_char(r.run_date, 'YYYY-MM-DD') AS run_date, r.status, r.submitted_at,
           r.started_at,
           EXTRACT(EPOCH FROM (r.submitted_at - r.started_at))::int AS duration_secs,
           ($2 AND (
             CASE WHEN r.started_at IS NOT NULL
                    THEN (r.started_at AT TIME ZONE 'America/Los_Angeles') > (r.run_date + $3::time)
                  WHEN r.status <> 'completed' AND r.run_date = ${BIZ_DATE}
                    THEN (now() AT TIME ZONE 'America/Los_Angeles') > (r.run_date + $3::time)
                  ELSE false END
           )) AS late,
           (r.late_penalized_at IS NOT NULL) AS late_penalized,
           e.name AS assignee
      FROM checklist_runs r LEFT JOIN employees e ON e.id = r.employee_id
     ORDER BY r.run_date DESC LIMIT $1`, [limit, lateFlagOn(), checklistDeadline()]);
  const ids = runs.map(r => r.id);
  const byRun = {};
  if (ids.length) {
    const { rows: items } = await pool.query(`
      SELECT id, run_id, category, label, checked, checked_at, flagged, flag_note, flagged_by
        FROM checklist_items WHERE run_id = ANY($1) ORDER BY sort_order, id`, [ids]);
    items.forEach(it => { (byRun[it.run_id] = byRun[it.run_id] || []).push(it); });
  }
  return runs.map(r => ({ ...r, items: byRun[r.id] || [] }));
}

async function todayStr() {
  return (await pool.query(`SELECT to_char(${BIZ_DATE}, 'YYYY-MM-DD') AS d`)).rows[0].d;
}

// Today's run for the employee Checklist tab, plus read-only history of past days.
async function getChecklist(who) {
  if (!who) return { error: 'Not authorized' };
  const run = await ensureTodayRun();
  const today = await todayStr();
  const recent = await runsWithItems(15);
  // The timer (started_at / duration / per-item checked_at) is manager-only —
  // strip it from the employee-facing payload so it's never exposed to employees.
  const stripItemTiming = its => (its || []).map(({ checked_at, ...i }) => i);
  const stripTiming = ({ started_at, duration_secs, late, late_penalized, items, ...rest }) =>
    ({ ...rest, items: stripItemTiming(items) });
  const history = recent.filter(r => r.run_date !== today).map(stripTiming);   // past days only
  const base = { deadlineLabel: deadlineLabel(), lateFlagOn: lateFlagOn() };
  if (!run) {
    return { date: today, today, assignee: null, status: null, mine: false, items: [], history, ...base };
  }
  const assignee = await nameForEmpId(run.employee_id);
  const todayRow = recent.find(r => r.id === run.id);
  return {
    date: today, today, assignee, status: run.status,
    mine: who.role === 'employee' && assignee === who.name,
    submittedAt: run.submitted_at,
    started: !!run.started_at,     // has the assignee tapped "Start"? (drives the start prompt)
    items: todayRow ? stripItemTiming(todayRow.items) : [],
    history, ...base,
  };
}

// The assigned worker taps "Start" when they begin — stamps started_at once so
// the manager-only timer can measure how long closing took.
async function startChecklist(who) {
  if (!who || who.role !== 'employee') return { error: 'Only the assigned worker can start' };
  const run = await ensureTodayRun();
  if (!run) return { error: 'No checklist today' };
  const assignee = await nameForEmpId(run.employee_id);
  if (assignee !== who.name) return { error: 'It is not your turn today' };
  if (run.status === 'completed') return { error: 'Already submitted' };
  await pool.query('UPDATE checklist_runs SET started_at = now() WHERE id = $1 AND started_at IS NULL', [run.id]);
  return { ok: true };
}

// The assigned worker submits. All boxes must be checked (enforced here too).
async function submitChecklist(who) {
  if (!who || who.role !== 'employee') return { error: 'Only the assigned worker can submit' };
  const run = await ensureTodayRun();
  if (!run) return { error: 'No checklist today' };
  const assignee = await nameForEmpId(run.employee_id);
  if (assignee !== who.name) return { error: 'It is not your turn today' };
  if (run.status === 'completed') return { error: 'Already submitted' };
  await pool.query('UPDATE checklist_items SET checked = true WHERE run_id = $1', [run.id]);
  await pool.query(`UPDATE checklist_runs SET status = 'completed', submitted_at = now() WHERE id = $1`, [run.id]);
  return { ok: true };
}

// The assignee ticks one item. Enforces sequential order (can't check ahead) and
// stamps checked_at so the manager can see the time between checks.
async function checkChecklistItem(who, itemId, checked) {
  if (!who || who.role !== 'employee') return { error: 'Only the assigned worker can check items' };
  const iid = cleanInt(itemId);
  if (iid === null) return { error: 'Bad item id' };
  const run = await ensureTodayRun();
  if (!run) return { error: 'No checklist today' };
  const assignee = await nameForEmpId(run.employee_id);
  if (assignee !== who.name) return { error: 'It is not your turn today' };
  if (run.status === 'completed') return { error: 'Already submitted' };
  if (!run.started_at) return { error: 'Tap Start first.' };

  const { rows: itRows } = await pool.query(
    'SELECT id, sort_order FROM checklist_items WHERE id = $1 AND run_id = $2', [iid, run.id]);
  if (!itRows.length) return { error: 'Item not found' };
  const item = itRows[0];

  if (checked) {
    // Every earlier item (by sort_order, id) must already be checked.
    const { rows: before } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM checklist_items
        WHERE run_id = $1 AND checked = false
          AND (sort_order < $2 OR (sort_order = $2 AND id < $3))`,
      [run.id, item.sort_order, item.id]);
    if (before[0].n > 0) return { error: 'Please do the tasks in order — finish the one above first.' };
    await pool.query('UPDATE checklist_items SET checked = true, checked_at = now() WHERE id = $1', [iid]);
  } else {
    // Only the most recent check may be undone (nothing checked after it).
    const { rows: after } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM checklist_items
        WHERE run_id = $1 AND checked = true
          AND (sort_order > $2 OR (sort_order = $2 AND id > $3))`,
      [run.id, item.sort_order, item.id]);
    if (after[0].n > 0) return { error: 'You can only undo the most recent check.' };
    await pool.query('UPDATE checklist_items SET checked = false, checked_at = NULL WHERE id = $1', [iid]);
  }
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE checked)::int AS done
       FROM checklist_items WHERE run_id = $1`, [run.id]);
  return { ok: true, total: cnt[0].total, done: cnt[0].done };
}

// Manager applies the "not started by the deadline" penalty to a flagged run:
// deducts the configured bubbles from the assigned closer (reversible like any
// award) and marks the run penalized so it can't be double-charged. Manager only.
async function penalizeLateChecklist(who, runId) {
  if (!isManager(who)) return { error: 'Manager only' };
  const id = cleanInt(runId);
  if (id === null) return { error: 'Bad run id' };
  const { rows } = await pool.query(
    `SELECT r.id, r.employee_id, r.late_penalized_at, e.name AS name
       FROM checklist_runs r LEFT JOIN employees e ON e.id = r.employee_id WHERE r.id = $1`, [id]);
  if (!rows.length) return { error: 'Run not found' };
  if (rows[0].late_penalized_at) return { error: 'Already penalized' };
  if (!rows[0].employee_id) return { error: 'No one is assigned to that run' };
  const amt = latePenalty();
  await pool.query(
    `INSERT INTO awards (employee_id, metric, amount, awarded_by, note)
     VALUES ($1, 'Late closing checklist', $2, $3, $4)`,
    [rows[0].employee_id, -amt, who.name, 'Not started by ' + deadlineLabel()]);
  await pool.query('UPDATE checklist_runs SET late_penalized_at = now() WHERE id = $1', [id]);
  return { ok: true };
}

// Manager resolves a flagged checklist item from the Bubbles notification list.
// Approve = the flag is valid → deduct the checklist penalty from the closer and
// clear the flag. Deny = false alarm → just clear the flag. Manager only.
async function resolveChecklistFlag(who, itemId, approve) {
  if (!isManager(who)) return { error: 'Manager only' };
  const iid = cleanInt(itemId);
  if (iid === null) return { error: 'Bad item id' };
  const { rows } = await pool.query(
    `SELECT ci.id, ci.label, ci.flagged, r.employee_id
       FROM checklist_items ci JOIN checklist_runs r ON r.id = ci.run_id
      WHERE ci.id = $1`, [iid]);
  if (!rows.length) return { error: 'Item not found' };
  if (!rows[0].flagged) return { error: 'Already resolved' };
  if (approve) {
    if (!rows[0].employee_id) return { error: 'No one is assigned to that run' };
    await pool.query(
      `INSERT INTO awards (employee_id, metric, amount, awarded_by, note)
       VALUES ($1, 'Checklist flag', $2, $3, $4)`,
      [rows[0].employee_id, -latePenalty(), who.name, rows[0].label]);
  }
  await pool.query('UPDATE checklist_items SET flagged = false, flag_note = NULL WHERE id = $1', [iid]);
  return { ok: true };
}

// Read-only view of the current rotation cycle, in order, marking who has gone
// and who's up today — so a manager can see the expected order (esp. when
// shifting someone out). Mirrors how ensureTodayRun() picks.
async function rotationView() {
  const { rows: elig } = await pool.query(
    'SELECT id, name FROM employees WHERE active = true AND checklist_eligible = true ORDER BY lower(name)');
  const nameById = new Map(elig.map(r => [r.id, r.name]));
  const cur = elig.map(r => r.id);   // alphabetical — the closing order
  if (!cur.length) return [];
  const { rows: rotRows } = await pool.query('SELECT cycle_start FROM checklist_rotation WHERE id = 1');
  const cycleStart = (rotRows[0] && rotRows[0].cycle_start) ? rotRows[0].cycle_start : null;

  let goneSet = new Set();
  if (cycleStart) {
    const { rows: g } = await pool.query(
      'SELECT DISTINCT employee_id FROM checklist_runs WHERE employee_id IS NOT NULL AND run_date >= $1', [cycleStart]);
    g.forEach(r => goneSet.add(r.employee_id));
  }
  const { rows: tr } = await pool.query(`SELECT employee_id FROM checklist_runs WHERE run_date = ${BIZ_DATE}`);
  const todayId = tr.length ? tr[0].employee_id : null;

  return cur.map(id => ({
    name: nameById.get(id),
    done: goneSet.has(id) && id !== todayId,
    today: id === todayId,
  })).filter(x => x.name);
}

// Manager review: recent runs with their items.
async function getChecklistAdmin(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  await ensureTodayRun();
  // Active people the manager can reassign a day to (anyone active — even if
  // they're not normally in the rotation, e.g. covering for someone who's out).
  // lastRun + recent let the UI warn before assigning someone who did it within 3 days.
  const { rows: employees } = await pool.query(
    `SELECT e.id, e.name,
            to_char(MAX(r.run_date), 'YYYY-MM-DD') AS "lastRun",
            COALESCE(MAX(r.run_date) >= (${BIZ_DATE} - 3), false) AS recent
       FROM employees e LEFT JOIN checklist_runs r ON r.employee_id = e.id
      WHERE e.active = true
      GROUP BY e.id, e.name ORDER BY e.name`);
  return { today: await todayStr(), runs: await runsWithItems(21), employees, rotation: await rotationView(),
           deadlineLabel: deadlineLabel(), latePenalty: latePenalty(), lateFlagOn: lateFlagOn() };
}

// Flag a task as missed/wrong, with an optional bubble deduction in one step.
async function flagChecklistItem(who, body) {
  if (!isManager(who)) return { error: 'Manager only' };
  body = body || {};
  const itemId = cleanInt(body.itemId);
  if (itemId === null) return { error: 'Bad item' };
  const note = String(body.note || '').trim();
  const deduct = cleanInt(body.deduct) || 0;
  const { rows } = await pool.query(`
    SELECT ci.id, ci.label, r.employee_id
      FROM checklist_items ci JOIN checklist_runs r ON r.id = ci.run_id
     WHERE ci.id = $1`, [itemId]);
  if (!rows.length) return { error: 'Item not found' };
  const it = rows[0];
  await pool.query(
    `UPDATE checklist_items SET flagged = true, flag_note = $2, flagged_by = $3, flagged_at = now() WHERE id = $1`,
    [itemId, note || null, who.name]);
  if (deduct > 0 && it.employee_id != null) {
    await pool.query(
      `INSERT INTO awards (employee_id, metric, amount, awarded_by, note)
       VALUES ($1, $2, $3, $4, 'Checklist flag')`,
      [it.employee_id, 'Checklist: ' + String(it.label).slice(0, 60), -Math.abs(deduct), who.name]);
  }
  return { ok: true };
}

async function unflagChecklistItem(who, itemId) {
  if (!isManager(who)) return { error: 'Manager only' };
  const id = cleanInt(itemId);
  if (id === null) return { error: 'Bad item' };
  await pool.query(
    `UPDATE checklist_items SET flagged = false, flag_note = NULL, flagged_by = NULL, flagged_at = NULL WHERE id = $1`,
    [id]);
  return { ok: true };
}

// Manager swaps who's doing a given day's checklist — e.g. the auto-assigned
// person was out that day. Only a not-yet-completed run can be reassigned;
// completed history is locked. Manager only.
async function reassignChecklistRun(who, body) {
  if (!isManager(who)) return { error: 'Manager only' };
  body = body || {};
  const runId = cleanInt(body.runId);
  const empId = cleanInt(body.employeeId);
  if (runId === null) return { error: 'Bad checklist day' };
  if (empId === null) return { error: 'Pick a person' };
  const { rows: rr } = await pool.query('SELECT status FROM checklist_runs WHERE id = $1', [runId]);
  if (!rr.length) return { error: 'Checklist not found' };
  if (rr[0].status === 'completed') {
    return { error: "That day's checklist is already completed — it can't be reassigned." };
  }
  const { rows: er } = await pool.query('SELECT 1 FROM employees WHERE id = $1 AND active = true', [empId]);
  if (!er.length) return { error: 'That person is not an active employee' };
  await pool.query('UPDATE checklist_runs SET employee_id = $1 WHERE id = $2', [empId, runId]);
  return { ok: true };
}

// Manager fixes a check the worker missed (or unchecks a wrong one).
async function correctChecklistItem(who, body) {
  if (!isManager(who)) return { error: 'Manager only' };
  body = body || {};
  const id = cleanInt(body.itemId);
  if (id === null) return { error: 'Bad item' };
  await pool.query('UPDATE checklist_items SET checked = $2 WHERE id = $1', [id, !!body.checked]);
  return { ok: true };
}

// ----- Checklist task management (Manage → Checklist) -----

async function addChecklistTask(who, t) {
  if (!isManager(who)) return { error: 'Manager only' };
  t = t || {};
  const label = String(t.label || '').trim();
  if (!label) return { error: 'Task text is required' };
  const category = String(t.category || 'General').trim() || 'General';
  const sort = cleanInt(t.sortOrder);
  await pool.query(
    `INSERT INTO checklist_tasks (category, label, sort_order, active) VALUES ($1, $2, $3, true)`,
    [category, label, sort === null ? 999 : sort]);
  return { ok: true };
}

async function updateChecklistTask(who, t) {
  if (!isManager(who)) return { error: 'Manager only' };
  t = t || {};
  const id = cleanInt(t.id);
  const label = String(t.label || '').trim();
  if (id === null) return { error: 'Bad task id' };
  if (!label) return { error: 'Task text is required' };
  const category = String(t.category || 'General').trim() || 'General';
  const sort = cleanInt(t.sortOrder);
  const { rowCount } = await pool.query(
    `UPDATE checklist_tasks SET category = $1, label = $2, sort_order = $3 WHERE id = $4`,
    [category, label, sort === null ? 999 : sort, id]);
  if (!rowCount) return { error: 'Task not found' };
  return { ok: true };
}

async function setChecklistTaskActive(who, id, active) {
  if (!isManager(who)) return { error: 'Manager only' };
  const tid = cleanInt(id);
  if (tid === null) return { error: 'Bad task id' };
  await pool.query('UPDATE checklist_tasks SET active = $1 WHERE id = $2', [!!active, tid]);
  return { ok: true };
}

// Clean reset: clear all not-yet-completed runs (e.g. launch/test data) and
// freshly assign today. Completed history is preserved. Manager only.
async function resetChecklist(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  await pool.query("DELETE FROM checklist_runs WHERE status = 'pending'");
  // Start a fresh rotation cycle (new alphabetical order on the next pick).
  await pool.query("UPDATE checklist_rotation SET cycle_order = '{}', cycle_start = NULL WHERE id = 1");
  const run = await ensureTodayRun();
  return { ok: true, assignee: run ? await nameForEmpId(run.employee_id) : null };
}

// Delete one checklist run by id (e.g. an old "Not completed" day or a
// pre-launch artifact). Its items cascade-delete. Manager only — the UI only
// offers this on past, not-completed runs, but the id is validated here too.
async function deleteChecklistRun(who, runId) {
  if (!isManager(who)) return { error: 'Manager only' };
  const id = cleanInt(runId);
  if (id === null) return { error: 'Bad run id' };
  const { rowCount } = await pool.query('DELETE FROM checklist_runs WHERE id = $1', [id]);
  if (!rowCount) return { error: 'Run not found.' };
  return { ok: true };
}

// Restart the cycle now: a fresh alphabetical (A→Z) pass starting from today,
// keeping today's assignee. The order is always alphabetical; this just resets
// who counts as "already gone" so the upcoming names start clean. Manager only.
async function reshuffleChecklist(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  const { rows: sh } = await pool.query(
    'SELECT id FROM employees WHERE active = true AND checklist_eligible = true ORDER BY lower(name)');
  const order = sh.map(r => r.id);
  if (!order.length) return { error: 'No eligible closers.' };
  const today = (await pool.query(`SELECT to_char(${BIZ_DATE}, 'YYYY-MM-DD') AS d`)).rows[0].d;
  // cycle_start = today so today's closer counts as gone; everyone else starts fresh.
  await pool.query('UPDATE checklist_rotation SET cycle_order = $1, cycle_start = $2 WHERE id = 1', [order, today]);
  return { ok: true };
}

// =================================================================
// Label Printer — print queue + bridge
// =================================================================
// Shared secret between this server and the warehouse "print bridge" script.
// Set PRINT_BRIDGE_TOKEN on the Railway service AND in the bridge script.
const BRIDGE_TOKEN = process.env.PRINT_BRIDGE_TOKEN || '';
const BRIDGE_ONLINE_MS = 45000;   // bridge counts as "online" if seen in this window

// Build ZPL for a 2" x 1" label @ 203 dpi (406 x 203 dots): description line on
// top, big part number, then a centered Code 128. Layout dialed in on the real
// ZQ620 (v22). ^PQ prints `qty` copies. Mirrors the client preview.
// Keep only the important leading part of a description so it fits one clean
// line above the number (drops trailing brand/size detail). Cuts on a word
// boundary near 32 chars; no ellipsis.
function importantDesc(s) {
  s = String(s == null ? '' : s).replace(/[\r\n\t]/g, '').replace(/[\^~\\]/g, '').trim();
  if (s.length <= 32) return s;
  let cut = s.slice(0, 32);
  const sp = cut.lastIndexOf(' ');
  if (sp > 14) cut = cut.slice(0, sp);
  return cut.replace(/[\s,]+$/, '');
}

// Exact Code 128 width in modules when the data is forced to subset B (the `>:`
// prefix below): start + one symbol per char + checksum, all 11 modules, + 13
// for the stop bar. Forcing one subset makes the width 100% predictable so the
// barcode can be centered exactly (auto subset-switching would vary the width
// and throw off centering — that was the bug).
function bc128ModulesB(len) { return (Math.max(len, 1) + 2) * 11 + 13; }

function buildLabelZpl(code, qty, desc) {
  const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]/g, '').replace(/[\^~\\>]/g, '').trim().slice(0, n);
  const c = clean(code, 40);
  const d = importantDesc(desc);
  const q = Math.max(1, Math.min(999, parseInt(qty, 10) || 1));
  const len = Math.max(c.length, 1);
  // Number condenses its character WIDTH for long codes so it always fits.
  const numW = Math.max(18, Math.min(48, Math.floor(390 / len)));
  // Barcode: forced subset B (`^FD>:`) → exact, predictable width. Fixed module
  // width (uniform bar thickness + height), dropping to 1 only for very long
  // codes. Centered by exact x-origin, shifted toward the bottom.
  const bcModules = bc128ModulesB(len);
  const modW = (bcModules * 2 <= 396) ? 2 : 1;
  const bcW = bcModules * modW;
  const bcX = Math.max(2, Math.round((406 - bcW) / 2));
  return [
    '^XA', '^CI28', '^PW406', '^LL0203',
    '^FO8,18^A0N,22,22^FB390,1,0,C,0^FD' + d + '^FS',
    '^FO0,48^A0N,48,' + numW + '^FB406,1,0,C,0^FD' + c + '^FS',
    '^BY' + modW + ',2.5',
    '^FO' + bcX + ',118^BCN,64,N,N,N^FD>:' + c + '^FS',
    '^PQ' + q + ',0,0,N', '^XZ'
  ].join('\n');
}

async function bridgeOnline() {
  const { rows } = await pool.query('SELECT last_seen FROM print_bridge WHERE id = 1');
  if (!rows.length || !rows[0].last_seen) return false;
  return (Date.now() - new Date(rows[0].last_seen).getTime()) < BRIDGE_ONLINE_MS;
}

// Any signed-in user queues a label. The server builds the ZPL so the label
// format lives in one place and devices need nothing installed.
async function enqueuePrint(who, body) {
  if (!who) return { error: 'Please sign in.' };
  const code = String(body && body.code != null ? body.code : '')
    .replace(/[\r\n\t]/g, '').replace(/[\^~\\]/g, '').trim().slice(0, 40);
  if (!code) return { error: 'Nothing to print — scan or type a barcode first.' };
  const qty = Math.max(1, Math.min(999, parseInt(body && body.qty, 10) || 1));

  // Which printer this device chose (per-device). Falls back to the first printer.
  const cfg = await getCloudConfig();
  const cloudOn = cloudConfigured(cfg);
  const serial = cloudOn ? await resolvePrinterSerial(body && body.printerId) : '';
  const useCloud = cloudOn && !!serial;

  // Enforce the manager's daily cloud-call cap (only when the cloud path is used).
  // Check before inserting so a blocked attempt doesn't count.
  if (useCloud && cfg.daily_limit != null && cfg.daily_limit > 0) {
    if ((await printCallsToday()) >= cfg.daily_limit) {
      return { ok: false, error: 'Daily print limit reached (' + cfg.daily_limit + ' for today). A manager can raise it in Manage → Label Printer.' };
    }
  }

  // Real description from the imported parts list; fall back to one passed in
  // (e.g. an order line's own description) when the part isn't in the list.
  const looked = await lookupDescription(code);
  const description = looked || (body && body.desc ? String(body.desc) : '');
  const zpl = buildLabelZpl(code, qty, description);
  const batchId = (body && body.batchId) ? String(body.batchId).slice(0, 40) : null;
  const { rows } = await pool.query(
    'INSERT INTO print_jobs (code, qty, zpl, requested_by, batch_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [code, qty, zpl, who.name || null, batchId]);
  const jobId = rows[0].id;

  // Preferred path: Zebra cloud (no PC). Falls back to the warehouse-PC bridge.
  if (useCloud) {
    const res = await sendViaCloud(cfg, zpl, serial);
    if (res.ok) {
      await pool.query("UPDATE print_jobs SET status='printed', printed_at=now() WHERE id=$1", [jobId]);
      return { ok: true, jobId, qty, code, via: 'cloud', printed: true };
    }
    await pool.query("UPDATE print_jobs SET status='error', error=$2 WHERE id=$1", [jobId, String(res.error || 'cloud send failed').slice(0, 300)]);
    return { ok: false, jobId, qty, code, via: 'cloud', error: res.error || 'Cloud print failed' };
  }
  return { ok: true, jobId, qty, code, via: 'bridge', bridgeOnline: await bridgeOnline() };
}

async function getPrintStatus(who) {
  if (!who) return { error: 'Please sign in.' };
  const { rows } = await pool.query("SELECT COUNT(*)::int AS pending FROM print_jobs WHERE status = 'pending'");
  const cfg = await getCloudConfig();
  const out = { bridgeOnline: await bridgeOnline(), pending: rows[0].pending, cloudEnabled: cloudConfigured(cfg) };
  // Only a manager may see the bridge token (to paste into the warehouse PC script).
  if (isManager(who)) out.bridgeToken = await currentBridgeToken();
  return out;
}

// Manager view: how many labels were printed per day (= cloud API calls/day, to
// watch the 100/day free-tier limit) + today's per-person breakdown. US Pacific.
async function getPrintUsage(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  const tz = 'America/Los_Angeles';
  const today = await pool.query(
    "SELECT COUNT(*)::int AS n FROM print_jobs WHERE (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date", [tz]);
  const days = await pool.query(
    "SELECT (created_at AT TIME ZONE $1)::date::text AS day, COUNT(*)::int AS n FROM print_jobs WHERE created_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1 DESC", [tz]);
  const byUser = await pool.query(
    "SELECT COALESCE(requested_by,'(unknown)') AS name, COUNT(*)::int AS n FROM print_jobs WHERE (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date GROUP BY 1 ORDER BY 2 DESC", [tz]);
  const cfg = await getCloudConfig();
  return { today: today.rows[0].n, limit: 100, dailyLimit: cfg.daily_limit != null ? cfg.daily_limit : null, days: days.rows, byUser: byUser.rows };
}

// Manager view: recent print activity — who printed what, when, and the result.
async function getPrintLog(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  const { rows } = await pool.query(
    "SELECT id, code, qty, status, COALESCE(requested_by,'(unknown)') AS who, " +
    "to_char(created_at AT TIME ZONE 'America/Los_Angeles', 'Mon DD HH12:MI AM') AS at, " +
    "(created_at AT TIME ZONE 'America/Los_Angeles')::date::text AS day, batch_id AS batch, error " +
    "FROM print_jobs ORDER BY id DESC LIMIT 200");
  return { jobs: rows };
}

// ----- Bridge-facing (authenticated by the bridge token, not a user) -----
async function currentBridgeToken() {
  const { rows } = await pool.query('SELECT token FROM print_bridge WHERE id = 1');
  return (rows.length && rows[0].token) ? rows[0].token : '';
}

async function bridgeOk(body) {
  const supplied = body && body.bridgeToken;
  if (!supplied) return false;
  if (BRIDGE_TOKEN && supplied === BRIDGE_TOKEN) return true;     // optional env override
  const tok = await currentBridgeToken();
  return !!tok && supplied === tok;
}

// ----- Part descriptions (label text lookup + import) -----
// Minimal CSV parser for the "SKU,Description" export: handles quoted fields,
// doubled "" escapes, and CRLF. Returns [{code, description}] sans header.
function parseSkuCsv(text) {
  const recs = [];
  let field = '', rec = [], inQ = false;
  const endField = () => { rec.push(field); field = ''; };
  const endRec = () => { endField(); if (rec.some(x => x !== '')) recs.push(rec); rec = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') { inQ = true; }
    else if (c === ',') { endField(); }
    else if (c === '\n') { endRec(); }
    else if (c === '\r') { /* skip */ }
    else { field += c; }
  }
  endRec();
  const out = [];
  recs.forEach((r, i) => {
    const code = String(r[0] || '').trim();
    if (!code) return;
    if (i === 0 && /^sku$/i.test(code)) return;     // header row
    out.push({ code, description: String(r[1] || '').trim() });
  });
  return out;
}

async function lookupDescription(code) {
  const c = String(code || '').trim();
  if (!c) return '';
  const { rows } = await pool.query(
    'SELECT description FROM part_descriptions WHERE lower(code) = lower($1) LIMIT 1', [c]);
  return rows.length ? (rows[0].description || '') : '';
}

// Core: replace the whole description set in one transaction. Shared by the
// manual/pushed import and the weekly URL refresh.
async function replacePartDescriptions(items) {
  const map = new Map();
  for (const it of items) { const code = String(it.code || '').trim(); if (code) map.set(code, String(it.description || '').trim()); }
  const codes = [...map.keys()];
  if (!codes.length) return { ok: false, error: 'No rows found.' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE part_descriptions');
    const B = 1000;
    for (let i = 0; i < codes.length; i += B) {
      const chunk = codes.slice(i, i + B);
      const vals = [], params = [];
      chunk.forEach((code, j) => { params.push(code, map.get(code)); vals.push('($' + (j * 2 + 1) + ',$' + (j * 2 + 2) + ')'); });
      await client.query(
        'INSERT INTO part_descriptions (code, description) VALUES ' + vals.join(',') +
        ' ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description', params);
    }
    await client.query('UPDATE part_meta SET last_import = now(), count = $1 WHERE id = 1', [codes.length]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { ok: false, error: 'Import failed: ' + (e.message || e) };
  } finally {
    client.release();
  }
  return { ok: true, count: codes.length };
}

// Replace the whole description set from an uploaded CSV (full snapshot).
// Auth: the import token (headless job) OR a logged-in manager.
async function importPartDescriptions(body) {
  body = body || {};
  const { rows: pm } = await pool.query('SELECT token FROM part_meta WHERE id = 1');
  const tok = pm.length ? pm[0].token : '';
  let authed = !!(body.token && tok && body.token === tok);
  if (!authed) { const who = await resolveAuth(body); authed = isManager(who); }
  if (!authed) return { error: 'Not authorized' };

  let items = [];
  if (typeof body.csv === 'string' && body.csv.length) items = parseSkuCsv(body.csv);
  else if (Array.isArray(body.rows)) {
    items = body.rows.map(r => ({ code: String(r.code || '').trim(), description: String(r.description || '').trim() })).filter(r => r.code);
  }
  if (!items.length) return { error: 'No rows found in the upload.' };
  const res = await replacePartDescriptions(items);
  return res.ok ? res : { error: res.error };
}

// ----- ERP (Distribution One) via MCP, queried directly from Railway -----
// The connector is a remote MCP server over SSE: GET ERP_MCP_URL streams events;
// the first is an "endpoint" giving a POST URL for JSON-RPC; responses arrive
// back on the SSE stream. Auth = the ?key in the URL (set as a Railway env var).
const ERP_ITEM_QUERY = process.env.ERP_ITEM_QUERY || 'FOR EACH item NO-LOCK WHERE company_it = "ASPL" AND item <> ""';

async function withErpSession(fn) {
  const sseUrl = process.env.ERP_MCP_URL;
  if (!sseUrl) throw new Error('ERP_MCP_URL is not set');
  const origin = new URL(sseUrl).origin;
  const ac = new AbortController();
  const res = await fetch(sseUrl, { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
  if (!res.ok || !res.body) throw new Error('ERP SSE connect failed (' + res.status + ')');

  let postUrl = null, nextId = 1;
  const pending = new Map();
  let onEndpoint; const endpointReady = new Promise(r => { onEndpoint = r; });

  // Background reader: parse SSE frames, resolve JSON-RPC responses by id.
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r/g, '');   // normalize CRLF → LF
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = 'message', data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (ev === 'endpoint') { postUrl = origin + data; onEndpoint(); }
          else if (ev === 'message' && data) {
            try { const m = JSON.parse(data); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch (_) {}
          }
        }
      }
    } catch (_) { /* aborted or closed */ }
  })();

  const withTimeout = () => new Promise((_, rej) => setTimeout(() => rej(new Error('ERP request timed out')), 90000));
  async function rpc(method, params) {
    const id = nextId++;
    const resp = new Promise(resolve => pending.set(id, resolve));
    const r = await fetch(postUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (r.status !== 202 && !r.ok) throw new Error('ERP POST ' + method + ' failed (' + r.status + ')');
    return Promise.race([resp, withTimeout()]);
  }
  async function notify(method) {
    await fetch(postUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method, params: {} }) });
  }

  try {
    await Promise.race([endpointReady, withTimeout()]);
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'asp-warehouse', version: '1.0' } });
    await notify('notifications/initialized');
    return await fn(rpc);
  } finally {
    try { ac.abort(); } catch (_) {}
  }
}

// Pull the records array out of one dq_read MCP response.
function erpRecordsFrom(m) {
  if (m.error) throw new Error(m.error.message || 'dq_read error');
  const txt = m.result && m.result.content && m.result.content[0] && m.result.content[0].text;
  const parsed = txt ? JSON.parse(txt) : (m.result && m.result.structuredContent) || {};
  return parsed.records || [];
}

// ERP-ONE word-wraps descriptions into 30-char segments. Rejoin: a space where a
// segment ended before 30 chars (wrapped at a real space), nothing where it
// filled the full 30 (a mid-word hard chop). Reproduces the original text.
function rejoinDescr(descr) {
  const arr = Array.isArray(descr) ? descr : [descr];
  const segs = [];
  for (const s of arr) { const v = (s == null ? '' : String(s)); if (v === '') break; segs.push(v); }
  let out = '';
  for (let k = 0; k < segs.length; k++) {
    if (k > 0 && segs[k - 1].length < 30) out += ' ';
    out += segs[k];
  }
  return out.trim();
}

// Full paginated item pull for the weekly parts-description sync.
async function erpFetchItems(query, columns) {
  return withErpSession(async (rpc) => {
    const items = [];
    const PAGE = 5000;
    for (let skip = 0; skip <= 200000; skip += PAGE) {
      const recs = erpRecordsFrom(await rpc('tools/call', { name: 'dq_read', arguments: { query, columns, skip, take: PAGE } }));
      for (const rec of recs) {
        const code = String(rec.item || '').trim();
        if (!code) continue;
        items.push({ code, description: rejoinDescr(rec.descr) });
      }
      if (recs.length < PAGE) break;
    }
    return items;
  });
}

// Pull the full item list from the ERP and replace the description set.
async function refreshPartsFromErp() {
  if (!process.env.ERP_MCP_URL) return { skipped: true, reason: 'ERP_MCP_URL not set' };
  let items;
  try { items = await erpFetchItems(ERP_ITEM_QUERY, 'item,descr'); }
  catch (e) { return { ok: false, error: (e && e.message) ? e.message : 'ERP query failed' }; }
  if (!items.length) return { ok: false, error: 'ERP returned no items' };
  return await replacePartDescriptions(items);
}

// One refresh entry point: query the ERP directly if configured, else fall back
// to a published CSV URL.
async function runWeeklyRefresh() {
  if (process.env.ERP_MCP_URL) return await refreshPartsFromErp();
  return await refreshPartsFromUrl();
}

// The weekly Railway worker: fetch the published CSV and reload descriptions.
async function refreshPartsFromUrl() {
  const { rows } = await pool.query('SELECT source_url FROM part_meta WHERE id = 1');
  const url = rows.length ? (rows[0].source_url || '') : '';
  if (!url) return { skipped: true, reason: 'no source URL set' };
  let text = '';
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: 'fetch returned ' + r.status };
    text = await r.text();
  } catch (e) { return { ok: false, error: (e && e.message) ? e.message : 'fetch failed' }; }
  const items = parseSkuCsv(text);
  if (!items.length) return { ok: false, error: 'no rows parsed from the CSV at that URL' };
  return await replacePartDescriptions(items);
}

// Manager sets the weekly-refresh source URL (where the published CSV lives).
async function setPartSourceUrl(who, url) {
  if (!isManager(who)) return { error: 'Manager only' };
  const u = String(url || '').trim();
  if (u && !/^https?:\/\//i.test(u)) return { error: 'Enter a full http(s) URL, or leave blank to turn auto-refresh off.' };
  await pool.query('UPDATE part_meta SET source_url = $1 WHERE id = 1', [u || null]);
  return { ok: true, sourceUrl: u };
}

// Manager-triggered "run the refresh now" (test without waiting for Saturday).
async function refreshPartsNow(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  return await runWeeklyRefresh();
}

async function getPartImportInfo(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  const { rows } = await pool.query('SELECT token, last_import, count, source_url, last_auto FROM part_meta WHERE id = 1');
  const m = rows[0] || {};
  return {
    count: m.count || 0, lastImport: m.last_import || null, token: m.token || '',
    sourceUrl: m.source_url || '', lastAuto: m.last_auto || null,
    erpConfigured: !!process.env.ERP_MCP_URL, erpQuery: ERP_ITEM_QUERY,
  };
}

// Preview helper: look up one description (for the on-screen label preview).
async function lookupPart(who, code) {
  if (!who) return { error: 'Not authorized' };
  const c = String(code || '').trim();
  let photoHidden = false;
  if (c) {
    const { rows } = await pool.query('SELECT 1 FROM photo_hidden WHERE code = lower($1) LIMIT 1', [c]);
    photoHidden = rows.length > 0;
  }
  return { description: await lookupDescription(code), photoHidden };
}

// Manager: hide (or restore) the website photo for a part whose photo is wrong.
async function setPhotoHidden(who, body) {
  if (!isManager(who)) return { error: 'Only a manager can hide photos.' };
  const c = String((body && body.code) || '').trim();
  if (!c) return { error: 'No part number.' };
  const hide = !!(body && body.hidden);
  if (hide) {
    await pool.query(
      'INSERT INTO photo_hidden (code, hidden_by) VALUES (lower($1), $2) ON CONFLICT (code) DO UPDATE SET hidden_by = $2, ts = now()',
      [c, who.name || null]);
  } else {
    await pool.query('DELETE FROM photo_hidden WHERE code = lower($1)', [c]);
  }
  return { ok: true, code: c, photoHidden: hide };
}

// ----- Cloud printing (Zebra SendFileToPrinter) -----
async function getCloudConfig() {
  const { rows } = await pool.query('SELECT api_key, tenant_id, serial, enabled, daily_limit FROM cloud_print WHERE id = 1');
  return rows[0] || {};
}
// Cloud calls used so far today (US Pacific) — one print_jobs row per call.
async function printCallsToday() {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM print_jobs WHERE (created_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date");
  return rows[0].n;
}
// Account-level cloud config (the per-printer serial is resolved separately).
function cloudConfigured(cfg) {
  return !!(cfg && cfg.enabled && cfg.api_key && cfg.tenant_id);
}

// ----- Printers (multiple Zebra cloud printers; each device picks one) -----
async function listPrinters() {
  const { rows } = await pool.query('SELECT id, name, serial FROM printers ORDER BY sort_order, id');
  return rows;
}
async function getPrinters(who) {
  if (!who) return { error: 'Please sign in.' };
  const mgr = isManager(who);
  const rows = await listPrinters();
  return { printers: rows.map(p => mgr ? { id: p.id, name: p.name, serial: p.serial } : { id: p.id, name: p.name }) };
}
// Serial for the chosen printer (by id); else the first printer; else the legacy
// single serial on cloud_print.
async function resolvePrinterSerial(printerId) {
  const pid = cleanInt(printerId);
  if (pid != null) {
    const { rows } = await pool.query('SELECT serial FROM printers WHERE id = $1', [pid]);
    if (rows.length && rows[0].serial) return rows[0].serial;
  }
  const { rows } = await pool.query('SELECT serial FROM printers ORDER BY sort_order, id LIMIT 1');
  if (rows.length && rows[0].serial) return rows[0].serial;
  const cfg = await getCloudConfig();
  return cfg.serial || '';
}
async function addPrinter(who, p) {
  if (!isManager(who)) return { error: 'Manager only' };
  p = p || {};
  const name = String(p.name || '').trim().slice(0, 60);
  const serial = String(p.serial || '').trim().slice(0, 120);
  if (!name) return { error: 'Printer name is required' };
  if (!serial) return { error: 'Printer serial is required' };
  const { rows: mx } = await pool.query('SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM printers');
  await pool.query('INSERT INTO printers (name, serial, sort_order) VALUES ($1, $2, $3)', [name, serial, mx[0].n]);
  return { ok: true };
}
async function updatePrinter(who, p) {
  if (!isManager(who)) return { error: 'Manager only' };
  p = p || {};
  const id = cleanInt(p.id);
  const name = String(p.name || '').trim().slice(0, 60);
  const serial = String(p.serial || '').trim().slice(0, 120);
  if (id === null) return { error: 'Bad printer id' };
  if (!name || !serial) return { error: 'Name and serial are required' };
  const { rowCount } = await pool.query('UPDATE printers SET name=$1, serial=$2 WHERE id=$3', [name, serial, id]);
  if (!rowCount) return { error: 'Printer not found' };
  return { ok: true };
}
async function removePrinter(who, id) {
  if (!isManager(who)) return { error: 'Manager only' };
  const pid = cleanInt(id);
  if (pid === null) return { error: 'Bad printer id' };
  await pool.query('DELETE FROM printers WHERE id = $1', [pid]);
  return { ok: true };
}

// POST the label (ZPL) to Zebra's cloud, which relays it to the chosen printer.
async function sendViaCloud(cfg, zpl, serial) {
  try {
    const form = new FormData();
    form.append('sn', serial);
    form.append('zpl_file', new Blob([zpl], { type: 'text/plain' }), 'label.zpl');
    const r = await fetch('https://api.zebra.com/v2/devices/printers/send', {
      method: 'POST',
      headers: { apikey: cfg.api_key, tenant: cfg.tenant_id },
      body: form
    });
    if (r.ok) return { ok: true };
    const txt = await r.text().catch(() => '');
    return { ok: false, error: 'Zebra cloud error ' + r.status + (txt ? ': ' + txt.slice(0, 160) : '') };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : 'cloud request failed' };
  }
}

// Manager-only settings. The API key is write-only — never sent back to the browser.
async function getCloudSettings(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  const cfg = await getCloudConfig();
  return { enabled: !!cfg.enabled, hasApiKey: !!cfg.api_key, tenant: cfg.tenant_id || '', dailyLimit: cfg.daily_limit != null ? cfg.daily_limit : null, printers: await listPrinters() };
}

// Manager sets/clears the daily cloud-call cap. Blank/0/negative = no cap.
async function setPrintDailyLimit(who, limit) {
  if (!isManager(who)) return { error: 'Manager only' };
  let val = cleanInt(limit);
  if (val == null || val <= 0) val = null;
  await pool.query('UPDATE cloud_print SET daily_limit = $1 WHERE id = 1', [val]);
  return { ok: true, dailyLimit: val };
}
async function setCloudSettings(who, body) {
  if (!isManager(who)) return { error: 'Manager only' };
  const tenant = String(body && body.tenant || '').trim().slice(0, 120);
  const enabled = !!(body && body.enabled);
  const newKey = (body && body.apiKey != null) ? String(body.apiKey).trim() : '';
  if (newKey) {
    await pool.query('UPDATE cloud_print SET api_key=$1, tenant_id=$2, enabled=$3, updated_at=now() WHERE id=1',
      [newKey.slice(0, 300), tenant, enabled]);
  } else {
    await pool.query('UPDATE cloud_print SET tenant_id=$1, enabled=$2, updated_at=now() WHERE id=1',
      [tenant, enabled]);
  }
  return await getCloudSettings(who);
}

// Bridge polls this: records a heartbeat, expires very old jobs (so a PC that
// was off for hours doesn't surprise-print a stack), and returns pending jobs.
async function printPoll(body) {
  if (!(await bridgeOk(body))) return { error: 'Unauthorized' };
  await pool.query('UPDATE print_bridge SET last_seen = now() WHERE id = 1');
  await pool.query(
    "UPDATE print_jobs SET status='expired', error='expired (older than 6h)' " +
    "WHERE status='pending' AND created_at < now() - interval '6 hours'");
  const { rows } = await pool.query(
    "SELECT id, zpl FROM print_jobs WHERE status='pending' ORDER BY id ASC LIMIT 25");
  return { jobs: rows };
}

async function printAck(body) {
  if (!(await bridgeOk(body))) return { error: 'Unauthorized' };
  const id = cleanInt(body.id);
  if (id === null) return { error: 'Bad job id' };
  if (body.ok) {
    await pool.query("UPDATE print_jobs SET status='printed', printed_at=now() WHERE id=$1", [id]);
  } else {
    await pool.query("UPDATE print_jobs SET status='error', error=$2 WHERE id=$1",
      [id, String(body.error || 'print failed').slice(0, 300)]);
  }
  return { ok: true };
}

// =================================================================
// HTTP server
// =================================================================

const app = express();
// Railway terminates TLS at an edge proxy, so the raw connection IP is always the
// proxy's. Trusting the proxy makes req.ip reflect the real client (from
// X-Forwarded-For) — needed so the login rate-limiter buckets per actual device,
// not per proxy (which would make the whole warehouse share one bucket).
app.set('trust proxy', true);
app.use(cors({ origin: true }));
// PWA posts JSON as text/plain (to avoid CORS preflight in the old setup).
// Accept any content-type and parse manually.
app.use(express.text({ type: '*/*', limit: '6mb' }));   // 6mb: large enough for the full SKU-description CSV import

// Serve the PWA static files. They live alongside index.js at the project root
// (matches the asp-bubbles-api GitHub repo layout). We serve only an explicit
// allow-list so server source files (index.js, package.json) aren't exposed.
const STATIC_FILES = [
  'index.html', 'tv.html', 'sw.js', 'manifest.json',
  'logo.svg', 'bubbles-icon.png',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'res-picking.png',
  'jsbarcode.min.js',
];

function sendStatic(res, name) {
  if (name === 'index.html' || name === 'tv.html' || name === 'sw.js') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  res.sendFile(path.join(__dirname, name));
}

app.get('/', (req, res) => sendStatic(res, 'index.html'));
// Clean URL for the always-on warehouse TV: /tv -> tv.html
app.get('/tv', (req, res) => sendStatic(res, 'tv.html'));
STATIC_FILES.forEach(name => {
  app.get('/' + name, (req, res) => sendStatic(res, name));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, app: 'action-spa-warehouse' });
});

/* ---------- Box Counter ---------- */
// Any signed-in user can view, count, and set thresholds.
// Pure date arithmetic on a 'YYYY-MM-DD' string (UTC, no timezone drift).
function addDaysStr(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// Box counting can happen ANY day (US Pacific tz). A count is only "needed" on
// Friday; a count entered on another day is recorded for that week's Friday —
// the most recent Friday on or before today ("friday of the past week"). Reports
// today/day-of-week, that count Friday, whether this cycle is already counted,
// and the next Friday.
async function boxCountMeta() {
  const { rows } = await pool.query(`
    SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD') AS today,
           EXTRACT(DOW FROM (now() AT TIME ZONE 'America/Los_Angeles'))::int AS dow,
           to_char((SELECT (max(last_counted_at) AT TIME ZONE 'America/Los_Angeles')::date
                      FROM box_sizes WHERE active = true), 'YYYY-MM-DD') AS last_count_date`);
  const today = rows[0].today;
  const dow = rows[0].dow;                       // 0=Sun … 6=Sat
  const lastCountDate = rows[0].last_count_date || null;
  const cd = boxCountDow();                       // the "count needed" weekday (default 5=Fri)
  const isCountDay = dow === cd;
  const countedToday = !!lastCountDate && lastCountDate === today;
  // The count-day this count belongs to = most recent count-day on/before today.
  const countDate = addDaysStr(today, -(((dow - cd) + 7) % 7));
  // This cycle is covered if the last count landed on/after that count-day.
  const countedThisCycle = !!lastCountDate && lastCountDate >= countDate;
  const nextCountDate = addDaysStr(today, isCountDay ? 7 : (((cd - dow) + 7) % 7));
  return { today, dow, isCountDay, countDayName: DAY_NAMES[cd], countedToday, countDate, countedThisCycle, lastCountDate, nextCountDate };
}

async function getBoxSizes(who) {
  if (!who) return { error: 'Not authorized' };
  const { rows } = await pool.query(
    `SELECT id, size, quantity, low_threshold AS "lowThreshold", disregarded,
            last_counted_by AS "lastCountedBy", sort_order AS "sortOrder",
            last_counted_at AS "lastCountedAt"
       FROM box_sizes WHERE active = true ORDER BY sort_order, id`);
  return { boxSizes: rows, boxMeta: await boxCountMeta() };
}

// Record a Box Counter activity entry (who did what). Never throws into the caller.
async function logBoxActivity(person, action, detail) {
  try {
    await pool.query(
      'INSERT INTO box_activity (person, action, detail) VALUES ($1, $2, $3)',
      [String(person || '').slice(0, 80), String(action || '').slice(0, 32), String(detail || '').slice(0, 300)]);
  } catch (e) { console.warn('box_activity log failed:', e && e.message); }
}

// Recent Box Counter activity (newest first), for the in-app Activity tab.
async function getBoxActivity(who) {
  if (!who) return { error: 'Not authorized' };
  const { rows } = await pool.query(
    `SELECT person, action, detail, to_char(ts AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS day,
            to_char(ts AT TIME ZONE 'America/Los_Angeles', 'HH12:MI AM') AS time
       FROM box_activity ORDER BY ts DESC LIMIT 200`);
  return { boxActivity: rows };
}

// Save a Friday count: each provided count becomes the new current inventory.
// Email the manager about box sizes now at/below their low threshold. No-op
// unless email is configured (RESEND_API_KEY + MANAGER_EMAIL). Only sizes that
// HAVE a low threshold set are alerted — that threshold is the "certain quantity".
async function emailLowStock() {
  const { rows } = await pool.query(
    `SELECT size, quantity, low_threshold
       FROM box_sizes
      WHERE active = true AND disregarded = false AND low_threshold IS NOT NULL AND quantity <= low_threshold
      ORDER BY quantity, sort_order, id`);
  if (!rows.length) return;
  const lines = rows.map(r => {
    const q = Number(r.quantity);
    return q === 0
      ? `• ${r.size} — OUT of stock (alert set at ${r.low_threshold} or below)`
      : `• ${r.size} — ${q} left (alert set at ${r.low_threshold} or below)`;
  });
  const n = rows.length;
  const subject = `Box Counter: ${n} box size${n === 1 ? '' : 's'} low on stock`;
  const body = `After the latest box count, these packaging box sizes are at or below their low alert:\n\n`
    + lines.join('\n')
    + `\n\nReorder as needed. (Set or change a size's low alert in the app: Box Counter → Sizes & inventory.)`;
  // Prefer Gmail (the chosen path); fall back to Resend/log if Gmail isn't configured.
  if (GMAIL_USER && GMAIL_APP_PASSWORD && MANAGER_EMAIL) await sendGmail(MANAGER_EMAIL, subject, body);
  else await notifyManager(subject, body);
}

async function saveBoxCount(who, body) {
  if (!who) return { error: 'Not authorized' };
  const meta = await boxCountMeta();   // any day is allowed; the count is for meta.countDate
  const counts = Array.isArray(body && body.counts) ? body.counts : [];
  const by = ((body && body.countedBy) ? String(body.countedBy) : '').trim().slice(0, 80) || (who.name || '');
  let saved = 0;
  for (const c of counts) {
    const id = parseInt(c && c.id, 10);
    const q = parseInt(c && c.counted, 10);
    if (!Number.isFinite(id) || !Number.isFinite(q) || q < 0) continue;
    await pool.query(
      'UPDATE box_sizes SET quantity = $1, last_counted_at = now(), last_counted_by = $2 WHERE id = $3 AND active = true',
      [q, by, id]);
    saved++;
  }
  if (saved) {
    const forDay = meta.isCountDay ? '' : ` (weekly count for ${meta.countDate})`;
    await logBoxActivity(by, 'count', `Counted ${saved} box size${saved === 1 ? '' : 's'}${forDay}`);
    try { await emailLowStock(); } catch (e) { console.warn('low-stock email failed:', e && e.message); }
  }
  const data = await getBoxSizes(who);
  data.saved = saved;
  return data;
}

// Edit a size's current quantity and/or its low threshold (null clears it).
async function updateBoxSize(who, body) {
  if (!who) return { error: 'Not authorized' };
  const id = parseInt(body && body.id, 10);
  if (!Number.isFinite(id)) return { error: 'Bad id.' };
  const { rows: szRows } = await pool.query('SELECT size FROM box_sizes WHERE id = $1', [id]);
  const size = szRows.length ? szRows[0].size : ('#' + id);
  const person = (who && who.name) || '';
  if (body && 'lowThreshold' in body) {
    let t = body.lowThreshold;
    t = (t === null || t === '') ? null : parseInt(t, 10);
    if (t !== null && (!Number.isFinite(t) || t < 0)) return { error: 'Threshold must be 0 or more.' };
    await pool.query('UPDATE box_sizes SET low_threshold = $1 WHERE id = $2', [t, id]);
    await logBoxActivity(person, 'threshold', `${size}: low alert set to ${t === null ? 'none' : t}`);
  }
  if (body && 'quantity' in body) {
    const q = parseInt(body.quantity, 10);
    if (!Number.isFinite(q) || q < 0) return { error: 'Quantity must be 0 or more.' };
    await pool.query('UPDATE box_sizes SET quantity = $1 WHERE id = $2', [q, id]);
    await logBoxActivity(person, 'qty', `${size}: quantity set to ${q}`);
  }
  return await getBoxSizes(who);
}

// Remove (or restore) a box size — managers only. Soft delete: active=false
// hides it from both tabs but keeps the row.
async function setBoxSizeActive(who, id, active) {
  if (!isManager(who)) return { error: 'Only a manager can remove box sizes.' };
  const bid = parseInt(id, 10);
  if (!Number.isFinite(bid)) return { error: 'Bad id.' };
  await pool.query('UPDATE box_sizes SET active = $1 WHERE id = $2', [!!active, bid]);
  return await getBoxSizes(who);
}

// Disregard (or restore) a size — it no longer needs counting and is hidden from
// the Count tab + low-stock alerts, but is kept (restorable). Any signed-in user
// (the counter can disregard a size that doesn't matter; managers can too).
async function setBoxDisregarded(who, id, disregarded) {
  if (!who) return { error: 'Not authorized' };
  const bid = parseInt(id, 10);
  if (!Number.isFinite(bid)) return { error: 'Bad id.' };
  await pool.query('UPDATE box_sizes SET disregarded = $1 WHERE id = $2', [!!disregarded, bid]);
  return await getBoxSizes(who);
}

/* ---------- Imported Resources (curated links) ---------- */
// Any signed-in user can see the links.
async function getResources(who) {
  if (!who) return { error: 'Not authorized' };
  const { rows } = await pool.query(
    `SELECT id, name, url, category, description, icon
       FROM resource_links WHERE active = true ORDER BY sort_order, id`);
  return { resources: rows };
}

// Default a scheme-less address to https:// so a plain "example.com" still works
// and a "javascript:" address can never become a live link.
function normalizeUrl(u) {
  let s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s.slice(0, 500);
}

// Validate + clean a link from the editor form. Returns {resource} or {error}.
function cleanResource(r) {
  r = r || {};
  const name = String(r.name || '').trim().slice(0, 120);
  const url = normalizeUrl(r.url);
  if (!name) return { error: 'Give the link a name.' };
  if (!url) return { error: 'Enter a web address (URL).' };
  // Icon is either a short emoji OR an image reference (a served path like
  // "res-picking.png", an https URL, or a data:image URI) — allow the longer form.
  let icon = String(r.icon || '').trim();
  const isImg = /^(data:image\/|https?:\/\/|\/)/i.test(icon) || /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(icon);
  icon = icon ? (isImg ? icon.slice(0, 20000) : icon.slice(0, 16)) : '🔗';
  return {
    resource: {
      name,
      url,
      category: (String(r.category || '').trim() || 'Links').slice(0, 80),
      description: String(r.description || '').trim().slice(0, 500),
      icon,
    },
  };
}

async function addResource(who, body) {
  if (!isManager(who)) return { error: 'Only a manager can add links.' };
  const c = cleanResource(body && body.resource);
  if (c.error) return { error: c.error };
  const r = c.resource;
  const { rows: mx } = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM resource_links');
  await pool.query(
    `INSERT INTO resource_links (name, url, category, description, icon, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [r.name, r.url, r.category, r.description, r.icon, mx[0].n, (who.name || '')]);
  return await getResources(who);
}

async function updateResource(who, body) {
  if (!isManager(who)) return { error: 'Only a manager can edit links.' };
  const id = parseInt(body && body.resource && body.resource.id, 10);
  if (!Number.isFinite(id)) return { error: 'Bad id.' };
  const c = cleanResource(body && body.resource);
  if (c.error) return { error: c.error };
  const r = c.resource;
  await pool.query(
    `UPDATE resource_links SET name = $1, url = $2, category = $3, description = $4, icon = $5 WHERE id = $6`,
    [r.name, r.url, r.category, r.description, r.icon, id]);
  return await getResources(who);
}

async function deleteResource(who, id) {
  if (!isManager(who)) return { error: 'Only a manager can remove links.' };
  const rid = parseInt(id, 10);
  if (!Number.isFinite(rid)) return { error: 'Bad id.' };
  await pool.query('DELETE FROM resource_links WHERE id = $1', [rid]);
  return await getResources(who);
}

/* ---------- Employee of the Month ---------- */
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function dowOfYmd(ymd) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); } // 0=Sun … 6=Sat
function monthFirstStr(y, m) { return `${y}-${String(m).padStart(2, '0')}-01`; }
function ymKey(y, m) { return `${y}-${String(m).padStart(2, '0')}`; }
function monthLabel(y, m) { return `${MONTH_NAMES[m - 1]} ${y}`; }
function prevYM(y, m) { return m === 1 ? [y - 1, 12] : [y, m - 1]; }
function nextYM(y, m) { return m === 12 ? [y + 1, 1] : [y, m + 1]; }
// First weekday (Mon–Fri) on/after the 1st of the month.
function firstWeekdayOfMonth(y, m) {
  const first = monthFirstStr(y, m);
  const dow = dowOfYmd(first);
  if (dow === 0) return addDaysStr(first, 1);   // Sunday → Monday (the 2nd)
  if (dow === 6) return addDaysStr(first, 2);   // Saturday → Monday (the 3rd)
  return first;                                 // the 1st is already a weekday
}
// The Mon–Fri work week that CONTAINS the month's first weekday. (If the 1st is,
// say, a Friday, the window is that whole week — it may start in the prior month.)
function votingWeekForMonth(y, m) {
  const fw = firstWeekdayOfMonth(y, m);
  const monday = addDaysStr(fw, -(dowOfYmd(fw) - 1));
  return { monday, friday: addDaysStr(monday, 4) };
}

// Voting window = the work week containing the new month's first work-day; the
// vote decides the month that just ended. "Focus" = the open window if open,
// otherwise the next upcoming window. period = award month 'YYYY-MM'.
async function eomMeta() {
  const today = (await pool.query(
    `SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
  const [y, m] = today.split('-').map(Number);
  const W = votingWeekForMonth(y, m);
  const [ny, nm] = nextYM(y, m);
  const Wn = votingWeekForMonth(ny, nm);   // next month's window can start in the last days of this month
  let focus, cy, cm, votingOpen;
  if (today >= W.monday && today <= W.friday) { focus = W; cy = y; cm = m; votingOpen = true; }
  else if (today >= Wn.monday && today <= Wn.friday) { focus = Wn; cy = ny; cm = nm; votingOpen = true; }
  else if (today < W.monday) { focus = W; cy = y; cm = m; votingOpen = false; }
  else { focus = Wn; cy = ny; cm = nm; votingOpen = false; }
  const [ay, am] = prevYM(cy, cm);
  return { today, votingOpen, opensOn: focus.monday, closesOn: focus.friday,
           awardPeriod: ymKey(ay, am), awardLabel: monthLabel(ay, am) };
}

// Resolve a period's winner from its tally + an optional manager override.
// tied = two or more share the top vote count (so a manager should pick).
function resolveEomWinner(tally, overrideName) {
  if (!tally || !tally.length) {
    return overrideName ? { name: overrideName, votes: 0, overridden: true, tied: false } : null;
  }
  const top = tally[0].votes;
  const tied = tally.filter(t => t.votes === top).length > 1;
  if (overrideName) {
    const row = tally.find(t => t.name === overrideName);
    return { name: overrideName, votes: row ? row.votes : 0, overridden: true, tied };
  }
  return { name: tally[0].name, votes: top, overridden: false, tied };
}
// All manager winner-overrides as a { period: winner_name } map.
async function eomOverrides() {
  const { rows } = await pool.query('SELECT period, winner_name FROM eom_winners');
  const m = {}; rows.forEach(r => { m[r.period] = r.winner_name; }); return m;
}

async function getEom(who) {
  if (!who) return { error: 'Not authorized' };
  const meta = await eomMeta();
  const { rows: emps } = await pool.query(
    'SELECT name FROM employees WHERE active = true AND voting_eligible = true ORDER BY name');
  const candidates = emps.map(e => e.name);
  const { rows: tally } = await pool.query(
    `SELECT choice_name AS name, COUNT(*)::int AS votes FROM eom_votes
       WHERE period = $1 GROUP BY choice_name ORDER BY votes DESC, choice_name`, [meta.awardPeriod]);
  const { rows: mine } = await pool.query(
    'SELECT choice_name FROM eom_votes WHERE period = $1 AND voter_name = $2', [meta.awardPeriod, who.name]);
  const { rows: vc } = await pool.query(
    'SELECT COUNT(DISTINCT voter_name)::int AS n FROM eom_votes WHERE period = $1', [meta.awardPeriod]);
  // Most-recent finished result (respecting a manager winner-override if set).
  const { rows: lastP } = await pool.query('SELECT period FROM eom_votes ORDER BY period DESC LIMIT 1');
  let lastResult = null;
  if (lastP.length) {
    const lp = lastP[0].period;
    const { rows: ltally } = await pool.query(
      `SELECT choice_name AS name, COUNT(*)::int AS votes FROM eom_votes
         WHERE period = $1 GROUP BY choice_name ORDER BY votes DESC, choice_name`, [lp]);
    const { rows: ov } = await pool.query('SELECT winner_name FROM eom_winners WHERE period = $1', [lp]);
    const w = resolveEomWinner(ltally, ov.length ? ov[0].winner_name : null);
    if (w) {
      const [ly, lm] = lp.split('-').map(Number);
      lastResult = { period: lp, label: `${MONTH_NAMES[lm - 1]} ${ly}`, name: w.name, votes: w.votes };
    }
  }
  return {
    ...meta,
    canVote: who.role === 'employee',
    voterName: who.name,
    candidates,
    tally,
    mine: { voted: mine.length > 0, choice: mine.length ? mine[0].choice_name : null },
    progress: { voted: vc[0].n, total: candidates.length },
    lastResult,
  };
}

async function castEomVote(who, choice) {
  if (!who) return { error: 'Not authorized' };
  if (who.role !== 'employee') return { error: 'Only warehouse employees can vote.' };
  const meta = await eomMeta();
  if (!meta.votingOpen) return { error: 'Voting is not open right now.' };
  const pick = String(choice || '').trim();
  if (!pick) return { error: 'Pick a coworker.' };
  if (pick === who.name) return { error: "You can't vote for yourself." };
  const { rows: ok } = await pool.query(
    'SELECT 1 FROM employees WHERE name = $1 AND active = true AND voting_eligible = true', [pick]);
  if (!ok.length) return { error: "That person isn't in the voting list." };
  try {
    await pool.query('INSERT INTO eom_votes (period, voter_name, choice_name) VALUES ($1, $2, $3)',
      [meta.awardPeriod, who.name, pick]);
  } catch (e) {
    if (e.code === '23505') return { error: "You've already voted this month." };
    throw e;
  }
  return await getEom(who);
}

// Past Employee of the Month results. Everyone sees the vote counts per month
// (in a dropdown); only managers get the per-voter ballots (who voted for whom).
// Employees can't see the currently-open period until it closes.
async function getEomLog(who) {
  if (!who) return { error: 'Not authorized' };
  const meta = await eomMeta();
  const isMgr = isManager(who);
  const openPeriod = meta.votingOpen ? meta.awardPeriod : null;
  const { rows: prows } = await pool.query('SELECT DISTINCT period FROM eom_votes ORDER BY period DESC');
  const overrides = await eomOverrides();
  const periods = [];
  for (const pr of prows) {
    const p = pr.period;
    if (!isMgr && openPeriod && p === openPeriod) continue;   // hide in-progress month from employees
    const { rows: tally } = await pool.query(
      `SELECT choice_name AS name, COUNT(*)::int AS votes FROM eom_votes
         WHERE period = $1 GROUP BY choice_name ORDER BY votes DESC, choice_name`, [p]);
    const [y, m] = p.split('-').map(Number);
    const w = resolveEomWinner(tally, overrides[p]);
    const entry = { period: p, label: monthLabel(y, m),
      winner: w ? { name: w.name, votes: w.votes, overridden: w.overridden, tied: w.tied } : null, tally };
    if (isMgr) {
      const { rows: ballots } = await pool.query(
        'SELECT voter_name AS voter, choice_name AS choice FROM eom_votes WHERE period = $1 ORDER BY voter_name', [p]);
      entry.ballots = ballots;
    }
    periods.push(entry);
  }
  return { periods, isManager: isMgr };
}

// ---- Manager tools: edit votes + pick a tie-breaking winner ----
async function getEomAdmin(who, period) {
  if (!isManager(who)) return { error: 'Only a manager can manage votes.' };
  const meta = await eomMeta();
  const { rows: prows } = await pool.query('SELECT DISTINCT period FROM eom_votes ORDER BY period DESC');
  let periodSet = prows.map(r => r.period);
  if (!periodSet.includes(meta.awardPeriod)) periodSet.push(meta.awardPeriod);   // current month even if no votes yet
  periodSet = Array.from(new Set(periodSet)).sort().reverse();
  const sel = (period && periodSet.includes(period)) ? period
    : (periodSet.includes(meta.awardPeriod) ? meta.awardPeriod : periodSet[0]);
  const periods = periodSet.map(p => { const [y, m] = p.split('-').map(Number); return { period: p, label: monthLabel(y, m) }; });
  const { rows: emps } = await pool.query(
    'SELECT name FROM employees WHERE active = true AND voting_eligible = true ORDER BY name');
  const candidates = emps.map(e => e.name);
  const { rows: tally } = await pool.query(
    `SELECT choice_name AS name, COUNT(*)::int AS votes FROM eom_votes
       WHERE period = $1 GROUP BY choice_name ORDER BY votes DESC, choice_name`, [sel]);
  const { rows: ballots } = await pool.query(
    'SELECT voter_name AS voter, choice_name AS choice FROM eom_votes WHERE period = $1 ORDER BY voter_name', [sel]);
  const { rows: ov } = await pool.query('SELECT winner_name FROM eom_winners WHERE period = $1', [sel]);
  const overrideName = ov.length ? ov[0].winner_name : null;
  const winner = resolveEomWinner(tally, overrideName);
  const voters = ballots.map(b => b.voter);
  const nonVoters = candidates.filter(n => !voters.includes(n));
  const [sy, sm] = sel.split('-').map(Number);
  return { period: sel, label: monthLabel(sy, sm), periods, candidates, tally, ballots,
           winner, overrideName, nonVoters, votingOpen: meta.votingOpen && sel === meta.awardPeriod };
}

// Add or change a vote (upsert on period+voter). Manager only.
async function setEomVote(who, body) {
  if (!isManager(who)) return { error: 'Only a manager can edit votes.' };
  const period = String((body && body.period) || '').trim();
  const voter = String((body && body.voter) || '').trim().slice(0, 120);
  const choice = String((body && body.choice) || '').trim().slice(0, 120);
  if (!/^\d{4}-\d{2}$/.test(period)) return { error: 'Bad period.' };
  if (!voter) return { error: 'Pick who is voting.' };
  if (!choice) return { error: 'Pick who the vote is for.' };
  if (voter === choice) return { error: "A person can't vote for themselves." };
  await pool.query(
    `INSERT INTO eom_votes (period, voter_name, choice_name) VALUES ($1, $2, $3)
       ON CONFLICT (period, voter_name) DO UPDATE SET choice_name = EXCLUDED.choice_name`,
    [period, voter, choice]);
  return await getEomAdmin(who, period);
}

async function removeEomVote(who, body) {
  if (!isManager(who)) return { error: 'Only a manager can remove votes.' };
  const period = String((body && body.period) || '').trim();
  const voter = String((body && body.voter) || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period) || !voter) return { error: 'Bad request.' };
  await pool.query('DELETE FROM eom_votes WHERE period = $1 AND voter_name = $2', [period, voter]);
  return await getEomAdmin(who, period);
}

// Pick the winner (tie-break / correction). Empty winner clears the override so
// the winner reverts to the top vote-getter.
async function setEomWinner(who, body) {
  if (!isManager(who)) return { error: 'Only a manager can pick the winner.' };
  const period = String((body && body.period) || '').trim();
  const winner = String((body && body.winner) || '').trim().slice(0, 120);
  if (!/^\d{4}-\d{2}$/.test(period)) return { error: 'Bad period.' };
  if (!winner) {
    await pool.query('DELETE FROM eom_winners WHERE period = $1', [period]);
  } else {
    const { rows: ok } = await pool.query(
      'SELECT 1 FROM eom_votes WHERE period = $1 AND choice_name = $2 LIMIT 1', [period, winner]);
    if (!ok.length) return { error: 'That person got no votes this month.' };
    await pool.query(
      `INSERT INTO eom_winners (period, winner_name, set_by) VALUES ($1, $2, $3)
         ON CONFLICT (period) DO UPDATE SET winner_name = EXCLUDED.winner_name, set_by = EXCLUDED.set_by, ts = now()`,
      [period, winner, who.name || '']);
  }
  return await getEomAdmin(who, period);
}

// =================================================================
// Push notifications (Web Push)
// =================================================================
let VAPID_PUBLIC = '';
let vapidReady = false;

// Load (or generate + store) the server's VAPID keypair and configure web-push.
async function ensureVapid() {
  const { rows } = await pool.query('SELECT public_key, private_key, subject FROM push_keys WHERE id = 1');
  let row = rows[0];
  if (!row || !row.public_key || !row.private_key) {
    const keys = webpush.generateVAPIDKeys();
    const subject = alertEmail() ? ('mailto:' + alertEmail()) : 'mailto:notifications@actionspaparts.com';
    await pool.query(
      `INSERT INTO push_keys (id, public_key, private_key, subject) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET public_key = $1, private_key = $2, subject = $3`,
      [keys.publicKey, keys.privateKey, subject]);
    row = { public_key: keys.publicKey, private_key: keys.privateKey, subject };
    console.log('Schema: generated VAPID push keypair.');
  }
  webpush.setVapidDetails(row.subject, row.public_key, row.private_key);
  VAPID_PUBLIC = row.public_key;
  vapidReady = true;
}

// Public: the browser needs the VAPID public key to create a subscription.
async function getVapidPublicKey() {
  return { key: VAPID_PUBLIC || null };
}

// A device opts in: store its push subscription, tied to the logged-in person.
async function savePushSubscription(who, body) {
  if (!who) return { error: 'Not authorized' };
  const sub = body && body.sub;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return { error: 'Bad subscription' };
  }
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, subscriber, role, last_seen)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = $2, auth = $3, subscriber = $4, role = $5, last_seen = now()`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, who.name || null, who.role || null]);
  return { ok: true };
}

async function removePushSubscription(who, body) {
  const endpoint = body && body.endpoint;
  if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  return { ok: true };
}

// The master on/off switch (manager-controlled). Off = nothing is sent and
// employees don't see the per-device "enable" prompt.
async function notifyIsEnabled() {
  const { rows } = await pool.query('SELECT enabled FROM push_keys WHERE id = 1');
  return !!(rows.length && rows[0].enabled);
}

// How many devices are subscribed (for the manager UI), whether push is ready,
// and whether the feature is currently switched on.
async function getPushStatus(who) {
  if (!who) return { error: 'Not authorized' };
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM push_subscriptions');
  return { configured: vapidReady, devices: rows[0].n, enabled: await notifyIsEnabled() };
}

// Manager flips the whole feature on/off.
async function setNotifyEnabled(who, on) {
  if (!isManager(who)) return { error: 'Manager only' };
  await pool.query('UPDATE push_keys SET enabled = $1 WHERE id = 1', [!!on]);
  return { ok: true, enabled: !!on };
}

// Send a payload to a set of subscription rows; prune dead ones (404/410 = gone).
async function pushToSubs(rows, payload) {
  if (!vapidReady) return { sent: 0, failed: 0 };
  const data = JSON.stringify(payload);
  let sent = 0, failed = 0;
  for (const r of rows) {
    const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await webpush.sendNotification(sub, data);
      sent++;
    } catch (e) {
      failed++;
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [r.endpoint]).catch(() => {});
      }
    }
  }
  return { sent, failed };
}

// Manager fires a test notification to every subscribed device.
async function sendTestPush(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  if (!vapidReady) return { error: 'Push notifications are not set up on the server yet.' };
  if (!(await notifyIsEnabled())) return { error: 'Turn notifications on first.' };
  const { rows } = await pool.query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  if (!rows.length) return { error: 'No devices have enabled notifications yet. Tap “Enable notifications” on a scanner first.' };
  const res = await pushToSubs(rows, {
    title: 'Action Spa Warehouse',
    body: 'Test notification — if you can see this on the scanner, push works! 🎉',
    tag: 'asp-test',
    url: '/',
  });
  return { ok: true, ...res };
}

// Manager sends a custom one-off message to every subscribed device (e.g. "Truck
// is here", "Team huddle now"). Reuses the same delivery path as the test push.
async function broadcastPush(who, body) {
  if (!isManager(who)) return { error: 'Manager only' };
  if (!vapidReady) return { error: 'Push notifications are not set up on the server yet.' };
  if (!(await notifyIsEnabled())) return { error: 'Turn notifications on first.' };
  const msg = (body && typeof body.message === 'string') ? body.message.trim() : '';
  if (!msg) return { error: 'Type a message to send.' };
  if (msg.length > 300) return { error: 'Message is too long (max 300 characters).' };
  const { rows } = await pool.query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  if (!rows.length) return { error: 'No devices have enabled notifications yet.' };
  const res = await pushToSubs(rows, {
    title: 'Action Spa Warehouse',
    body: msg,
    tag: 'asp-broadcast',
    url: '/',
  });
  return { ok: true, ...res };
}

// ---------- Login rate limiting (brute-force protection) ----------
// The PIN pad is publicly reachable on the wall TV, so anyone could hammer it
// guessing a PIN (or an admin password). We throttle repeated FAILED logins per
// client IP. A successful login clears the counter, so legit users mistyping a
// PIN are unaffected in practice; an automated guesser trips the threshold and
// gets an escalating cooldown. In-memory is fine — Railway runs a single
// instance and the state only needs to survive a burst, not a restart.
// (Caveat: an attacker who rotates/spoofs X-Forwarded-For can sidestep an
// IP-based limit — inherent to any IP limiter; this stops casual/script abuse.)
const LOGIN_ACTIONS = new Set(['login', 'adminLogin']);
const LOGIN_WINDOW_MS = 5 * 60 * 1000;         // rolling window for counting failures
const LOGIN_MAX_FAILS = 12;                    // failures allowed in the window before a cooldown
const LOGIN_COOLDOWNS = [60, 120, 300, 600];   // escalating cooldown (seconds) each time it trips
const loginFails = new Map();                  // ip -> { times:number[], strikes:number, until:number }

function rlKey(req) {
  return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

// True (with retryAfter seconds) if this key is currently in a cooldown.
function loginRateBlocked(key) {
  const rec = loginFails.get(key);
  if (rec && rec.until && Date.now() < rec.until) {
    return { blocked: true, retryAfter: Math.ceil((rec.until - Date.now()) / 1000) };
  }
  return { blocked: false };
}

// Record the outcome of a login attempt. Success clears the key; enough failures
// inside the window start (or escalate) a cooldown.
function loginRateRecord(key, success) {
  const now = Date.now();
  if (success) { loginFails.delete(key); return; }
  let rec = loginFails.get(key);
  if (!rec) { rec = { times: [], strikes: 0, until: 0 }; loginFails.set(key, rec); }
  rec.times = rec.times.filter(t => now - t < LOGIN_WINDOW_MS);   // drop stale failures
  rec.times.push(now);
  if (rec.times.length >= LOGIN_MAX_FAILS) {
    const cd = LOGIN_COOLDOWNS[Math.min(rec.strikes, LOGIN_COOLDOWNS.length - 1)];
    rec.until = now + cd * 1000;
    rec.strikes += 1;
    rec.times = [];                                                // cooldown replaces the count
  }
  // Opportunistic cleanup so the Map can't grow unbounded from many stale IPs.
  if (loginFails.size > 500) {
    for (const [k, v] of loginFails) {
      if ((!v.until || v.until < now) && (!v.times.length || now - v.times[v.times.length - 1] > LOGIN_WINDOW_MS)) {
        loginFails.delete(k);
      }
    }
  }
}

app.post('/', async (req, res) => {
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Bad JSON body' });
  }
  const action = body.action;
  // Brute-force throttle: reject login attempts from an IP that's in cooldown
  // before we ever touch the DB. Returned as a normal {error} (status 200) so the
  // login UI shows the message instead of throwing on a non-2xx status.
  const rateLimited = LOGIN_ACTIONS.has(action);
  if (rateLimited) {
    const blk = loginRateBlocked(rlKey(req));
    if (blk.blocked) {
      return res.json({ error: `Too many attempts. Please wait ${blk.retryAfter}s and try again.` });
    }
  }
  try {
    let out;
    // Public actions need no identity.
    switch (action) {
      case 'login':       out = await login(body.pin); break;
      case 'getPublic':   out = await getPublic(); break;
      case 'getVersion':  out = { version: APP_VERSION }; break;
      case 'getVapidPublicKey': out = await getVapidPublicKey(); break;
      case 'importPartDescriptions': out = await importPartDescriptions(body); break;
      case 'adminLogin':  out = await adminLogin(body); break;
      case 'adminSignup': out = await adminSignup(body); break;
      case 'adminLogout': out = await adminLogout(body); break;
      // Print bridge (warehouse PC) — authenticated by PRINT_BRIDGE_TOKEN, not a user.
      case 'printPoll':   out = await printPoll(body); break;
      case 'printAck':    out = await printAck(body); break;
    }
    // Everything else resolves the caller once (admin token, employee PIN, or
    // break-glass Manager PIN) and passes that identity to the handler.
    if (out === undefined) {
      const who = await resolveAuth(body);
      switch (action) {
        case 'getData':   out = await getData(who); break;
        case 'award':     out = await awardBubbles(who, body.name, body.metric, body.amount); break;
        case 'awardTeam': out = await awardTeam(who, body.metric, body.amount); break;
        case 'undo':      out = await reverseAward(who, body.name, body.metric, body.amount); break;
        case 'deleteAward': out = await deleteAward(who, body.id); break;
        case 'request':   out = await requestRedemption(who, body.reward); break;
        case 'resolve':   out = await resolveRedemption(who, body.row, body.approve); break;
        case 'fulfill':   out = await fulfillRedemption(who, body.row); break;
        case 'requestMeetingCredit': out = await requestMeetingCredit(who); break;
        case 'resolveMeetingCredit': out = await resolveMeetingCredit(who, body.id, body.approve); break;
        // ----- Admin (manager only) -----
        case 'getAdmin':          out = await getAdmin(who); break;
        case 'addRule':           out = await addRule(who, body.rule); break;
        case 'updateRule':        out = await updateRule(who, body.rule); break;
        case 'setRuleActive':     out = await setRuleActive(who, body.id, body.active); break;
        case 'deleteRule':        out = await deleteRule(who, body.id); break;
        case 'addReward':         out = await addReward(who, body.reward); break;
        case 'updateReward':      out = await updateReward(who, body.reward); break;
        case 'setRewardActive':   out = await setRewardActive(who, body.id, body.active); break;
        case 'deleteReward':      out = await deleteReward(who, body.id); break;
        case 'addEmployee':       out = await addEmployee(who, body.employee); break;
        case 'updateEmployee':    out = await updateEmployee(who, body.employee); break;
        case 'setEmployeeActive': out = await setEmployeeActive(who, body.id, body.active); break;
        case 'setEmployeeChecklistEligible': out = await setEmployeeChecklistEligible(who, body.id, body.eligible); break;
        case 'setEmployeeVotingEligible':    out = await setEmployeeVotingEligible(who, body.id, body.eligible); break;
        case 'listAdmins':        out = await listAdmins(who); break;
        case 'addAdmin':          out = await addAdmin(who, body.admin); break;
        case 'updateAdmin':       out = await updateAdmin(who, body.admin); break;
        case 'setAdminActive':    out = await setAdminActive(who, body.id, body.active); break;
        case 'approveAdmin':      out = await approveAdmin(who, body.id); break;
        case 'denyAdmin':         out = await denyAdmin(who, body.id); break;
        // ----- End-of-day checklist -----
        case 'getChecklist':         out = await getChecklist(who); break;
        case 'startChecklist':       out = await startChecklist(who); break;
        case 'checkChecklistItem':   out = await checkChecklistItem(who, body.itemId, body.checked); break;
        case 'submitChecklist':      out = await submitChecklist(who); break;
        case 'getChecklistAdmin':    out = await getChecklistAdmin(who); break;
        case 'flagChecklistItem':    out = await flagChecklistItem(who, body); break;
        case 'unflagChecklistItem':  out = await unflagChecklistItem(who, body.itemId); break;
        case 'correctChecklistItem': out = await correctChecklistItem(who, body); break;
        case 'addChecklistTask':     out = await addChecklistTask(who, body.task); break;
        case 'updateChecklistTask':  out = await updateChecklistTask(who, body.task); break;
        case 'setChecklistTaskActive': out = await setChecklistTaskActive(who, body.id, body.active); break;
        case 'resetChecklist':       out = await resetChecklist(who); break;
        case 'reshuffleChecklist':   out = await reshuffleChecklist(who); break;
        case 'reassignChecklistRun': out = await reassignChecklistRun(who, body); break;
        case 'deleteChecklistRun':   out = await deleteChecklistRun(who, body.runId); break;
        case 'penalizeLateChecklist': out = await penalizeLateChecklist(who, body.runId); break;
        case 'resolveChecklistFlag': out = await resolveChecklistFlag(who, body.itemId, body.approve); break;
        // ----- Box Counter -----
        case 'getBoxSizes':   out = await getBoxSizes(who); break;
        case 'getBoxActivity': out = await getBoxActivity(who); break;
        case 'saveBoxCount':  out = await saveBoxCount(who, body); break;
        case 'updateBoxSize': out = await updateBoxSize(who, body); break;
        case 'setBoxSizeActive': out = await setBoxSizeActive(who, body.id, body.active); break;
        case 'setBoxDisregarded': out = await setBoxDisregarded(who, body.id, body.disregarded); break;
        // ----- Imported Resources (links) -----
        case 'getResources':    out = await getResources(who); break;
        case 'addResource':     out = await addResource(who, body); break;
        case 'updateResource':  out = await updateResource(who, body); break;
        case 'deleteResource':  out = await deleteResource(who, body.id); break;
        // ----- Employee of the Month -----
        case 'getEom':       out = await getEom(who); break;
        case 'castEomVote':  out = await castEomVote(who, body.choice); break;
        case 'getEomLog':    out = await getEomLog(who); break;
        case 'getEomAdmin':  out = await getEomAdmin(who, body.period); break;
        case 'setEomVote':   out = await setEomVote(who, body); break;
        case 'removeEomVote': out = await removeEomVote(who, body); break;
        case 'setEomWinner': out = await setEomWinner(who, body); break;
        // ----- Label Printer -----
        case 'enqueuePrint':   out = await enqueuePrint(who, body); break;
        case 'getPrintStatus': out = await getPrintStatus(who); break;
        case 'getCloudSettings': out = await getCloudSettings(who); break;
        case 'setCloudSettings': out = await setCloudSettings(who, body); break;
        case 'getPrintUsage':    out = await getPrintUsage(who); break;
        case 'getPrintLog':      out = await getPrintLog(who); break;
        case 'setPrintDailyLimit': out = await setPrintDailyLimit(who, body.limit); break;
        case 'getPrinters':        out = await getPrinters(who); break;
        case 'addPrinter':         out = await addPrinter(who, body.printer); break;
        case 'updatePrinter':      out = await updatePrinter(who, body.printer); break;
        case 'removePrinter':      out = await removePrinter(who, body.id); break;
        case 'getPartImportInfo':  out = await getPartImportInfo(who); break;
        case 'setPartSourceUrl':   out = await setPartSourceUrl(who, body.url); break;
        case 'refreshPartsNow':    out = await refreshPartsNow(who); break;
        case 'lookupPart':         out = await lookupPart(who, body.code); break;
        case 'setPhotoHidden':     out = await setPhotoHidden(who, body); break;
        // ----- Push notifications -----
        case 'savePushSubscription':   out = await savePushSubscription(who, body); break;
        case 'removePushSubscription': out = await removePushSubscription(who, body); break;
        case 'getPushStatus':          out = await getPushStatus(who); break;
        case 'setNotifyEnabled':       out = await setNotifyEnabled(who, body.enabled); break;
        case 'updateSettings':         out = await updateSettings(who, body); break;
        case 'sendTestPush':           out = await sendTestPush(who); break;
        case 'broadcastPush':          out = await broadcastPush(who, body); break;
        default:                  out = { error: 'Unknown action: ' + action };
      }
    }
    // Feed the outcome back to the throttle: a clean result clears the IP's
    // failure count; an {error} counts as a failed attempt.
    if (rateLimited) loginRateRecord(rlKey(req), !(out && out.error));
    res.json(out);
  } catch (err) {
    console.error('handler error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Ensure the schema is up to date (adds rules.team_wide on first boot after
// this deploy), then start serving. We start even if the migration hiccups so
// the app never goes fully dark over a schema check.
// Weekly worker: every Saturday at 2:37 AM (US Pacific) reload the part
// descriptions from the published CSV URL. Checks once a minute; a DB date guard
// (part_meta.last_auto) makes it run at most once per Saturday even across
// restarts. Does nothing if no source URL is configured.
function startWeeklyRefresh() {
  setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT to_char(now() AT TIME ZONE 'America/Los_Angeles', 'ID') AS dow,
                to_char(now() AT TIME ZONE 'America/Los_Angeles', 'HH24:MI') AS hm,
                (now() AT TIME ZONE 'America/Los_Angeles')::date::text AS today`);
      const { dow, hm, today } = rows[0];                 // ID: 1=Mon … 6=Sat, 7=Sun
      if (dow !== '6' || hm < '02:37' || hm > '02:45') return;
      const { rows: g } = await pool.query('SELECT last_auto::text AS d FROM part_meta WHERE id = 1');
      if (g.length && g[0].d === today) return;           // already ran this Saturday
      await pool.query('UPDATE part_meta SET last_auto = $1 WHERE id = 1', [today]);
      console.log('Weekly parts refresh: starting (Sat 02:37 PT)…');
      const res = await runWeeklyRefresh();
      console.log('Weekly parts refresh:', JSON.stringify(res));
    } catch (e) {
      console.error('weekly refresh tick error:', e && e.message ? e.message : e);
    }
  }, 60 * 1000);
}

(async () => {
  try {
    await ensureSchema();
  } catch (e) {
    console.error('ensureSchema failed (continuing to serve anyway):', e);
  }
  app.listen(PORT, () => console.log('Action Spa Warehouse API listening on port', PORT));
  startWeeklyRefresh();
})();
