# Brief By Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harold receives P.AI's morning brief as a text message at 8:05 AM Eastern, from RC Tracker's existing Twilio number, built from a data pull that runs at 6:00 AM Eastern on the previous day's numbers.

**Architecture:** P.AI already generates and caches a per-person morning brief nightly. This plan adds three things and changes one: a backup of all RC Tracker data (safety gate), a Supabase client so P.AI can log SMS and read consent where that data already lives, a brief sender on its own 2-minute timer that condenses the cached brief and sends it via Twilio, and a retime of both morning pulls from a fixed UTC hour to a 6:00 AM Eastern local-time gate. **Outbound only** — RC Tracker keeps the inbound webhook, so its SMS is untouched.

**Tech Stack:** Node 18+, Express, `pg` (P.AI's Postgres), `@supabase/supabase-js` (RC Tracker's Postgres), `twilio`, `@anthropic-ai/sdk`, `jest` + `supertest` for tests.

**Repos:** code changes land in `C:\Users\Precision 3551\Desktop\pai` unless a task says otherwise. One task adds a migration to `C:\Users\Precision 3551\Desktop\rc-tracker`; it is a partial index that cannot affect existing rows.

**Spec:** `docs/superpowers/specs/2026-10-02-rc-tracker-pai-integration-design.md` (in the rc-tracker repo)

**What this plan does NOT do:** no scoping, no Tracker module, no matrix changes, no RC Tracker behavior changes, no webhook cutover. Those are later plans. Recipients are Harold only.

---

## Plan sequence (context)

This is plan 1 of 3. Each ships something that works on its own.

| Plan | Delivers | Spec phases |
|---|---|---|
| **1. Brief by text** (this plan) | Harold gets his brief as a text at 8:05 ET | 0, 1, 5, pipeline retime |
| 2. Tracker module | Tracker in P.AI, login-scoped, per-store AC matrix | 2, 3, 4 |
| 3. Cutover | Twilio webhook moves to P.AI, reminders move with it | 6 |

Plan 2 is written after plan 1 ships, so it can be informed by what plan 1 learns about the Supabase seam.

---

## File Structure

### Created in `pai`

| File | Responsibility |
|---|---|
| `scripts/backup-rc-data.js` | Dump every Supabase table and the storage bucket to disk. Run once as a gate; kept for re-runs. |
| `scripts/verify-rc-backup.js` | Re-read a dump and diff row counts against live. A backup that has not been verified is not a backup. |
| `services/localtime.js` | Timezone-aware date/time helpers. Pure functions, no I/O. The one place DST is reasoned about. |
| `services/rc-db.js` | Supabase client pair (anon + service) against RC Tracker's project. Single seam to repoint in spec Phase 7. |
| `services/rc-people.js` | Reads the roster copy; gives phone + timezone for a person. |
| `services/brief-sms.js` | Condense a cached brief, decide who is due, claim, send, log. |
| `data/people.json` | Copy of RC Tracker's roster. Reconciled in plan 2. |
| `tests/localtime.test.js` | DST boundaries, local date rollover. |
| `tests/brief-condense.test.js` | Length ceiling, link present, absent-brief returns no send. |
| `tests/brief-due.test.js` | Send window, one-per-local-date, consent gate. |
| `tests/scheduler-gate.test.js` | 6:00 AM Eastern gate on both sides of DST. |

### Modified in `pai`

| File | Change |
|---|---|
| `package.json` | Add `@supabase/supabase-js`, `twilio`, `jest`; add `test` script. |
| `services/scheduler.js` | Gate on 6:00 AM Eastern instead of 10:00 UTC; add an intel-pipeline gate alongside the velocity one. |
| `scripts/intel-cron.js` | Fix the stale "9 AM UTC" comment. |
| `server.js` | Start the brief sender's timer. |
| `render.yaml` | Supabase + Twilio + brief env vars; move the intel cron to `0 10 * * *`. |

### Created in `rc-tracker`

| File | Responsibility |
|---|---|
| `supabase/migrations/008_brief_claim.sql` | Partial unique index making one-brief-per-person-per-day atomic. |

---

## Task 1: Back up every byte of RC Tracker data

Nothing else starts until this task's verification passes.

**Files:**
- Create: `pai/scripts/backup-rc-data.js`
- Create: `pai/scripts/verify-rc-backup.js`

- [ ] **Step 1: Write the backup script**

```js
// scripts/backup-rc-data.js
// Dumps every RC Tracker Supabase table and the note-images bucket to disk.
// Read-only against Supabase. Safe to re-run; each run gets its own folder.

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const TABLES = [
  'user_data', 'follow_ups', 'email_followups',
  'sms_reminders', 'sms_consent', 'sms_messages', 'candidates',
];
const BUCKET    = 'note-images';
const PAGE_SIZE = 1000;

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and a Supabase key must be set');
  return createClient(url, key, { auth: { persistSession: false } });
}

// Page through a table — a plain select caps out and would truncate silently.
async function dumpTable(sb, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await sb.from(table).select('*').range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function dumpBucket(sb, outDir) {
  const { data: files, error } = await sb.storage.from(BUCKET).list('', { limit: 10000 });
  if (error) throw new Error(`${BUCKET}: ${error.message}`);
  fs.mkdirSync(outDir, { recursive: true });
  let saved = 0;
  for (const f of files) {
    const { data, error: dlErr } = await sb.storage.from(BUCKET).download(f.name);
    if (dlErr) { console.error(`  ! ${f.name}: ${dlErr.message}`); continue; }
    fs.writeFileSync(path.join(outDir, f.name), Buffer.from(await data.arrayBuffer()));
    saved++;
  }
  return { listed: files.length, saved };
}

async function main() {
  const sb    = client();
  const stamp = new Date().toISOString().slice(0, 10);
  const root  = path.join(__dirname, '..', '..', 'rc-tracker', 'backups', stamp);
  fs.mkdirSync(root, { recursive: true });

  const manifest = { created_at: new Date().toISOString(), tables: {}, bucket: null };

  for (const t of TABLES) {
    const rows = await dumpTable(sb, t);
    fs.writeFileSync(path.join(root, `${t}.json`), JSON.stringify(rows, null, 2));
    manifest.tables[t] = rows.length;
    console.log(`  ${t}: ${rows.length} rows`);
  }

  manifest.bucket = await dumpBucket(sb, path.join(root, BUCKET));
  console.log(`  ${BUCKET}: ${manifest.bucket.saved}/${manifest.bucket.listed} files`);

  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nBackup written to ${root}`);
}

main().catch(err => { console.error('BACKUP FAILED:', err.message); process.exit(1); });
```

- [ ] **Step 2: Write the verifier**

```js
// scripts/verify-rc-backup.js
// Re-counts live rows and diffs against a dump's manifest.
// Usage: node scripts/verify-rc-backup.js 2026-10-02

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const stamp = process.argv[2];
if (!stamp) { console.error('Usage: node scripts/verify-rc-backup.js YYYY-MM-DD'); process.exit(1); }

const root     = path.join(__dirname, '..', '..', 'rc-tracker', 'backups', stamp);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  );

  let bad = 0;
  for (const [table, backedUp] of Object.entries(manifest.tables)) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
    if (error) { console.error(`  ! ${table}: ${error.message}`); bad++; continue; }

    const onDisk = JSON.parse(fs.readFileSync(path.join(root, `${table}.json`), 'utf8')).length;

    // Live may legitimately have grown since the dump — it must never be short,
    // and the file must match what the manifest claimed.
    if (onDisk !== backedUp) { console.error(`  ! ${table}: file ${onDisk} != manifest ${backedUp}`); bad++; }
    else if (count < backedUp) { console.error(`  ! ${table}: live ${count} < backup ${backedUp} — rows disappeared`); bad++; }
    else console.log(`  ${table}: ${onDisk} backed up, ${count} live  OK`);
  }

  const b = manifest.bucket;
  if (b.saved !== b.listed) { console.error(`  ! ${b.listed - b.saved} bucket file(s) failed to download`); bad++; }
  else console.log(`  note-images: ${b.saved} files  OK`);

  if (bad) { console.error(`\nVERIFY FAILED (${bad} problem(s)). Do not proceed.`); process.exit(1); }
  console.log('\nVerify passed. Safe to proceed.');
}

main().catch(err => { console.error('VERIFY FAILED:', err.message); process.exit(1); });
```

- [ ] **Step 3: Install the Supabase client so the scripts can run**

Run in `pai`:
```bash
npm install @supabase/supabase-js@^2.39.0 twilio@^6.0.2
```
Expected: both added to `dependencies`, no peer warnings that mention `express`.

- [ ] **Step 4: Run the backup**

Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the shell from RC Tracker's Render environment, then run in `pai`:
```bash
node scripts/backup-rc-data.js
```
Expected: one line per table with a non-zero row count for at least `follow_ups`, `sms_messages`, `sms_consent` and `user_data`, then `Backup written to .../rc-tracker/backups/<today>`.

**If any table reports 0 rows, stop.** Either the key lacks read access or you are pointed at the wrong project. Do not continue on an empty backup.

- [ ] **Step 5: Verify the backup**

```bash
node scripts/verify-rc-backup.js $(date +%F)
```
Expected: `Verify passed. Safe to proceed.`

- [ ] **Step 6: Commit**

```bash
git add scripts/backup-rc-data.js scripts/verify-rc-backup.js package.json package-lock.json
git commit -m "Back up RC Tracker's Supabase data before P.AI touches it

Pages through every table rather than taking a plain select, which caps
out and would truncate a large table without saying so, and downloads
the note-images bucket file by file. The verifier re-counts live rows
and refuses a dump that is short, because a backup nobody has read back
is not a backup.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Test harness for P.AI

P.AI has no tests. Four things in this plan fail silently without them.

**Files:**
- Modify: `pai/package.json`
- Create: `pai/tests/smoke.test.js`

- [x] **Step 1: Write a failing test**

```js
// tests/smoke.test.js
describe('test harness', () => {
  test('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [x] **Step 2: Run it to verify it fails (no jest yet)**

Run: `npx jest tests/smoke.test.js`
Expected: FAIL — `jest: not found` or `Cannot find module 'jest'`.

- [x] **Step 3: Install jest and add the script**

```bash
npm install --save-dev jest@^29.7.0 supertest@^6.3.4
```

Add to `package.json` `scripts`, beside the existing `start` and `dev`:
```json
"test": "jest --testPathPattern=tests/"
```

And at the top level of `package.json`:
```json
"jest": {
  "testEnvironment": "node",
  "testPathIgnorePatterns": ["/node_modules/", "/playwright-browsers/"]
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npm test`
Expected: PASS, `1 passed`.

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/smoke.test.js
git commit -m "Add jest to P.AI

Four things in the brief sender fail silently rather than loudly — the
DST gate, the length ceiling, the consent check and send dedupe — so
they need tests before they need code.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Timezone helpers

Every DST and local-date decision in this plan goes through this one file.

**Files:**
- Create: `pai/services/localtime.js`
- Create: `pai/tests/localtime.test.js`

- [x] **Step 1: Write the failing tests**

```js
// tests/localtime.test.js
const { localDate, localHHMM, minusDays, isAtOrAfter } = require('../services/localtime');

const ET = 'America/New_York';
const CT = 'America/Chicago';

describe('localDate', () => {
  test('returns YYYY-MM-DD in the given zone', () => {
    expect(localDate(new Date('2026-10-02T16:00:00Z'), ET)).toBe('2026-10-02');
  });

  // 03:30 UTC on the 3rd is still the 2nd in both US zones. Using UTC dates
  // for a local-day decision is an off-by-one every single night.
  test('is still yesterday just after UTC midnight', () => {
    expect(localDate(new Date('2026-10-03T03:30:00Z'), ET)).toBe('2026-10-02');
    expect(localDate(new Date('2026-10-03T03:30:00Z'), CT)).toBe('2026-10-02');
  });

  // Eastern and Central disagree for one hour each night.
  test('zones can disagree about today', () => {
    const t = new Date('2026-10-03T04:30:00Z'); // 00:30 ET, 23:30 CT
    expect(localDate(t, ET)).toBe('2026-10-03');
    expect(localDate(t, CT)).toBe('2026-10-02');
  });
});

describe('localHHMM', () => {
  test('is zero-padded 24-hour', () => {
    // 12:05 UTC = 08:05 EDT
    expect(localHHMM(new Date('2026-10-03T12:05:00Z'), ET)).toBe('08:05');
  });

  // The whole reason this file exists: the same wall-clock time is a
  // different UTC instant before and after DST ends (2026-11-01).
  test('6am Eastern is 10:00 UTC in summer and 11:00 UTC in winter', () => {
    expect(localHHMM(new Date('2026-10-15T10:00:00Z'), ET)).toBe('06:00'); // EDT
    expect(localHHMM(new Date('2026-11-15T11:00:00Z'), ET)).toBe('06:00'); // EST
  });
});

describe('minusDays', () => {
  test('subtracts without timezone drift', () => {
    expect(minusDays('2026-10-03', 1)).toBe('2026-10-02');
  });

  test('crosses a month boundary', () => {
    expect(minusDays('2026-10-01', 1)).toBe('2026-09-30');
  });

  test('crosses the DST boundary without losing a day', () => {
    expect(minusDays('2026-11-02', 1)).toBe('2026-11-01');
  });
});

describe('isAtOrAfter', () => {
  test('true at the boundary minute', () => {
    expect(isAtOrAfter(new Date('2026-10-15T10:00:00Z'), ET, '06:00')).toBe(true);
  });

  test('false a minute before', () => {
    expect(isAtOrAfter(new Date('2026-10-15T09:59:00Z'), ET, '06:00')).toBe(false);
  });

  test('still true later the same day', () => {
    expect(isAtOrAfter(new Date('2026-10-15T20:00:00Z'), ET, '06:00')).toBe(true);
  });

  test('holds after DST ends', () => {
    expect(isAtOrAfter(new Date('2026-11-15T11:00:00Z'), ET, '06:00')).toBe(true);
    expect(isAtOrAfter(new Date('2026-11-15T10:59:00Z'), ET, '06:00')).toBe(false);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/localtime.test.js`
Expected: FAIL — `Cannot find module '../services/localtime'`.

- [x] **Step 3: Write the implementation**

```js
// services/localtime.js
//
// Every local-date and local-time decision in P.AI goes through here.
//
// Why this file exists: Render's cron is UTC-only and has no idea daylight
// saving exists, so a job pinned to a UTC hour runs at 6am Eastern for five
// months a year and 7am for the other seven. Asking the clock what time it is
// *there*, on every tick, is right year-round with no annual edit. The same
// applies to "today": UTC rolls over hours before any US zone does, so a UTC
// date used for a local-day decision is wrong every night.

// YYYY-MM-DD in `tz`. en-CA formats as ISO, which is why it is used here.
function localDate(date, tz) {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

// HH:MM, 24-hour, zero-padded, in `tz`. en-GB gives 24-hour with no AM/PM.
function localHHMM(date, tz) {
  return date.toLocaleTimeString('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Plain string arithmetic on a YYYY-MM-DD, via UTC so no zone can shift it.
function minusDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

// Is the local wall clock in `tz` at or past `hhmm` ("06:00")?
// Lexical compare is safe because both sides are zero-padded HH:MM.
function isAtOrAfter(date, tz, hhmm) {
  return localHHMM(date, tz) >= hhmm;
}

module.exports = { localDate, localHHMM, minusDays, isAtOrAfter };
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/localtime.test.js`
Expected: PASS, all 12 tests.

- [x] **Step 5: Commit**

```bash
git add services/localtime.js tests/localtime.test.js
git commit -m "Add timezone helpers, with DST pinned down by tests

Render's cron is UTC-only and DST-blind, so anything pinned to a UTC
hour drifts an hour twice a year. Asking the clock what time it is in
the target zone on every tick is correct year-round without an annual
edit. Same for 'today': UTC rolls over hours before any US zone, so a
UTC date driving a local-day decision is wrong every night.

The tests assert both sides of the 2026-11-01 boundary, and the one
hour each night when Eastern and Central disagree about the date.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Move the morning pulls to 6:00 AM Eastern

**Files:**
- Modify: `pai/services/scheduler.js`
- Create: `pai/tests/scheduler-gate.test.js`

- [x] **Step 1: Write the failing test**

```js
// tests/scheduler-gate.test.js
const { eligible, PULL_AFTER_LOCAL, PULL_TZ } = require('../services/scheduler');

describe('pull gate', () => {
  test('anchors to 6am Eastern', () => {
    expect(PULL_TZ).toBe('America/New_York');
    expect(PULL_AFTER_LOCAL).toBe('06:00');
  });

  // Yesterday waits for the source report; older gaps are stale already.
  test('yesterday is not eligible before 6am Eastern', () => {
    expect(eligible('2026-10-14', new Date('2026-10-15T09:59:00Z'))).toBe(false); // 05:59 EDT
  });

  test('yesterday is eligible at 6am Eastern', () => {
    expect(eligible('2026-10-14', new Date('2026-10-15T10:00:00Z'))).toBe(true); // 06:00 EDT
  });

  // The point of the change: no annual cron edit.
  test('the gate holds after DST ends', () => {
    expect(eligible('2026-11-14', new Date('2026-11-15T10:59:00Z'))).toBe(false); // 05:59 EST
    expect(eligible('2026-11-14', new Date('2026-11-15T11:00:00Z'))).toBe(true);  // 06:00 EST
  });

  test('an older gap is always eligible', () => {
    expect(eligible('2026-10-10', new Date('2026-10-15T09:00:00Z'))).toBe(true);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx jest tests/scheduler-gate.test.js`
Expected: FAIL — `eligible is not a function` (it is currently module-private and takes no `now`).

- [x] **Step 3: Change the gate**

In `services/scheduler.js`, replace the constant:

```js
const PULL_AFTER_UTC_HOUR = 10;              // same 10:00 UTC as the old cron
```

with:

```js
const PULL_TZ          = 'America/New_York'; // the business day these reports describe
const PULL_AFTER_LOCAL = '06:00';            // 6am Eastern, DST or not
```

Replace the date helpers:

```js
function chicagoToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function minusDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}
```

with a delegation to the shared helpers — the gate and "today" must agree on a
zone, and Eastern and Central disagree for an hour every night:

```js
const { localDate, minusDays, isAtOrAfter } = require('./localtime');

function easternToday() {
  return localDate(new Date(), PULL_TZ);
}

// Kept so existing callers of scheduler.chicagoToday() do not break. It now
// returns Eastern, because every date decision in this module is Eastern.
const chicagoToday = easternToday;
```

Replace `eligible`:

```js
// Yesterday only becomes eligible once the source report exists (10:00 UTC).
// Older gaps are already stale, so fill them whenever we notice.
function eligible(dateStr) {
  if (dateStr !== minusDays(chicagoToday(), 1)) return true;
  return new Date().getUTCHours() >= PULL_AFTER_UTC_HOUR;
}
```

with a version that takes `now`, so it is testable at an arbitrary instant:

```js
// Yesterday only becomes eligible once the source report exists — 6am Eastern.
// Older gaps are already stale, so fill them whenever we notice.
// `now` is injectable so the DST boundaries can be tested.
function eligible(dateStr, now = new Date()) {
  if (dateStr !== minusDays(localDate(now, PULL_TZ), 1)) return true;
  return isAtOrAfter(now, PULL_TZ, PULL_AFTER_LOCAL);
}
```

Update the startup log line:

```js
  console.log(`   Scheduler: velocity auto-pull armed ✓ (every ${TICK_MS / 60000}m, from ${PULL_AFTER_UTC_HOUR}:00 UTC)`);
```

to:

```js
  console.log(`   Scheduler: velocity auto-pull armed ✓ (every ${TICK_MS / 60000}m, from ${PULL_AFTER_LOCAL} ${PULL_TZ})`);
```

And extend the exports:

```js
module.exports = { start, stop, tick, missingDates, minusDays, chicagoToday };
```

to:

```js
module.exports = {
  start, stop, tick, missingDates, minusDays, chicagoToday,
  easternToday, eligible, PULL_TZ, PULL_AFTER_LOCAL,
};
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx jest tests/scheduler-gate.test.js`
Expected: PASS, 5 tests.

- [x] **Step 5: Run the whole suite — nothing else may break**

Run: `npm test`
Expected: PASS. `minusDays` and `chicagoToday` are still exported, so any existing caller keeps working.

- [x] **Step 6: Move the Render cron to 6am Eastern too**

In `render.yaml`, the `intel-dbs-pull` cron:
```yaml
    schedule: "20 10 * * *"
```
becomes:
```yaml
    # 10:00 UTC = 6am Eastern during EDT, 5am during EST. This is only the
    # trigger — services/scheduler.js gates on Eastern local time, so the
    # hour this fires does not decide when the pull is allowed to run.
    schedule: "0 10 * * *"
```

- [x] **Step 7: Fix the stale comment in the cron script**

In `scripts/intel-cron.js`, line 3:
```js
 * Runs at 9 AM UTC via Render cron.
```
becomes:
```js
 * Triggered by the Render cron at 10:00 UTC. It only wakes the web service and
 * calls the pipeline endpoint — the target date (yesterday) and the 6am Eastern
 * gate both live server-side in services/scheduler.js.
```

- [x] **Step 8: Commit**

```bash
git add services/scheduler.js tests/scheduler-gate.test.js render.yaml scripts/intel-cron.js
git commit -m "Pull at 6am Eastern, gated on local time rather than a UTC hour

A UTC-pinned gate runs at 6am Eastern for five months a year and 7am
for the other seven, and nothing surfaces the drift. Reading the local
clock each tick is right on both sides of a DST change with no annual
edit, which the tests assert across 2026-11-01.

The gate and 'today' now agree on Eastern. They disagreed before:
the gate read UTC hours while today read Chicago, and those two part
company for an hour every night. chicagoToday() stays exported as an
alias so existing callers keep working.

eligible() takes an injectable now, which is the only way to test a
DST boundary without waiting for November.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Roster access in P.AI

The sender needs Harold's phone and timezone. RC Tracker's `people.json` has both.

**Files:**
- Create: `pai/data/people.json` (copy)
- Create: `pai/services/rc-people.js`
- Create: `pai/tests/rc-people.test.js`

- [ ] **Step 1: Copy the roster**

```bash
mkdir -p data && cp "../rc-tracker/people.json" data/people.json
```

Expected: `data/people.json` exists and contains `"Harold Lacoste"`. Verify:
```bash
node -e "const p=require('./data/people.json'); console.log(p['Harold Lacoste'])"
```
Expected: an object with `role`, `phone`, `tz`, `rc`, `vp`.

This is a copy, and a copy can drift. Plan 2 reconciles it against P.AI's
`USER_ROSTER` and reports mismatches at startup. For one recipient it is not
worth more than a copy.

- [ ] **Step 2: Write the failing tests**

```js
// tests/rc-people.test.js
const { getPerson, nameForUsername } = require('../services/rc-people');

describe('getPerson', () => {
  test('returns phone and timezone', () => {
    const p = getPerson('Harold Lacoste');
    expect(p.phone).toMatch(/^\+1\d{10}$/);
    expect(p.tz).toBe('America/New_York');
  });

  test('returns null for someone not on the roster', () => {
    expect(getPerson('Nobody At All')).toBeNull();
  });

  test('returns null rather than throwing on a missing name', () => {
    expect(getPerson(undefined)).toBeNull();
  });
});

describe('nameForUsername', () => {
  test('maps a P.AI username to a roster name', () => {
    expect(nameForUsername('hlacoste')).toBe('Harold Lacoste');
  });

  test('returns null for an unknown username', () => {
    expect(nameForUsername('nosuchuser')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest tests/rc-people.test.js`
Expected: FAIL — `Cannot find module '../services/rc-people'`.

- [ ] **Step 4: Write the implementation**

```js
// services/rc-people.js
// Phone and timezone for a person, from RC Tracker's roster.
//
// data/people.json is a copy of rc-tracker/people.json. Plan 2 reconciles it
// against P.AI's own USER_ROSTER; until then a copy is enough for one recipient.

const PEOPLE = require('../data/people.json');
const { USER_ROSTER } = require('../routes/auth');

function getPerson(name) {
  if (!name) return null;
  return PEOPLE[name] || null;
}

function nameForUsername(username) {
  if (!username) return null;
  const u = USER_ROSTER.find(r => r.username === username);
  return u ? u.name : null;
}

module.exports = { getPerson, nameForUsername, PEOPLE };
```

- [x] **Step 5: Export the roster so this module can read it — ALREADY DONE**

This was written expecting `routes/auth.js` to end at `module.exports = router;`.
A concurrent session's commit `363ca7e` added the export first, for the Intel
module's cache generation, and it is exactly the form this plan needed:

```js
module.exports = router;

// Export USER_ROSTER for Intel module cache generation
module.exports.USER_ROSTER = USER_ROSTER;
```

Attaching to the router keeps `require('./routes/auth')` working as an Express
router for `server.js`, while exposing the roster as a property. Replacing the
export with an object would break the existing `app.use` mount.

**Verify rather than edit:**
```bash
node -e "console.log(require('./routes/auth').USER_ROSTER.length, 'users')"
```
Expected: a count in the sixties. If this throws, the export was reverted and
the change above must be reapplied.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest tests/rc-people.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 7: Confirm the server still boots**

Run: `node -e "require('./server.js')" ` then stop it with Ctrl-C after the
startup banner prints.
Expected: the usual startup lines, no `TypeError` about the auth router.

- [ ] **Step 8: Commit**

```bash
git add data/people.json services/rc-people.js routes/auth.js tests/rc-people.test.js
git commit -m "Give P.AI phone numbers and timezones for the roster

The brief sender needs a phone and a zone per recipient, and RC
Tracker's people.json already has both for all 62 people. Copied rather
than shared because the two apps deploy separately; plan 2 reconciles
the copy against USER_ROSTER and reports drift at startup.

USER_ROSTER is exposed as a property on the auth router rather than by
replacing module.exports, so the existing app.use mount keeps working.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Supabase client in P.AI

**Files:**
- Create: `pai/services/rc-db.js`

- [ ] **Step 1: Write the client**

```js
// services/rc-db.js
//
// P.AI's seam onto RC Tracker's Supabase. Follow-ups, SMS history and consent
// live there, and this plan reads and writes them in place rather than
// migrating — no migration means no window in which rows can be lost.
//
// Spec Phase 7 consolidates into pai-db. This file is the only thing that has
// to change when that happens, which is the point of having it.
//
// Two clients, mirroring RC Tracker: anon for ordinary reads, service for the
// tables under row-level security (sms_messages, sms_consent, sms_reminders).

const { createClient } = require('@supabase/supabase-js');

let anon    = null;
let service = null;

function makeClient(key) {
  const url = process.env.SUPABASE_URL;
  if (!url || !key) return null;        // not configured — callers degrade
  return createClient(url, key, { auth: { persistSession: false } });
}

function getClient() {
  if (!anon) anon = makeClient(process.env.SUPABASE_ANON_KEY);
  return anon;
}

function getServiceClient() {
  if (!service) service = makeClient(process.env.SUPABASE_SERVICE_KEY);
  return service;
}

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

module.exports = { getClient, getServiceClient, isConfigured };
```

- [ ] **Step 2: Smoke test it read-only against live**

```bash
node -e "
const rc = require('./services/rc-db');
rc.getServiceClient().from('follow_ups').select('*', { count: 'exact', head: true })
  .then(r => console.log('follow_ups rows:', r.count, 'error:', r.error && r.error.message));
"
```
Expected: a row count matching what Task 1's backup reported for `follow_ups`, and `error: undefined`.

Read-only. Nothing is written in this task.

- [ ] **Step 3: Commit**

```bash
git add services/rc-db.js
git commit -m "Add P.AI's client onto RC Tracker's Supabase

Follow-ups, SMS history and consent stay where they are, and P.AI reads
and writes them in place. Migrating them would open a window in which
rows can go missing, and nothing about texting a brief needs them moved.

One file so that spec Phase 7, which consolidates into pai-db, has
exactly one place to change. Two clients because RC Tracker's SMS
tables are under row-level security and the anon key cannot see them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Make one-brief-per-day atomic

The claim has to be atomic, or two overlapping ticks both pass a "has it been sent?" check and both send.

**Files:**
- Create: `rc-tracker/supabase/migrations/008_brief_claim.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 008_brief_claim.sql
--
-- One brief per person per local day, enforced by the database.
--
-- The brief sender inserts the claim row BEFORE calling Twilio. If two ticks
-- overlap, or the process restarts mid-send, the second insert violates this
-- index and that sender backs off. A SELECT-then-INSERT cannot do this: both
-- callers read "nothing sent" and both send.
--
-- Partial, so it constrains only kind='brief'. Existing digest and summary
-- rows are untouched and may still repeat within a day as they do today.

create unique index if not exists sms_reminders_brief_once_idx
  on sms_reminders (person, local_date)
  where kind = 'brief';
```

- [ ] **Step 2: Check the index cannot collide with existing rows**

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
sb.from('sms_reminders').select('id', { count: 'exact', head: true }).eq('kind','brief')
  .then(r => console.log(\"existing kind='brief' rows:\", r.count));
"
```
Expected: `0`. The index is partial on a kind nothing has ever written, so it cannot fail to build or reject an existing row.

**If this is not 0, stop** and check those rows for duplicate `(person, local_date)` pairs before applying the index.

- [ ] **Step 3: Apply it**

Run the SQL in the Supabase SQL editor for RC Tracker's project.
Expected: `Success. No rows returned.`

- [ ] **Step 4: Confirm it exists**

```sql
select indexname from pg_indexes where tablename = 'sms_reminders';
```
Expected: the list includes `sms_reminders_brief_once_idx`.

- [ ] **Step 5: Confirm RC Tracker still passes its own tests**

Run in `rc-tracker`:
```bash
npm test
```
Expected: PASS. An index adds no behavior; this run is to prove it.

- [ ] **Step 6: Commit (in the rc-tracker repo)**

```bash
cd "../rc-tracker"
git add supabase/migrations/008_brief_claim.sql
git commit -m "Let the database enforce one brief per person per day

The brief sender claims by inserting before it calls Twilio, so a
unique index is what actually stops a double-text. Checking first and
inserting after cannot: two overlapping ticks both read 'nothing sent'
and both send, and a restart mid-send does the same.

Partial on kind='brief', so digest and summary rows are untouched and
can still repeat within a day the way they do now.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
cd "../pai"
```

---

## Task 8: Condense a brief to text length

**Files:**
- Create: `pai/services/brief-sms.js` (first half)
- Create: `pai/tests/brief-condense.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brief-condense.test.js
const { condense, MAX_SMS_CHARS, buildLink } = require('../services/brief-sms');

const FAKE_BRIEF = `MORNING BRIEF — Oct 3, 2026 — P8W2
Results from Oct 2 (Friday)

PERFORMANCE
Sales: $412,880 — up 3.2% vs LY. Transactions down 1.1%.
Labor: 27.4% vs 26.0% target — 1.4 points over, driven by Area 2016.

FLAGS
3 stores with Cancel After Tender over threshold: 39393 Lovejoy,
39461 County Line, 39521 Kellytown.
Forgot Clock Out: 11 instances, 7 at 39383 Stockbridge.

SHOUTOUTS
Jadon McNeil's area hit 100% on Crispy Pan execution.`;

// The model is not called in unit tests — it is injected.
function fakeModel(text) {
  return async () => text;
}

describe('condense', () => {
  test('stays within one concatenated message', async () => {
    const out = await condense(FAKE_BRIEF, 'https://pai-ayvaz.onrender.com/intel.html', {
      callModel: fakeModel('Sales +3.2%, labor 1.4pts over. 3 CAT stores, 11 forgot clock-outs.'),
    });
    expect(out.length).toBeLessThanOrEqual(MAX_SMS_CHARS);
  });

  test('always carries the link, even if the model omits it', async () => {
    const out = await condense(FAKE_BRIEF, 'https://pai-ayvaz.onrender.com/intel.html', {
      callModel: fakeModel('Sales +3.2%, labor over.'),
    });
    expect(out).toContain('https://pai-ayvaz.onrender.com/intel.html');
  });

  // A model that ignores the length instruction must not produce a 7-part text.
  test('truncates an over-long model response rather than sending it', async () => {
    const out = await condense(FAKE_BRIEF, 'https://x.co/b', {
      callModel: fakeModel('x'.repeat(2000)),
    });
    expect(out.length).toBeLessThanOrEqual(MAX_SMS_CHARS);
    expect(out).toContain('https://x.co/b');
  });

  // If the model is unreachable at 8:05 the brief still goes out.
  test('falls back to the brief first lines when the model throws', async () => {
    const out = await condense(FAKE_BRIEF, 'https://x.co/b', {
      callModel: async () => { throw new Error('rate limit'); },
    });
    expect(out.length).toBeLessThanOrEqual(MAX_SMS_CHARS);
    expect(out).toContain('https://x.co/b');
    expect(out.toLowerCase()).toContain('brief');
  });

  test('returns null for an empty brief rather than texting nothing', async () => {
    expect(await condense('', 'https://x.co/b', { callModel: fakeModel('hi') })).toBeNull();
    expect(await condense(null, 'https://x.co/b', { callModel: fakeModel('hi') })).toBeNull();
  });
});

describe('buildLink', () => {
  test('uses PAI_BASE_URL when set', () => {
    expect(buildLink({ PAI_BASE_URL: 'https://example.com' })).toBe('https://example.com/intel.html');
  });

  test('falls back to the known deployment', () => {
    expect(buildLink({})).toBe('https://pai-ayvaz.onrender.com/intel.html');
  });

  test('does not double the slash', () => {
    expect(buildLink({ PAI_BASE_URL: 'https://example.com/' })).toBe('https://example.com/intel.html');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/brief-condense.test.js`
Expected: FAIL — `Cannot find module '../services/brief-sms'`.

- [ ] **Step 3: Write the implementation**

```js
// services/brief-sms.js
//
// Texts P.AI's already-generated morning brief.
//
// The brief itself is not generated here — services/intel-pipeline.js caches one
// per person every morning. This file condenses that cached text, decides who is
// due, claims the send, calls Twilio and logs the result.
//
// Outbound only. RC Tracker owns the inbound webhook, so nothing here affects
// replies, STOP/START or delivery callbacks.

const Anthropic = require('@anthropic-ai/sdk');

// 320 = two concatenated GSM-7 segments. Enough for a headline, a few numbers
// and a link; short enough that it does not arrive as a wall of text.
const MAX_SMS_CHARS = 320;

// The rest of P.AI is on claude-sonnet-4-6 (services/claude.js:8). This picks
// its own model so that upgrading the brief does not change P&L analysis
// output, and vice versa.
const BRIEF_MODEL = process.env.BRIEF_MODEL || 'claude-sonnet-5';

function buildLink(env = process.env) {
  const base = (env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com').replace(/\/+$/, '');
  return `${base}/intel.html`;
}

// Cut to `max` on a word boundary where possible, never mid-word.
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp  = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}

// Last resort when the model is unreachable: the brief's own opening lines.
// A plain, slightly clumsy text beats no text at 8:05.
function fallback(briefText, link) {
  const body = briefText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^(MORNING BRIEF|Results from)/i.test(l))
    .join(' ');
  const room = MAX_SMS_CHARS - link.length - 'Morning brief: '.length - 1;
  return `Morning brief: ${clip(body, room)} ${link}`;
}

async function callClaude(prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: BRIEF_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content.map(c => c.text || '').join('').trim();
}

/**
 * Condense a full morning brief into one short text, always ending in `link`.
 * Returns null when there is no brief to condense.
 * `deps.callModel` is injected by tests so no network call happens there.
 */
async function condense(briefText, link, deps = {}) {
  if (!briefText || !briefText.trim()) return null;

  const callModel = deps.callModel || callClaude;
  const room      = MAX_SMS_CHARS - link.length - 1;

  const prompt = `Condense this morning brief into a single SMS of at most ${room} characters.

Rules:
- Lead with the single most important number or problem.
- Then at most two more items, whichever a Region Coach would act on first.
- Plain text. No markdown, no emoji, no greeting, no sign-off.
- Do not include any URL — one is appended for you.
- Numbers exactly as given. Never round, never invent.

BRIEF:
${briefText}`;

  let body;
  try {
    body = await callModel(prompt);
  } catch (err) {
    console.error('[BriefSMS] condense failed, using fallback:', err.message);
    return clip(fallback(briefText, link), MAX_SMS_CHARS);
  }

  if (!body || !body.trim()) return clip(fallback(briefText, link), MAX_SMS_CHARS);

  // Strip any URL the model added despite the instruction, so the link is not
  // duplicated, then append the real one.
  body = body.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

  return `${clip(body, room)} ${link}`.trim();
}

module.exports = { condense, buildLink, clip, MAX_SMS_CHARS, BRIEF_MODEL };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/brief-condense.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add services/brief-sms.js tests/brief-condense.test.js
git commit -m "Condense a morning brief down to one text

The brief is already generated and cached per person every morning, so
this only shortens it. 320 characters is two GSM-7 segments: room for a
headline, a few numbers and a link, without arriving as a wall of text.

The model is told not to include a URL and the output is stripped of
URLs anyway, because an instruction is not a guarantee and a duplicated
link wastes a third of the message. Over-long responses are clipped on
a word boundary rather than sent as a seven-part text.

If the model is unreachable at 8:05 the brief still goes out, built
from the brief's own opening lines. A clumsy text beats no text.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Decide who is due

Pure decision logic, no I/O — so the window, the consent gate and the
once-a-day rule can be tested without a clock or a network.

**Files:**
- Modify: `pai/services/brief-sms.js`
- Create: `pai/tests/brief-due.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brief-due.test.js
const { isDue, recipients, SEND_WINDOW_MINUTES } = require('../services/brief-sms');

const HAROLD = { name: 'Harold Lacoste', username: 'hlacoste', phone: '+12258101361', tz: 'America/New_York' };

describe('isDue', () => {
  const base = { person: HAROLD, sendLocal: '08:05', consented: true, alreadySentDates: [] };

  test('due at the send time', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T12:05:00Z') })).toBe(true); // 08:05 EDT
  });

  test('not due before the send time', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T12:04:00Z') })).toBe(false); // 08:04 EDT
  });

  // A restart or a slow tick must not mean a skipped day.
  test('still due a few minutes late', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T12:12:00Z') })).toBe(true); // 08:12 EDT
  });

  // But an app that boots at 4pm must not fire the morning brief.
  test('not due once the window has closed', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T20:00:00Z') })).toBe(false); // 16:00 EDT
  });

  test('window is explicit, not accidental', () => {
    expect(SEND_WINDOW_MINUTES).toBe(30);
  });

  test('not due twice on the same local date', () => {
    expect(isDue({
      ...base,
      now: new Date('2026-10-05T12:05:00Z'),
      alreadySentDates: ['2026-10-05'],
    })).toBe(false);
  });

  test('due again the next day', () => {
    expect(isDue({
      ...base,
      now: new Date('2026-10-06T12:05:00Z'),
      alreadySentDates: ['2026-10-05'],
    })).toBe(true);
  });

  test('never due without consent', () => {
    expect(isDue({ ...base, now: new Date('2026-10-05T12:05:00Z'), consented: false })).toBe(false);
  });

  test('never due without a phone number', () => {
    expect(isDue({
      ...base,
      person: { ...HAROLD, phone: '' },
      now: new Date('2026-10-05T12:05:00Z'),
    })).toBe(false);
  });

  // 8:05 means 8:05 where they are, in November as in October.
  test('holds after DST ends', () => {
    expect(isDue({ ...base, now: new Date('2026-11-05T13:05:00Z') })).toBe(true);  // 08:05 EST
    expect(isDue({ ...base, now: new Date('2026-11-05T12:05:00Z') })).toBe(false); // 07:05 EST
  });

  // Central and Mountain recipients get their own 8:05, not Harold's.
  test('each zone gets its own local 8:05', () => {
    const ct = { ...HAROLD, name: 'Jerry Warren', tz: 'America/Chicago' };
    expect(isDue({ ...base, person: ct, now: new Date('2026-10-05T13:05:00Z') })).toBe(true);  // 08:05 CDT
    expect(isDue({ ...base, person: ct, now: new Date('2026-10-05T12:05:00Z') })).toBe(false); // 07:05 CDT
  });
});

describe('recipients', () => {
  test('defaults to Harold alone', () => {
    expect(recipients({})).toEqual(['hlacoste']);
  });

  test('reads a comma list from the environment', () => {
    expect(recipients({ PAI_BRIEF_RECIPIENTS: 'hlacoste,jwarren' })).toEqual(['hlacoste', 'jwarren']);
  });

  test('tolerates spaces and trailing commas', () => {
    expect(recipients({ PAI_BRIEF_RECIPIENTS: ' hlacoste , jwarren , ' })).toEqual(['hlacoste', 'jwarren']);
  });

  test('an empty setting means send to nobody, not to everybody', () => {
    expect(recipients({ PAI_BRIEF_RECIPIENTS: '' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/brief-due.test.js`
Expected: FAIL — `isDue is not a function`.

- [ ] **Step 3: Add the decision logic**

In `services/brief-sms.js`, add below the existing constants:

```js
const { localDate, localHHMM } = require('./localtime');

// How late a send may still go out. A tick that is delayed, or an app that
// restarts at 8:07, should still send. An app that boots at 4pm should not.
const SEND_WINDOW_MINUTES = 30;

const DEFAULT_SEND_LOCAL = '08:05';

function recipients(env = process.env) {
  // Deliberately explicit: an empty setting sends to nobody. Defaulting an
  // empty value to "everyone" is how 62 people get an unexpected text.
  if (env.PAI_BRIEF_RECIPIENTS === undefined) return ['hlacoste'];
  return env.PAI_BRIEF_RECIPIENTS.split(',').map(s => s.trim()).filter(Boolean);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Is this person due their brief right now?
 * Pure — every input is passed in, so no clock or network is needed to test it.
 */
function isDue({ person, now, sendLocal = DEFAULT_SEND_LOCAL, consented, alreadySentDates = [] }) {
  if (!person || !person.phone || !person.tz) return false;
  if (!consented) return false;

  const today = localDate(now, person.tz);
  if (alreadySentDates.includes(today)) return false;

  const nowMin = toMinutes(localHHMM(now, person.tz));
  const dueMin = toMinutes(sendLocal);
  return nowMin >= dueMin && nowMin < dueMin + SEND_WINDOW_MINUTES;
}
```

And extend the exports:

```js
module.exports = { condense, buildLink, clip, MAX_SMS_CHARS, BRIEF_MODEL };
```

to:

```js
module.exports = {
  condense, buildLink, clip, isDue, recipients,
  MAX_SMS_CHARS, BRIEF_MODEL, SEND_WINDOW_MINUTES, DEFAULT_SEND_LOCAL,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/brief-due.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add services/brief-sms.js tests/brief-due.test.js
git commit -m "Decide who is due a brief, as pure logic

Every input is passed in, so the window, the consent gate, the
once-a-day rule and three timezones are all testable without a clock or
a network. The DST assertions are the reason: they would otherwise be
untestable until November.

A 30-minute window, because a delayed tick or an 8:07 restart should
still send while a 4pm boot should not. An empty PAI_BRIEF_RECIPIENTS
means nobody rather than everybody — defaulting empty to 'all' is how
62 people get a text nobody intended.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Send it

**Files:**
- Modify: `pai/services/brief-sms.js`

- [ ] **Step 1: Add the send path**

In `services/brief-sms.js`, add below `isDue`:

```js
const db       = require('./db');
const rcDb     = require('./rc-db');
const people   = require('./rc-people');

// ── Supabase reads/writes ────────────────────────────────────────────────────

// Has this person ever opted in and not since opted out? Latest row wins,
// which is how RC Tracker's consent log is shaped (one append per event).
async function hasConsent(personName, phone) {
  const sb = rcDb.getServiceClient();
  if (!sb) return false;
  const { data, error } = await sb
    .from('sms_consent')
    .select('status')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) { console.error('[BriefSMS] consent lookup failed:', error.message); return false; }
  return Boolean(data && data[0] && data[0].status === 'opted_in');
}

async function sentDates(personName) {
  const sb = rcDb.getServiceClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('sms_reminders')
    .select('local_date')
    .eq('person', personName)
    .eq('kind', 'brief')
    .order('created_at', { ascending: false })
    .limit(7);
  if (error) { console.error('[BriefSMS] sent-date lookup failed:', error.message); return []; }
  return (data || []).map(r => r.local_date);
}

/**
 * Claim today's send by inserting before anything is sent.
 * Returns the claim row's id, or null if someone else already holds it.
 * The unique index from migration 008 is what makes this atomic — a
 * select-then-send would let two overlapping ticks both send.
 */
async function claim(personName, phone, localDateStr, body) {
  const sb = rcDb.getServiceClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('sms_reminders')
    .insert({ person: personName, phone, kind: 'brief', local_date: localDateStr, body, item_ids: [] })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation: another tick holds today's claim. Not an error.
    if (error.code === '23505') return null;
    console.error('[BriefSMS] claim failed:', error.message);
    return null;
  }
  return data.id;
}

async function releaseClaim(id) {
  const sb = rcDb.getServiceClient();
  if (!sb || !id) return;
  const { error } = await sb.from('sms_reminders').delete().eq('id', id);
  if (error) console.error('[BriefSMS] claim release failed:', error.message);
}

async function recordClaimResult(id, { twilioSid, errorText }) {
  const sb = rcDb.getServiceClient();
  if (!sb || !id) return;
  await sb.from('sms_reminders').update({ twilio_sid: twilioSid || null, error: errorText || null }).eq('id', id);
}

async function logMessage({ personName, phone, body, twilioSid, status, errorText }) {
  const sb = rcDb.getServiceClient();
  if (!sb) return;
  const { error } = await sb.from('sms_messages').insert({
    direction: 'outbound', person: personName, phone, body,
    kind: 'brief', status, twilio_sid: twilioSid || null,
    error: errorText || null, media: [], follow_up_ids: [], sent_by: 'pai-brief',
  });
  if (error) console.error('[BriefSMS] message log failed:', error.message);
}

// ── Twilio ───────────────────────────────────────────────────────────────────

async function sendText(to, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error('Twilio is not configured');
  }
  const client = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const msg = await client.messages.create({ to, from: TWILIO_FROM_NUMBER, body });
  return msg.sid;
}

// ── One person ───────────────────────────────────────────────────────────────

/**
 * Send one person their brief if they are due it.
 * Returns a short reason string, which the tick logs. Never throws.
 */
async function sendOne(username, now = new Date()) {
  const personName = people.nameForUsername(username);
  if (!personName) return `${username}: not on the roster`;

  const person = people.getPerson(personName);
  if (!person) return `${personName}: no phone or timezone`;

  const today = require('./localtime').localDate(now, person.tz);

  const [consented, already] = await Promise.all([
    hasConsent(personName, person.phone),
    sentDates(personName),
  ]);

  if (!isDue({
    person: { ...person, name: personName }, now,
    sendLocal: process.env.PAI_BRIEF_SEND_LOCAL_TIME || DEFAULT_SEND_LOCAL,
    consented, alreadySentDates: already,
  })) return null;   // not due — silent, this happens on most ticks

  // The brief describes yesterday, and the pipeline caches it under that date.
  const cached = await db.getIntelCache({ userId: `${username}::brief`, cacheDate: today });
  const memo   = cached && cached.data && cached.data.memo_text;

  // No brief yet: say nothing and try again next tick. Never reach back to an
  // older cache_date — a late text is recoverable, yesterday's numbers labelled
  // as today's are not.
  if (!memo) return `${personName}: brief for ${today} not cached yet — will retry`;

  const body = await condense(memo, buildLink());
  if (!body) return `${personName}: brief condensed to nothing`;

  const claimId = await claim(personName, person.phone, today, body);
  if (!claimId) return null;   // someone else holds today's claim

  try {
    const sid = await sendText(person.phone, body);
    await recordClaimResult(claimId, { twilioSid: sid });
    await logMessage({ personName, phone: person.phone, body, twilioSid: sid, status: 'sent' });
    return `${personName}: sent (${sid})`;
  } catch (err) {
    // Release the claim so the next tick can retry inside the window. Holding a
    // claim for a send that never happened means a silently skipped day.
    await releaseClaim(claimId);
    await logMessage({ personName, phone: person.phone, body, status: 'failed', errorText: err.message });
    return `${personName}: send failed — ${err.message}`;
  }
}

async function tick(now = new Date()) {
  if (!rcDb.isConfigured()) return;
  for (const username of recipients()) {
    try {
      const outcome = await sendOne(username, now);
      if (outcome) console.log(`[BriefSMS] ${outcome}`);
    } catch (err) {
      console.error(`[BriefSMS] ${username} failed:`, err.message);
    }
  }
}
```

Extend the exports to:

```js
module.exports = {
  condense, buildLink, clip, isDue, recipients, sendOne, tick,
  hasConsent, sentDates, claim, releaseClaim,
  MAX_SMS_CHARS, BRIEF_MODEL, SEND_WINDOW_MINUTES, DEFAULT_SEND_LOCAL,
};
```

- [ ] **Step 2: Confirm nothing regressed**

Run: `npm test`
Expected: PASS, all tests from Tasks 2, 3, 4, 5, 8 and 9.

- [ ] **Step 3: Prove the claim is actually atomic, against live Supabase**

```bash
node -e "
const b = require('./services/brief-sms');
const d = '2099-01-01';   // far-future date, cleaned up below
Promise.all([
  b.claim('Harold Lacoste', '+10000000000', d, 'claim test A'),
  b.claim('Harold Lacoste', '+10000000000', d, 'claim test B'),
]).then(async ([a, c]) => {
  const won = [a, c].filter(Boolean);
  console.log('claims granted:', won.length, '(must be 1)');
  for (const id of won) await b.releaseClaim(id);
  console.log('cleaned up');
  process.exit(won.length === 1 ? 0 : 1);
});
"
```
Expected: `claims granted: 1 (must be 1)` then `cleaned up`, exit 0.

**If this prints 2, stop.** The index from Task 7 is missing or not partial on
`kind='brief'`, and two ticks will double-text.

- [ ] **Step 4: Commit**

```bash
git add services/brief-sms.js
git commit -m "Send the brief, claiming the day before calling Twilio

The claim row is inserted first and the unique index decides who won,
so two overlapping ticks cannot both send. A failed send releases the
claim rather than keeping it, because a held claim for a text that
never arrived is a silently skipped morning.

A missing brief is not an error and not a reason to improvise: the tick
says so and retries, and never reaches back to an older cache_date. A
late text is recoverable; yesterday's numbers labelled as today's go
into someone's decisions.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Arm the timer and configure the environment

**Files:**
- Modify: `pai/server.js`
- Modify: `pai/render.yaml`

- [ ] **Step 1: Arm the timer at boot**

In `server.js`, after the existing scheduler start (line 125):

```js
    require('./services/scheduler').start();
```

add:

```js
    // Its own 2-minute timer, not the 15-minute scheduler tick: an :05 target
    // cannot be hit by a 15-minute cadence, which would scatter an 8:05 text
    // anywhere up to 8:20.
    const briefSms = require('./services/brief-sms');
    if (process.env.ENABLE_BRIEF_SMS === 'false') {
      console.log('   Brief SMS: disabled (ENABLE_BRIEF_SMS=false)');
    } else {
      setInterval(() => { briefSms.tick().catch(e => console.error('[BriefSMS] tick:', e.message)); }, 2 * 60 * 1000);
      console.log(`   Brief SMS: armed ✓ (every 2m, ${process.env.PAI_BRIEF_SEND_LOCAL_TIME || '08:05'} local)`);
    }
```

- [ ] **Step 2: Add the environment variables**

In `render.yaml`, inside the `pai-ayvaz` service's `envVars`, after the
`INTEL_AUTOMATION_TOKEN` entry:

```yaml
      # ── RC Tracker's Supabase (follow-ups, SMS history, consent) ──
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: SUPABASE_SERVICE_KEY
        sync: false
      # ── Twilio — the SAME number RC Tracker uses. Outbound only; RC
      #    Tracker still owns the inbound webhook until spec Phase 6. ──
      - key: TWILIO_ACCOUNT_SID
        sync: false
      - key: TWILIO_AUTH_TOKEN
        sync: false
      - key: TWILIO_FROM_NUMBER
        sync: false
      # ── Morning brief by text ──
      - key: PAI_BASE_URL
        value: https://pai-ayvaz.onrender.com
      - key: PAI_BRIEF_RECIPIENTS
        value: hlacoste
      - key: PAI_BRIEF_SEND_LOCAL_TIME
        value: "08:05"
```

- [ ] **Step 3: Set the three secrets in Render**

In the Render dashboard for `pai-ayvaz`, set `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` to the same values RC Tracker uses.

Do not change anything in RC Tracker's own environment. It keeps its number,
its webhook and its credentials exactly as they are.

- [ ] **Step 4: Confirm the server boots with the timer armed**

Run locally with the environment set, then stop after the banner:
```bash
node server.js
```
Expected: the banner includes `Brief SMS: armed ✓ (every 2m, 08:05 local)`.

- [ ] **Step 5: Commit**

```bash
git add server.js render.yaml
git commit -m "Arm the brief sender on its own two-minute timer

The existing scheduler ticks every 15 minutes, which cannot hit an :05
target — an 8:05 text would land anywhere up to 8:20. A separate
two-minute timer keeps the brief punctual without retuning the ODS
pull's cadence.

Twilio and Supabase point at the same credentials RC Tracker uses.
Outbound only: RC Tracker keeps the inbound webhook, so its replies,
STOP/START and delivery callbacks are untouched.

ENABLE_BRIEF_SMS=false is the off switch, matching the scheduler's own.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: Prove it end to end

**Files:** none — this task only runs things.

- [ ] **Step 1: Confirm Harold's consent is on file**

```bash
node -e "
const b = require('./services/brief-sms');
b.hasConsent('Harold Lacoste', '+12258101361').then(c => console.log('consented:', c));
"
```
Expected: `consented: true`.

**If false, stop.** Opt in through RC Tracker's `/sms-opt-in` page first. Do not
bypass the consent check — that row is the TCPA record.

- [ ] **Step 2: Confirm today's brief is cached**

```bash
node -e "
const db = require('./services/db');
const { localDate } = require('./services/localtime');
const d = localDate(new Date(), 'America/New_York');
db.getIntelCache({ userId: 'hlacoste::brief', cacheDate: d })
  .then(r => console.log(d, r ? 'cached, ' + r.data.memo_text.length + ' chars' : 'NOT CACHED'));
"
```
Expected: today's date and a character count in the hundreds.

If `NOT CACHED`, the pipeline has not run for today yet. That is the exact
condition the sender's guard handles — it is not a failure of this plan.

- [ ] **Step 3: See the text without sending it**

```bash
node -e "
const b  = require('./services/brief-sms');
const db = require('./services/db');
const { localDate } = require('./services/localtime');
const d = localDate(new Date(), 'America/New_York');
db.getIntelCache({ userId: 'hlacoste::brief', cacheDate: d }).then(async r => {
  const out = await b.condense(r.data.memo_text, b.buildLink());
  console.log('--- ' + out.length + ' chars ---');
  console.log(out);
});
"
```
Expected: 320 characters or fewer, ending in the `intel.html` link, numbers
matching the cached brief. **Read it. Check the numbers against the full brief
before any text goes out.**

- [ ] **Step 4: Send one real text, outside the window, on purpose**

`sendOne` will not fire outside the send window, so call the pieces directly to
force exactly one real message:

```bash
node -e "
const b  = require('./services/brief-sms');
const db = require('./services/db');
const { localDate } = require('./services/localtime');
const tz = 'America/New_York';
const d  = localDate(new Date(), tz);
db.getIntelCache({ userId: 'hlacoste::brief', cacheDate: d }).then(async r => {
  const body = await b.condense(r.data.memo_text, b.buildLink());
  const id   = await b.claim('Harold Lacoste', '+12258101361', d, body);
  if (!id) return console.log('already claimed for ' + d + ' — nothing sent');
  console.log('claimed, sending...');
  const out = await b.sendOne('hlacoste', new Date());
  console.log(out);
});
"
```

Expected: the claim is granted, and the text arrives on Harold's phone within a
few seconds.

Note the claim now exists for today, so the 8:05 timer will correctly not send a
second one. That is the behavior being proven.

- [ ] **Step 5: Confirm it was logged where RC Tracker can see it**

```bash
node -e "
const rc = require('./services/rc-db');
rc.getServiceClient().from('sms_messages')
  .select('created_at,person,kind,status,twilio_sid,body')
  .eq('kind','brief').order('created_at',{ascending:false}).limit(1)
  .then(r => console.log(r.data));
"
```
Expected: one row, `status: 'sent'`, a `twilio_sid`, and the body you read in
Step 3. It should also be visible in RC Tracker's Messages tab, because both
apps read the same table.

- [ ] **Step 6: Confirm RC Tracker is unharmed**

1. Open the RC Tracker website. Load the Follow-ups, Messages, Maintenance and
   Resume tabs. All render as before.
2. Text the Twilio number from a phone. RC Tracker's inbound handling responds
   exactly as it did — P.AI never touched the webhook.
3. Run RC Tracker's tests:
   ```bash
   cd "../rc-tracker" && npm test && cd "../pai"
   ```
   Expected: PASS.

- [ ] **Step 7: Watch one real morning**

The morning after deploying, confirm:
- the text arrives between 8:05 and 8:10 Eastern
- its numbers match the brief in P.AI for the previous day
- exactly one arrives
- `sms_reminders` holds exactly one `kind='brief'` row for that date

- [ ] **Step 8: Commit the plan's completion note**

```bash
git commit --allow-empty -m "Brief by text is live

Verified end to end: consent on file, brief cached, text read before
sending, one real send logged to sms_messages where RC Tracker can see
it, RC Tracker's own tabs and inbound SMS unaffected, its tests passing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Phase 0 → Task 1. Phase 1 → Tasks 2, 5, 6. Pipeline retime
→ Tasks 3, 4. Phase 5 → Tasks 7, 8, 9, 10, 11. Verification → Task 12. Phases
2, 3, 4 and 6 are out of this plan by design and named in the plan sequence
table. The spec's testing list items 1 (`visibleRows`) and 5 (matrix key
rewrite) belong to plan 2; items 3, 4 and 6 are covered here by Tasks 8, 9/10
and 4.

**Type consistency.** `condense(briefText, link, deps)`, `isDue({person, now,
sendLocal, consented, alreadySentDates})`, `claim(person, phone, localDate,
body)` and `localDate(date, tz)` keep the same signatures everywhere they
appear. `MAX_SMS_CHARS`, `SEND_WINDOW_MINUTES` and `DEFAULT_SEND_LOCAL` are
defined in Task 8 or 9 before any later use.

**Known gap, deliberate.** `sendOne`, `hasConsent`, `sentDates` and `claim` are
covered by live smoke tests (Task 10 step 3, Task 12) rather than unit tests,
because mocking the Supabase client's chained builder costs more than it proves
and the atomicity claim is only meaningful against a real unique index. The
pure logic those functions wrap — the window, the consent gate, the once-a-day
rule, the length ceiling — is unit-tested.
