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
const APP_VERSION = '19';
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

  // Seed the standard 16 tasks once (only if the table is empty).
  const { rows: tc } = await pool.query('SELECT COUNT(*)::int AS n FROM checklist_tasks');
  if (tc[0].n === 0) {
    await pool.query(`
      INSERT INTO checklist_tasks (category, label, sort_order) VALUES
        ('Printers & Supplies', 'Refill all printer paper trays (label, packing slip, and document printers).', 10),
        ('Printers & Supplies', 'Replace any low or empty toner / ink and set out spares if needed.', 20),
        ('Printers & Supplies', 'Restock packing tape, labels, and shipping supplies at each station.', 30),
        ('Climate Control', 'All fans are turned OFF.', 40),
        ('Climate Control', 'All A/C units are turned OFF.', 50),
        ('Climate Control', 'Heaters / space heaters are turned OFF (if applicable).', 60),
        ('Equipment & Power', 'Forklifts / pallet jacks parked and plugged in to charge.', 70),
        ('Equipment & Power', 'Scanners and handheld devices placed on chargers.', 80),
        ('Equipment & Power', 'Computers / monitors at workstations shut down or locked.', 90),
        ('Housekeeping', 'Aisles and walkways clear; pallets and carts put away.', 100),
        ('Housekeeping', 'Trash and cardboard removed; recycling emptied.', 110),
        ('Housekeeping', 'Workstations wiped down and organized for the next shift.', 120),
        ('Building & Security', 'All gates are CLOSED and locked.', 130),
        ('Building & Security', 'All overhead / dock doors are CLOSED and secured.', 140),
        ('Building & Security', 'All exterior and interior LIGHTS are turned OFF.', 150),
        ('Building & Security', 'All entry doors locked.', 160)`);
    console.log('Schema: seeded 16 checklist tasks.');
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

  // Clean up any not-yet-completed runs that landed on a closed day (e.g. a
  // Sunday run created before this rule existed). Leaves completed history alone.
  if (CLOSED_DOWS.length) {
    await pool.query(
      `DELETE FROM checklist_runs WHERE status = 'pending' AND EXTRACT(DOW FROM run_date)::int = ANY($1)`,
      [CLOSED_DOWS]);
  }
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
  if (p === String(MANAGER_PIN)) return { role: 'manager', name: 'Manager' };
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
  if (MANAGER_EMAIL) await sendResend(MANAGER_EMAIL, subject, body);
  else console.log(`[manager email skipped — no MANAGER_EMAIL set] ${subject}`);
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
    allAwards: allAwards.rows,
    checklist,
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

  return {
    balances: balances.rows,
    rules: rules.rows,
    activity: activity.rows,
    checklist,
    boxSizes,
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
             e.starting_balance AS "startingBalance", e.active, b.balance
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
    if (newPin === String(MANAGER_PIN)) return { error: 'That PIN is reserved for the manager' };
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
    if (newPin === String(MANAGER_PIN)) return { error: 'That PIN is reserved for the manager' };
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

// Days of week with no closing checklist (office closed). 0 = Sunday, 6 = Saturday.
const CLOSED_DOWS = [0, 6];

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
    if (CLOSED_DOWS.includes(dowRows[0].dow)) { await client.query('ROLLBACK'); return null; }

    // Avoid assigning the same person two days in a row when possible; otherwise
    // pick whoever has gone the longest ago (never-assigned first), random tiebreak.
    const { rows: last } = await client.query(
      'SELECT employee_id FROM checklist_runs ORDER BY run_date DESC, id DESC LIMIT 1');
    const lastId = (last.length && last[0].employee_id != null) ? last[0].employee_id : -1;
    const pickSql = (excl) => `
      SELECT e.id FROM employees e
       WHERE e.active = true ${excl ? 'AND e.id <> $1' : ''}
       ORDER BY (SELECT MAX(run_date) FROM checklist_runs r WHERE r.employee_id = e.id) ASC NULLS FIRST, random()
       LIMIT 1`;
    let pick = await client.query(pickSql(true), [lastId]);
    if (!pick.rows.length) pick = await client.query(pickSql(false));
    if (!pick.rows.length) { await client.query('ROLLBACK'); return null; }

    const ins = await client.query(
      `INSERT INTO checklist_runs (run_date, employee_id) VALUES (${BIZ_DATE}, $1) RETURNING *`,
      [pick.rows[0].id]);
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
  return {
    date: run.run_date, assignee, status: run.status,
    mine: !!(who && who.role === 'employee' && assignee === who.name),
    total: rows[0].total, checked: rows[0].checked, flagged: rows[0].flagged,
  };
}

// Recent runs (most recent first) with their items attached. Shared by the
// employee history view and the manager review.
async function runsWithItems(limit) {
  const { rows: runs } = await pool.query(`
    SELECT r.id, to_char(r.run_date, 'YYYY-MM-DD') AS run_date, r.status, r.submitted_at,
           e.name AS assignee
      FROM checklist_runs r LEFT JOIN employees e ON e.id = r.employee_id
     ORDER BY r.run_date DESC LIMIT $1`, [limit]);
  const ids = runs.map(r => r.id);
  const byRun = {};
  if (ids.length) {
    const { rows: items } = await pool.query(`
      SELECT id, run_id, category, label, checked, flagged, flag_note, flagged_by
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
  const history = recent.filter(r => r.run_date !== today);   // past days only
  if (!run) {
    return { date: today, today, assignee: null, status: null, mine: false, items: [], history };
  }
  const assignee = await nameForEmpId(run.employee_id);
  const todayRow = recent.find(r => r.id === run.id);
  return {
    date: today, today, assignee, status: run.status,
    mine: who.role === 'employee' && assignee === who.name,
    submittedAt: run.submitted_at,
    items: todayRow ? todayRow.items : [],
    history,
  };
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

// Manager review: recent runs with their items.
async function getChecklistAdmin(who) {
  if (!isManager(who)) return { error: 'Manager only' };
  await ensureTodayRun();
  return { today: await todayStr(), runs: await runsWithItems(21) };
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
  const run = await ensureTodayRun();
  return { ok: true, assignee: run ? await nameForEmpId(run.employee_id) : null };
}

// =================================================================
// HTTP server
// =================================================================

const app = express();
app.use(cors({ origin: true }));
// PWA posts JSON as text/plain (to avoid CORS preflight in the old setup).
// Accept any content-type and parse manually.
app.use(express.text({ type: '*/*', limit: '64kb' }));

// Serve the PWA static files. They live alongside index.js at the project root
// (matches the asp-bubbles-api GitHub repo layout). We serve only an explicit
// allow-list so server source files (index.js, package.json) aren't exposed.
const STATIC_FILES = [
  'index.html', 'tv.html', 'sw.js', 'manifest.json',
  'logo.svg', 'bubbles-icon.png',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'jsbarcode.min.js', 'browserprint.min.js',
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
// Counting is Friday-only, in US Pacific (same tz as the checklist). Reports
// whether today is Friday, whether a count already happened today, and the next Friday.
async function boxCountMeta() {
  const { rows } = await pool.query(`
    SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD') AS today,
           EXTRACT(DOW FROM (now() AT TIME ZONE 'America/Los_Angeles'))::int AS dow,
           to_char((SELECT (max(last_counted_at) AT TIME ZONE 'America/Los_Angeles')::date
                      FROM box_sizes WHERE active = true), 'YYYY-MM-DD') AS last_count_date`);
  const today = rows[0].today;
  const dow = rows[0].dow;                       // 0=Sun … 5=Fri … 6=Sat
  const lastCountDate = rows[0].last_count_date || null;
  const isFriday = dow === 5;
  const countedToday = !!lastCountDate && lastCountDate === today;
  const add = isFriday ? (countedToday ? 7 : 0) : (((5 - dow) + 7) % 7);
  return { today, dow, isFriday, countedToday, lastCountDate, nextFriday: addDaysStr(today, add) };
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
  const meta = await boxCountMeta();
  if (!meta.isFriday) return { error: 'Box counting is only available on Fridays.' };
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
  if (saved) { try { await emailLowStock(); } catch (e) { console.warn('low-stock email failed:', e && e.message); } }
  const data = await getBoxSizes(who);
  data.saved = saved;
  return data;
}

// Edit a size's current quantity and/or its low threshold (null clears it).
async function updateBoxSize(who, body) {
  if (!who) return { error: 'Not authorized' };
  const id = parseInt(body && body.id, 10);
  if (!Number.isFinite(id)) return { error: 'Bad id.' };
  if (body && 'lowThreshold' in body) {
    let t = body.lowThreshold;
    t = (t === null || t === '') ? null : parseInt(t, 10);
    if (t !== null && (!Number.isFinite(t) || t < 0)) return { error: 'Threshold must be 0 or more.' };
    await pool.query('UPDATE box_sizes SET low_threshold = $1 WHERE id = $2', [t, id]);
  }
  if (body && 'quantity' in body) {
    const q = parseInt(body.quantity, 10);
    if (!Number.isFinite(q) || q < 0) return { error: 'Quantity must be 0 or more.' };
    await pool.query('UPDATE box_sizes SET quantity = $1 WHERE id = $2', [q, id]);
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

async function getEom(who) {
  if (!who) return { error: 'Not authorized' };
  const meta = await eomMeta();
  const { rows: emps } = await pool.query('SELECT name FROM employees WHERE active = true ORDER BY name');
  const candidates = emps.map(e => e.name);
  const { rows: tally } = await pool.query(
    `SELECT choice_name AS name, COUNT(*)::int AS votes FROM eom_votes
       WHERE period = $1 GROUP BY choice_name ORDER BY votes DESC, choice_name`, [meta.awardPeriod]);
  const { rows: mine } = await pool.query(
    'SELECT choice_name FROM eom_votes WHERE period = $1 AND voter_name = $2', [meta.awardPeriod, who.name]);
  const { rows: vc } = await pool.query(
    'SELECT COUNT(DISTINCT voter_name)::int AS n FROM eom_votes WHERE period = $1', [meta.awardPeriod]);
  // Most-recent finished result (top vote-getter of the latest period that has votes).
  const { rows: last } = await pool.query(
    `SELECT period, choice_name AS name, COUNT(*)::int AS votes FROM eom_votes
       GROUP BY period, choice_name ORDER BY period DESC, votes DESC, choice_name LIMIT 1`);
  let lastResult = null;
  if (last.length) {
    const [ly, lm] = last[0].period.split('-').map(Number);
    lastResult = { period: last[0].period, label: `${MONTH_NAMES[lm - 1]} ${ly}`, name: last[0].name, votes: last[0].votes };
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
  const { rows: ok } = await pool.query('SELECT 1 FROM employees WHERE name = $1 AND active = true', [pick]);
  if (!ok.length) return { error: "That person isn't an active employee." };
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
  const periods = [];
  for (const pr of prows) {
    const p = pr.period;
    if (!isMgr && openPeriod && p === openPeriod) continue;   // hide in-progress month from employees
    const { rows: tally } = await pool.query(
      `SELECT choice_name AS name, COUNT(*)::int AS votes FROM eom_votes
         WHERE period = $1 GROUP BY choice_name ORDER BY votes DESC, choice_name`, [p]);
    const [y, m] = p.split('-').map(Number);
    const entry = { period: p, label: monthLabel(y, m),
      winner: tally.length ? { name: tally[0].name, votes: tally[0].votes } : null, tally };
    if (isMgr) {
      const { rows: ballots } = await pool.query(
        'SELECT voter_name AS voter, choice_name AS choice FROM eom_votes WHERE period = $1 ORDER BY voter_name', [p]);
      entry.ballots = ballots;
    }
    periods.push(entry);
  }
  return { periods, isManager: isMgr };
}

app.post('/', async (req, res) => {
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Bad JSON body' });
  }
  const action = body.action;
  try {
    let out;
    // Public actions need no identity.
    switch (action) {
      case 'login':       out = await login(body.pin); break;
      case 'getPublic':   out = await getPublic(); break;
      case 'getVersion':  out = { version: APP_VERSION }; break;
      case 'adminLogin':  out = await adminLogin(body); break;
      case 'adminSignup': out = await adminSignup(body); break;
      case 'adminLogout': out = await adminLogout(body); break;
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
        // ----- Admin (manager only) -----
        case 'getAdmin':          out = await getAdmin(who); break;
        case 'addRule':           out = await addRule(who, body.rule); break;
        case 'updateRule':        out = await updateRule(who, body.rule); break;
        case 'setRuleActive':     out = await setRuleActive(who, body.id, body.active); break;
        case 'addReward':         out = await addReward(who, body.reward); break;
        case 'updateReward':      out = await updateReward(who, body.reward); break;
        case 'setRewardActive':   out = await setRewardActive(who, body.id, body.active); break;
        case 'addEmployee':       out = await addEmployee(who, body.employee); break;
        case 'updateEmployee':    out = await updateEmployee(who, body.employee); break;
        case 'setEmployeeActive': out = await setEmployeeActive(who, body.id, body.active); break;
        case 'listAdmins':        out = await listAdmins(who); break;
        case 'addAdmin':          out = await addAdmin(who, body.admin); break;
        case 'updateAdmin':       out = await updateAdmin(who, body.admin); break;
        case 'setAdminActive':    out = await setAdminActive(who, body.id, body.active); break;
        case 'approveAdmin':      out = await approveAdmin(who, body.id); break;
        case 'denyAdmin':         out = await denyAdmin(who, body.id); break;
        // ----- End-of-day checklist -----
        case 'getChecklist':         out = await getChecklist(who); break;
        case 'submitChecklist':      out = await submitChecklist(who); break;
        case 'getChecklistAdmin':    out = await getChecklistAdmin(who); break;
        case 'flagChecklistItem':    out = await flagChecklistItem(who, body); break;
        case 'unflagChecklistItem':  out = await unflagChecklistItem(who, body.itemId); break;
        case 'correctChecklistItem': out = await correctChecklistItem(who, body); break;
        case 'addChecklistTask':     out = await addChecklistTask(who, body.task); break;
        case 'updateChecklistTask':  out = await updateChecklistTask(who, body.task); break;
        case 'setChecklistTaskActive': out = await setChecklistTaskActive(who, body.id, body.active); break;
        case 'resetChecklist':       out = await resetChecklist(who); break;
        // ----- Box Counter -----
        case 'getBoxSizes':   out = await getBoxSizes(who); break;
        case 'saveBoxCount':  out = await saveBoxCount(who, body); break;
        case 'updateBoxSize': out = await updateBoxSize(who, body); break;
        case 'setBoxSizeActive': out = await setBoxSizeActive(who, body.id, body.active); break;
        case 'setBoxDisregarded': out = await setBoxDisregarded(who, body.id, body.disregarded); break;
        // ----- Employee of the Month -----
        case 'getEom':       out = await getEom(who); break;
        case 'castEomVote':  out = await castEomVote(who, body.choice); break;
        case 'getEomLog':    out = await getEomLog(who); break;
        default:                  out = { error: 'Unknown action: ' + action };
      }
    }
    res.json(out);
  } catch (err) {
    console.error('handler error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Ensure the schema is up to date (adds rules.team_wide on first boot after
// this deploy), then start serving. We start even if the migration hiccups so
// the app never goes fully dark over a schema check.
(async () => {
  try {
    await ensureSchema();
  } catch (e) {
    console.error('ensureSchema failed (continuing to serve anyway):', e);
  }
  app.listen(PORT, () => console.log('Action Spa Warehouse API listening on port', PORT));
})();
