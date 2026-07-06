# Action Spa Warehouse — Maintainer's Runbook

Internal warehouse PWA for Action Spa Parts. This file is the single source of truth for
**how the app is built, deployed, and recovered.** Read it before changing anything.

> Built by an intern (Brady) whose internship is ending; a **non-technical owner** runs it
> solo afterward. Favor low-maintenance, self-service, well-documented solutions over clever ones.

---

## 1. What it is

A single-page vanilla-JS PWA with a Node/Express + Postgres backend, hosted on **Railway**.

- **Live:** https://action-spa-warehouse.up.railway.app/  (wall TV at `/tv`)
- **Repo:** GitHub `Action-Spa-Parts/asp-bubbles-api` (branch `main`)
- **Modules:** Bubbles (rewards + leaderboard), Closing Checklist (rotation), Box Counter,
  Employee of the Month, Label Printer (Zebra cloud + warehouse-PC "print bridge"),
  Imported Resources (links), Push Notifications, and a no-login TV view.

### Files (the repo is FLAT — everything at the repo root)
| File | Purpose |
|---|---|
| `index.js` | The whole backend: Express server, all ~90 RPC actions, DB schema (`ensureSchema`). |
| `index.html` | The whole front-end PWA (all screens/modules in one file). |
| `tv.html` | The no-login wall-TV view (`/tv`). |
| `sw.js` | Service worker — precaches the app shell (`SHELL` list) + version cache name. |
| `manifest.json` | PWA install manifest. |
| `Dockerfile` | Forces a Node build (see §3 — this is critical). |
| `railway.json` | Railway build/deploy config (`builder: DOCKERFILE`). |
| `package.json` | `type: module` + runtime deps (express, cors, pg, nodemailer, web-push). |
| `*.png`, `logo.svg`, `jsbarcode.min.js` | Static assets the app serves. |

**Rule:** the repo is the single source of truth. **Anything the app serves must be committed.**
The server only serves an allow-list — see `STATIC_FILES` in `index.js` and `SHELL` in `sw.js`.
If you add an asset, add it to BOTH lists (if it should be precached) and commit the file.

---

## 2. Deploy process

Auto-deploy is ON: **push to `main` → Railway builds the Dockerfile → live in ~1–2 min.**

1. Make changes.
2. **Front-end change?** Bump BOTH `APP_VERSION` (`index.js`) and `CACHE` (`sw.js`) to the
   same new number, so open apps show the "Update" banner and re-cache. Backend-only → no bump.
3. Commit + `git push origin HEAD:main`.
4. **Verify:** `curl -s -X POST https://action-spa-warehouse.up.railway.app/ -d '{"action":"getVersion"}'`
   should return the new version as JSON.

If auto-deploy stalls, deploy from the **Railway dashboard**: Deployments → Redeploy.

### No Node installed locally?
Parse-check `index.js` without running it: strip the `import`/`export`/`import.meta` lines and
compile with `new Function(src)` in any browser console (or a served page). Balanced braces +
`PARSE_OK` = good. (See the session history for the exact one-liner.)

---

## 3. ⚠️ The Dockerfile builder rule (do not break this)

Railway's default **"Railpack"/Nixpacks** builder MIS-DETECTS this repo as a **static website**
(because `index.html` sits next to the server) and ships a **static Caddy container**. A static
server only answers GET/HEAD, so **every POST — login, printing, everything — returns HTTP 405
and the whole team is locked out** while GET pages still load (looks half-up).

**The permanent fix (already in place):** the service Builder is set to **Dockerfile**
(`railway.json` + `Dockerfile`). The Dockerfile always runs `node index.js`, so it can never
build static. **Never switch the builder back to Railpack/Nixpacks.**

- Service → Settings → Build → **Builder = Dockerfile**, Dockerfile Path = `/Dockerfile`,
  Root Directory = (blank / repo root).

---

## 4. Recovery runbook (what to do when X)

**"The whole team is locked out / can't log in" (POST returns 405):**
Almost certainly a static build. Railway → Deployments → find the last **Success** that worked →
**Redeploy** it. Then confirm the Builder is still **Dockerfile** (§3).

**"getVersion returns 405 or empty":** Node isn't running (bad/static build). Roll back as above.

**"Broken images / dead /tv / no barcode / can't install PWA" after a deploy:**
A served file is missing from the repo. Check every file in `STATIC_FILES` (index.js) and `SHELL`
(sw.js) exists in git (`git ls-files`). Restore any missing one from history
(`git checkout <goodcommit> -- <file>`) and commit. (This exact thing happened Jul 2026 — the
v96 commit had deleted all static assets except one; the old container hid it until the Docker
build served straight from the repo.)

**"Deploys keep rolling back to an old version":** the Docker build is failing. Common cause: a
file the Dockerfile `COPY`s (e.g. `package.json`) is missing from the repo, so the build errors
and Railway keeps the last good container. Check the build logs in Railway.

**Database problem / data loss:** restore from a Railway Postgres backup (see §6). The app code
does NOT recreate the core `employees/awards/rewards/rules` tables — the backup is the recovery
path.

---

## 5. Environment variables (Railway → service → Variables)

| Var | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres connection | provided by the Railway Postgres service |
| `MANAGER_PIN` | Manager break-glass PIN | **MUST be set** — falls back to `1234` if missing! |
| `PORT` | Web port | provided by Railway |
| `PRINT_BRIDGE_TOKEN` | Shared secret for the warehouse-PC print bridge | keep secret |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Email sending (optional) | |
| `RESEND_API_KEY` | Email sending (alt) | |
| `MANAGER_EMAIL` | Where manager emails go | |
| `ERP_MCP_URL` / `ERP_ITEM_QUERY` | ERP lookups for part descriptions | keep URL/key secret |

Secrets that must stay OUT of shared docs: `MANAGER_PIN`, `PRINT_BRIDGE_TOKEN`, the ERP URL/key.

---

## 6. Reliability checklist (for the owner)

- [ ] **`MANAGER_PIN` is set** in Railway (not the `1234` default).
- [ ] **Postgres backups are ON** (Railway → Postgres service → Backups). This is the disaster-
      recovery path for all app data (Bubbles points, checklist history, EOM votes).
- [ ] **Uptime monitor** (e.g. UptimeRobot, free) hits the live URL every 5 min and emails/texts
      if it's down, so an outage pings the owner first.

---

## 7. Data model (Postgres)

**Core (pre-existing — NOT recreated by `ensureSchema`):**
- `employees` — id, name, pin, email, starting_balance, active, checklist_eligible, voting_eligible
- `awards` — id, employee_id, metric, amount, awarded_by, note, reversed_by_id (+ timestamp). Points
  are awards; redemptions/penalties are awards too (negative or reversed).
- `rewards` — id, name, cost, description, active
- `rules` — id, metric, bubbles, category, description, team_wide, active
- `balances` — view/derived: each employee's current point balance (starting_balance + awards)

**Created by `ensureSchema` (self-healing):** admins, admin_sessions, checklist_tasks/runs/items,
checklist_rotation, box_sizes, box_activity, resource_links, eom_votes, eom_winners,
app_migrations, print_jobs, print_bridge, cloud_print, printers, part_descriptions, part_meta,
photo_hidden, push_keys, push_subscriptions.

---

## 8. Feature notes / gotchas

- **Closing Checklist rotation** is **strictly alphabetical** (by employee name). The daily closer
  is the next alphabetical eligible person who hasn't gone this cycle; it restarts A→Z once
  everyone's had a turn. Logic lives in `ensureTodayRun`, `rotationView`, `reshuffleChecklist`
  (index.js). The manager can tap a name to set today's closer, or "Restart order from the top".
- **Label Printer** logs a print only when it goes through the app (`enqueuePrint`), attributed to
  the signed-in user. Zebra printers are **cloud** printers (send-only — no way to pull history).
  The **print bridge** (a warehouse PC running `railway/print-bridge/asp-print-bridge.ps1`) is a
  fallback path; if it's offline, bridge printing won't work.
- **Auth** is PIN-based: each employee has a `pin`; the `MANAGER_PIN` is the manager break-glass.
  `isManager(who)` gates all manager-only actions.
- **Push notifications:** VAPID keys auto-generate into the DB (`push_keys`) — no env vars needed.
  Per-device enable + manager "Send test" shipped. A scheduler/broadcast UI is the next milestone.

---

_Last updated: Jul 2026. Keep this file current when you change deploy/build/recovery behavior._
