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
// Helpers
// =================================================================

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
             category AS "Category", description AS "Description"
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
// HTTP server
// =================================================================

const app = express();
app.use(cors({ origin: true }));
// PWA posts JSON as text/plain (to avoid CORS preflight in the old setup).
// Accept any content-type and parse manually.
app.use(express.text({ type: '*/*', limit: '64kb' }));

// Serve the PWA from public/ — same origin as the API, so no CORS at all.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // index.html and sw.js shouldn't be cached by browsers — users always get
    // the latest version on next load.
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

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
      case 'award':     out = await awardBubbles(body.pin, body.name, body.metric, body.amount); break;
      case 'awardTeam': out = await awardTeam(body.pin, body.metric, body.amount); break;
      case 'undo':      out = await reverseAward(body.pin, body.name, body.metric, body.amount); break;
      case 'request':   out = await requestRedemption(body.pin, body.reward); break;
      case 'resolve':   out = await resolveRedemption(body.pin, body.row, body.approve); break;
      case 'fulfill':   out = await fulfillRedemption(body.pin, body.row); break;
      default:          out = { error: 'Unknown action: ' + action };
    }
    res.json(out);
  } catch (err) {
    console.error('handler error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => console.log('ASP Bubbles API listening on port', PORT));
