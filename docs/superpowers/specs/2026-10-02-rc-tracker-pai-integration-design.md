# RC Tracker → P.AI Integration — Design

**Date:** 2026-10-02
**Status:** Approved design, pending implementation plan
**Repos:** `Desktop/rc-tracker` (source), `Desktop/pai` (destination)

## Objective

Bring RC Tracker's Region matrix, One-on-Ones, AOP, Inbox, Follow-ups, Messages and
the SMS/reminders engine into P.AI, so they sit behind P.AI's existing login and each
person sees only their own scope. Use RC Tracker's existing Twilio number — unchanged,
no new number — to text P.AI's already-generated per-person morning brief at 8:05 AM
in each recipient's local timezone.

Maintenance and the resume/candidate tracker stay on the RC Tracker website, which
keeps running. All data is copied, never moved. Nothing is lost, and no edit in one
app can erase an edit in the other.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Database strategy | Hybrid: P.AI reads/writes RC Tracker's Supabase now, consolidate into `pai-db` later | No migration means no data-loss window. Gets briefs-by-text working soonest. Consolidation becomes a deliberate later step, not a prerequisite. |
| Twilio number | Reuse the existing number | User requirement. Outbound sends need no webhook, so P.AI can text briefs while RC Tracker keeps owning inbound. |
| Inbound webhook during testing | Stays on RC Tracker | A number's webhook can only point at one app. Leaving it put means RC Tracker's two-way SMS is untouched. |
| Features that move | Region, One-on-One, AOP, Inbox, Follow-ups, Messages, reminders engine, SMS consent | Everything SMS-adjacent or scope-sensitive. |
| Features that stay | Maintenance, resume/candidate tracker | User preference. Can move later at no extra cost. |
| Shared-blob conflict | Patch RC Tracker's save endpoint to merge by key (option B) | Smallest change that honors "Maintenance stays and stays editable" without a silent-clobber path. |
| Brief recipients | Harold only, to start | No new consent work. Expand after a week of real messages. Recipient list is config, not code. |
| Brief content | Headline + 2–3 items + link to P.AI | Full briefs run several hundred words and are role-confidential. Detail belongs behind the login. |
| Brief send time | 8:05 AM in the recipient's own timezone | User requirement. |

## Current state (verified, not assumed)

### P.AI — `Desktop/pai`

- Express + `pg` against Render Postgres `pai-db`. Deployed as `pai-ayvaz` on Render's
  `starter` plan.
- **Auth already exists:** `express-session` + `bcryptjs`. `middleware/auth.js` exports
  `requireAuth` and `requireRole`. `routes/auth.js` holds a hardcoded `USER_ROSTER` of
  VPs, RDOs and Area Coaches, each with a `scope` object.
- **Scope filtering already exists** and is the pattern to reuse — see
  `routes/intel.js:1538` onward, which builds SQL `WHERE` clauses from
  `user.scope.type` (`rdo` → own `area_coaches`; `area_coach` → own `ac_name`;
  `vp` → own `vp_name`).
- **Morning briefs are already generated per person, nightly.** `services/intel-pipeline.js:375`
  (`generateMorningBriefs`) runs as step 10 of the intel pipeline and caches each
  person's brief via `db.upsertIntelCache` under `user_id = '<username>::brief'`,
  `role = 'morning_brief'`, `payload = { memo_text, generated_at }`.
- Nightly trigger: Render cron `intel-dbs-pull` at `20 10 * * *` UTC (≈5:20 AM Central),
  running `scripts/intel-cron.js`. `services/scheduler.js` is an in-process 15-minute
  timer that self-heals missed Velocity ODS pulls.
- **No Twilio, no SMS, no test suite.**

### RC Tracker — `Desktop/rc-tracker`

- Express + Supabase (`@supabase/supabase-js`), both anon and service clients.
  Deployed as `rc-tracker` on Render's `free` plan.
- **No authentication of any kind.** Every `/api/*` endpoint is open.
- Twilio two-way SMS: outbound send, inbound webhook (`POST /api/sms`), status
  callbacks (`POST /api/sms-status`), scheduled sends, and a TCPA consent flow.
- `reminders.js` (1,382 lines) — timed sends, repeating slots, digests, due pushes,
  stuck alerts. Already dependency-injected via a `deps.store` seam, which makes it
  portable. Uses a claim-before-send idiom with rollback on failure
  (`reminders.js:778`–`787`) that the brief sender should copy.
- `gmail-poller.js` (314 lines) — IMAP poll that turns inbound email into follow-ups.
- `resume-routes.js` (737 lines) — candidate tracker, own `candidates` table, no SMS ties.
- `people.json` — 62 people with `role`, `phone`, `tz`, `rc`, `vp`. Timezones present:
  `America/Chicago` (40), `America/New_York` (13), `America/Denver` (9). Names match
  P.AI's `USER_ROSTER` names, so scoping follow-ups by login needs no name mapping.
- Public TCPA pages `/privacy`, `/terms`, `/sms-opt-in` — these URLs are referenced by
  the Twilio A2P registration and must keep resolving.

### The shared-blob problem

`user_data` is one JSON blob per user. `GET /api/data/:userId` returns the whole blob;
`POST /api/data/:userId` (`server.js:219`) upserts `req.body` as the entire blob. The
Region matrix, One-on-Ones, AOP **and** Maintenance notes all live inside it
(`public/index.html:2195` reads `d.maintenance`).

Two apps editing different keys would each read the whole blob, change their own piece,
and write everything back. The second writer silently erases the first's changes — no
error, no warning. This is the one real data-loss path in the hybrid period, and
Phase 2 exists to close it.

## Architecture

```
                         Twilio (one number, unchanged)
                          ▲                      │
              outbound    │                      │ inbound + status
              (briefs,    │                      ▼
               reminders) │              RC Tracker  ──────┐
                          │              (webhook owner)   │
                    ┌─────┴─────┐                          │
                    │   P.AI    │                          │
                    │  (login)  │                          │
                    └─────┬─────┘                          │
                          │                                │
         ┌────────────────┼────────────────┐               │
         ▼                ▼                ▼               ▼
    pai-db           Supabase         intel_cache     Supabase
  (Postgres)      (follow_ups,     (morning briefs,  (maintenance,
   P.AI's own      sms_messages,    already built)    candidates)
     data          consent, …)
```

P.AI gains a second data client rather than a second database of its own. RC Tracker
keeps its single client and its current behavior.

### New modules in P.AI

| Module | Purpose |
|---|---|
| `services/rc-db.js` | supabase-js client(s) against the existing project. Mirrors RC Tracker's anon/service split. Single place to change in Phase 7. |
| `services/rc-scope.js` | Turns a P.AI session user into the set of person names they may see. Pure function, no I/O, independently testable. |
| `services/reminders.js` | Port of RC Tracker's `reminders.js`, store seam pointed at `rc-db`. |
| `services/brief-sms.js` | Reads today's cached brief, condenses it, sends, logs, dedupes. |
| `routes/rc.js` | Follow-ups, messages, inbox and tracker-data endpoints — all `requireAuth` + scope-filtered. |

## Phases

### Phase 0 — Safety net

1. Dump every Supabase table to `backups/<date>/` as JSON: `user_data`, `follow_ups`,
   `email_followups`, `sms_reminders`, `sms_consent`, `sms_messages`, `candidates`.
2. Mirror the `note-images` storage bucket to `backups/<date>/note-images/`.
3. Restore the dump into a scratch Supabase schema and diff row counts against source.

**Gate:** no later phase begins until the restore diff is clean. A backup that has not
been restored is not a backup.

### Phase 1 — P.AI reaches RC Tracker's data

1. Add `@supabase/supabase-js` and `twilio` to P.AI's `package.json`.
2. Write `services/rc-db.js`.
3. Add to P.AI's `render.yaml`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_FROM_NUMBER`, `PAI_BRIEF_RECIPIENTS` (default `hlacoste`),
   `PAI_BRIEF_SEND_LOCAL_TIME` (default `08:05`) — all `sync: false` for secrets.
4. Read-only smoke test: P.AI lists follow-ups and prints counts matching RC Tracker.

Read-only throughout. Nothing in RC Tracker changes in this phase.

### Phase 2 — Close the clobber path

1. Change RC Tracker's `POST /api/data/:userId` to fetch the stored blob and
   shallow-merge the request's top-level keys into it, rather than replacing it.
2. Change RC Tracker's front end to send only the keys it owns — `maintenance`,
   `resume` — instead of the whole `d` object.
3. P.AI's equivalent endpoint sends only `region`, `one-on-one`, `aop`.
4. Test: write Maintenance from RC Tracker and a Region note from P.AI against the same
   `user_id`, in both orders, and assert both survive.

This is the only change RC Tracker receives. It is additive and revertible in one commit.

### Phase 3 — Scoping

1. `services/rc-scope.js`: `visiblePeople(user)` → array of person names.
   - `area_coach` → `[scope.ac_name]`
   - `rdo` → `scope.area_coaches` plus `scope.rc_name`
   - `vp` → every area coach under each of `scope.region_coaches`, plus those RCs and
     the VP
   - Derived from `people.json` + `USER_ROSTER`, so the two rosters are reconciled once
     and any name present in one but not the other is reported at startup rather than
     failing silently at request time.
2. Every endpoint in `routes/rc.js` gets `requireAuth` and filters `assigned_to` /
   `person` through `visiblePeople`.
3. Tests: an Area Coach cannot read another area's follow-ups; an RDO sees exactly
   their own coaches; a VP sees their whole tree and nothing outside it.

Today any visitor to RC Tracker can read every follow-up for all 62 people. This phase
is the substance of the login objective.

### Phase 4 — Move the features

1. `routes/rc.js` mirroring RC Tracker's follow-ups, messages, inbox and data endpoints.
2. Port `reminders.js` to `services/reminders.js`, store seam on `rc-db`.
3. Port `gmail-poller.js`, triggered from P.AI's scheduler.
4. Lift RC Tracker's tab UI into a P.AI page with the Maintenance and Resume tabs
   removed and P.AI's session user replacing the manual user picker.
5. **Reminders run in exactly one app.** Until cutover, RC Tracker remains the sender
   and P.AI's reminders stay disabled behind a flag. Two senders against one
   `follow_ups` table would double-text people even with claim-before-send, because
   the claim is per-row and both apps would race on different rows.

### Phase 5 — Brief by text

1. `services/brief-sms.js`:
   - Read `intel_cache` for `user_id = '<username>::brief'`, `role = 'morning_brief'`,
     `cache_date = today`.
   - **If today's brief is absent, do nothing and retry next tick.** Never send
     yesterday's numbers — a late brief is recoverable, a stale one is misleading.
   - Condense `memo_text` to ≤320 characters via Claude: headline, 2–3 items, and a
     link to the full brief in P.AI.
   - Send via Twilio from the existing number.
   - Log to `sms_messages` with `kind = 'brief'`, capturing `twilio_sid` and any error.
2. Dedupe: claim before send, rolling the claim back if the send fails — the idiom at
   `reminders.js:778`. One text per person per local date, surviving restarts and
   overlapping ticks.
3. Timer: own 2-minute interval, not P.AI's 15-minute scheduler tick, which cannot hit
   an `:05` target. Each tick asks, per recipient, whether local time is within the
   send window and nothing has gone out for that local date.
4. Recipients from `PAI_BRIEF_RECIPIENTS`; phone and `tz` from `people.json`.
   Send is skipped for anyone without an `opted_in` row in `sms_consent`.

**Timing check:** the pipeline starts at 10:20 UTC (≈5:20 AM Central) and generates ~60
briefs with Claude calls, so finish time varies. 8:05 AM Eastern is ≈12:05 UTC, the
tightest of the three windows at roughly 1h45m after pipeline start. The
absent-brief guard in step 1 is what makes that safe.

### Phase 6 — Cutover (separate decision)

1. Point the Twilio webhook and status callback at P.AI.
2. Enable P.AI's reminders; disable RC Tracker's.
3. RC Tracker keeps serving `/privacy`, `/terms`, `/sms-opt-in` so A2P stays valid.
4. Rollback is repointing the webhook — minutes, not a deploy.

### Phase 7 — Consolidation (optional, later)

Copy Supabase tables into `pai-db`, repoint `rc-db.js` at the `pg` pool, keep Supabase
read-only for a grace period. Ends the two-writer condition for good.

## Data inventory

Everything below is copied and verified by row count. Nothing is deleted from Supabase
at any phase of this design.

| Table | Carries |
|---|---|
| `follow_ups` | text, assignee, status, source, due date/time, notes JSON, repeat slots, push counts, reply history, stuck alerts |
| `sms_messages` | full inbound/outbound thread history, media, status, Twilio SIDs, scheduled sends |
| `sms_reminders` | reminder send log |
| `sms_consent` | **TCPA proof of consent** — opt-in wording, IP, user agent, timestamps. Legally significant; never mutated, only appended. |
| `user_data` | Region matrix, One-on-Ones, AOP, Maintenance notes |
| `email_followups` | Gmail-sourced follow-ups |
| `candidates` | resume tracker (stays in RC Tracker) |
| `note-images` bucket | uploaded note attachments |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Silent blob clobber between apps | High | Phase 2 key-merge + concurrent-write test. Phase 7 removes the condition. |
| Double-texting from two reminder senders | High | Exactly one sender enabled at a time (Phase 4, step 5); claim-before-send. |
| Stale brief sent as today's | Medium | Absent-brief guard; never fall back to an older `cache_date`. |
| A2P campaign invalidated | Medium | TCPA page URLs keep resolving; RC Tracker stays deployed. |
| Texting someone without consent | High | Consent check on every send; recipients default to one person. |
| Roster drift between `people.json` and `USER_ROSTER` | Medium | Reconciled once in `rc-scope.js`; mismatches reported at startup. |
| Supabase free-tier limits under two apps | Low | Monitor; Phase 7 resolves. |

## Security finding (outside this design's scope)

P.AI's `USER_ROSTER` gives every user the same bcrypt hash — one shared password,
`welcome1@`, noted in `routes/auth.js:7`. Scope filtering is only as strong as the
login in front of it: with a shared password, any user can sign in as any other and
see their scope. This does not block the integration, and the integration still
improves on RC Tracker's no-auth status quo, but it limits how much the Phase 3
boundary is actually worth. Worth a separate piece of work — per-user passwords with
a forced first-login reset.

## Testing

P.AI has no test suite. Add one covering the four things that fail silently:

1. `rc-scope.js` — scope boundaries per role, including the empty-`area_coaches` fallback.
2. Blob merge — concurrent writes in both orders, both keys survive.
3. Brief condensing — output ≤320 characters, link present, absent-brief returns no send.
4. Send dedupe — one text per person per local date across overlapping ticks, restarts,
   and a failed send followed by a retry.

RC Tracker's existing jest tests must still pass after the Phase 2 patch.

## Out of scope

- Moving Maintenance or the resume tracker (can be done later; no extra cost incurred)
- Retiring the RC Tracker website
- Replacing the shared password
- Expanding brief recipients beyond Harold (config change, no code change)
- Phase 7 consolidation
