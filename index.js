// Action Spa Parts — Warehouse Bubbles API
// Single POST endpoint that mirrors the Apps Script action protocol so the PWA
// front-end only needs its API_URL pointed here — no other changes.
//
// Env vars expected:
//   DATABASE_URL    Postgres connection (Railway auto-injects via ${{Postgres.DATABASE_URL}})
//   MANAGER_PIN     6-digit PIN for manager-only actions (required)
//   MANAGER_EMAIL   where manager notifications go (optional)
//   RESEND_API_KEY  if set, emails are sent via Resend; otherwise logged-only
//   PORT            Railway sets this automatically

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { Pool } = pg;

const DATABASE_URL  = process.env.DATABASE_URL;
const MANAGER_PIN   = process.env.MANAGER_PIN || '1234';
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
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
}

// =================================================================
// Helpers
// =================================================================

// Manager-only gate for admin actions. Returns the manager identity or null.
async function requireManager(pin) {
  const who = await roleForPin(pin);
  return (who && who.role === 'manager') ? who : null;
}

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

async function getData(pin) {
  const who = await roleForPin(pin);
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
             a.metric AS "Metric", a.amount AS "Amount"
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
    isManager
      ? pool.query(`
          SELECT a.created_at AS "Timestamp", e.name AS "Name",
                 a.metric AS "Metric", a.amount AS "Amount"
            FROM awards a JOIN employees e ON e.id = a.employee_id
           ORDER BY a.created_at DESC
           LIMIT 500`)
      : Promise.resolve({ rows: [] }),
  ]);

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
             a.metric AS "Metric", a.amount AS "Amount"
        FROM awards a JOIN employees e ON e.id = a.employee_id
       ORDER BY a.created_at DESC
       LIMIT 100`),
  ]);
  return {
    balances: balances.rows,
    rules: rules.rows,
    activity: activity.rows,
  };
}

async function awardBubbles(pin, name, metric, amount) {
  const who = await roleForPin(pin);
  if (!who || who.role !== 'manager') return { error: 'Invalid manager PIN' };
  if (!name || typeof amount !== 'number') return { error: 'Missing name or amount' };

  const { rows } = await pool.query('SELECT id FROM employees WHERE name = $1', [name]);
  if (!rows.length) return { error: 'Unknown employee: ' + name };

  await pool.query(
    'INSERT INTO awards (employee_id, metric, amount, awarded_by) VALUES ($1, $2, $3, $4)',
    [rows[0].id, metric || '', amount, 'Manager']
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

async function awardTeam(pin, metric, amount) {
  const who = await roleForPin(pin);
  if (!who || who.role !== 'manager') return { error: 'Invalid manager PIN' };
  if (typeof amount !== 'number') return { error: 'Missing amount' };

  // One INSERT writes a row per active employee.
  const ins = await pool.query(
    `INSERT INTO awards (employee_id, metric, amount, awarded_by, note)
     SELECT id, $1, $2, 'Manager', 'Whole-team award'
       FROM employees WHERE active = true
     RETURNING employee_id`,
    [metric || '', amount]
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

async function reverseAward(pin, name, metric, amount) {
  const who = await roleForPin(pin);
  if (!who || who.role !== 'manager') return { error: 'Invalid manager PIN' };
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
       VALUES ($1, $2, $3, 'Manager', 'Reversal')
       RETURNING id`,
      [employeeId, 'Undo: ' + (metric || ''), -amount]
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

async function requestRedemption(pin, rewardName) {
  const who = await roleForPin(pin);
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

async function resolveRedemption(pin, redemptionId, approve) {
  const who = await roleForPin(pin);
  if (!who || who.role !== 'manager') return { error: 'Manager only' };

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
         VALUES ($1, $2, $3, 'Manager', 'Redemption')`,
        [r.employee_id, 'Redeemed: ' + r.reward_name, -r.cost]
      );
      await client.query(
        `UPDATE redemptions SET status = 'approved', resolved_at = now(), approved_by = 'Manager' WHERE id = $1`,
        [r.id]
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

async function fulfillRedemption(pin, redemptionId) {
  const who = await roleForPin(pin);
  if (!who || who.role !== 'manager') return { error: 'Manager only' };

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
async function getAdmin(pin) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
  const [rules, rewards, employees] = await Promise.all([
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
  ]);
  return { rules: rules.rows, rewards: rewards.rows, employees: employees.rows };
}

// ---------- Rules ----------

async function addRule(pin, r) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
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

async function updateRule(pin, r) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
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

async function setRuleActive(pin, id, active) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
  const rid = cleanInt(id);
  if (rid === null) return { error: 'Bad rule id' };
  await pool.query(`UPDATE rules SET active=$1 WHERE id=$2`, [!!active, rid]);
  return { ok: true };
}

// ---------- Rewards ----------

async function addReward(pin, r) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
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

async function updateReward(pin, r) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
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

async function setRewardActive(pin, id, active) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
  const rid = cleanInt(id);
  if (rid === null) return { error: 'Bad reward id' };
  await pool.query(`UPDATE rewards SET active=$1 WHERE id=$2`, [!!active, rid]);
  return { ok: true };
}

// ---------- Employees ----------

async function addEmployee(pin, e) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
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

async function updateEmployee(pin, e) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
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

async function setEmployeeActive(pin, id, active) {
  if (!await requireManager(pin)) return { error: 'Manager only' };
  const eid = cleanInt(id);
  if (eid === null) return { error: 'Bad employee id' };
  await pool.query(`UPDATE employees SET active=$1 WHERE id=$2`, [!!active, eid]);
  return { ok: true };
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
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
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
  res.json({ ok: true, app: 'asp-bubbles' });
});

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
    switch (action) {
      case 'login':     out = await login(body.pin); break;
      case 'getData':   out = await getData(body.pin); break;
      case 'getPublic': out = await getPublic(); break;
      case 'award':     out = await awardBubbles(body.pin, body.name, body.metric, body.amount); break;
      case 'awardTeam': out = await awardTeam(body.pin, body.metric, body.amount); break;
      case 'undo':      out = await reverseAward(body.pin, body.name, body.metric, body.amount); break;
      case 'request':   out = await requestRedemption(body.pin, body.reward); break;
      case 'resolve':   out = await resolveRedemption(body.pin, body.row, body.approve); break;
      case 'fulfill':   out = await fulfillRedemption(body.pin, body.row); break;
      // ----- Admin (manager only) -----
      case 'getAdmin':          out = await getAdmin(body.pin); break;
      case 'addRule':           out = await addRule(body.pin, body.rule); break;
      case 'updateRule':        out = await updateRule(body.pin, body.rule); break;
      case 'setRuleActive':     out = await setRuleActive(body.pin, body.id, body.active); break;
      case 'addReward':         out = await addReward(body.pin, body.reward); break;
      case 'updateReward':      out = await updateReward(body.pin, body.reward); break;
      case 'setRewardActive':   out = await setRewardActive(body.pin, body.id, body.active); break;
      case 'addEmployee':       out = await addEmployee(body.pin, body.employee); break;
      case 'updateEmployee':    out = await updateEmployee(body.pin, body.employee); break;
      case 'setEmployeeActive': out = await setEmployeeActive(body.pin, body.id, body.active); break;
      default:          out = { error: 'Unknown action: ' + action };
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
  app.listen(PORT, () => console.log('ASP Bubbles API listening on port', PORT));
})();
