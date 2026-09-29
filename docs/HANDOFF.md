# RC Tracker — where things stand (2026-09-29)

Paste this into a new chat to pick up without re-explaining.

## What this is
`rc-tracker` — internal follow-up tracker for Ayvaz Pizza (Pizza Hut franchisee).
Node/Express + Supabase (Postgres), hosted on Render, auto-deploys from GitHub `main`
(`halaco225/rc-tracker`). Live at https://rc-tracker-hos2.onrender.com.
Owner/user: Harold Lacoste, RC. VP: Matt Hester.

Tabs: Region Matrix · 1:1 View · Inbox · Follow-Ups · **Message Center** · Maintenance · Resume Tracker.

## Texting (the newest, biggest piece)
- Number: **(877) 708-9555**, toll-free, verified for **Ayvaz Pizza, LLC**.
- Twilio Messaging Service "Ayvaz RC Tracker" `MG72bb31225069e9095a8a99660d2d4288`,
  sender pool = **that number only**. The old 229 number was removed 9/21 — it was
  unregistered for 10DLC and scheduled texts sent from it were carrier-blocked (error 30034).
- **TalentDesk is a separate app on the same Twilio account. Never touch its service
  `MG5fc0fb9172f06c0f7ca83163075c1c55`, number 470-771-7670, or the Individual primary
  customer profile.** See `docs/twilio-a2p-registration.md`.
- Reminder engine: `reminders.js` (dependency-injected: `{store, sms, ai, now}`), driven by
  `GET /api/reminders/run`. Two clocks: cron-job.org every 5 min (job 8452350) **and** an
  internal 3-minute tick in `server.js`.
- What goes out: 9am morning list per person (their own time zone), time-of-day reminders
  (`due_time`), repeating reminders (`repeat_times`, e.g. 9am & 3pm daily until done),
  assignment texts, Monday summary to Harold, stuck-item alerts into the Inbox.
- What comes back: `done`, a new due date, a note, `list`, `remind me to …` (creates a
  follow-up, asks when if no day given), `START`/`STOP`/`HELP`. Regex first, Claude Haiku
  as fallback (`tracker_key` env var).
- Consent: reminders only to people who texted START or used the sign-up page. A
  hand-written Message Center text may reach someone who hasn't signed up; anyone who
  texted STOP never gets anything.

## Who is actually on it (as of 9/29)
Scoped to **Matt Hester's team — 20 people** (of 62 in `people.json`).
- Signed up: Harold, Jadon, Jorge, Michelle, Ebony, **Marc** (signed up 9/26).
- Not signed up: **Matt, Darian, Lori, Preston** (Matt/Darian were texted the sign-up 9/26).
- `people.json` is gitignored — it lives on Render as a Secret File. Rebuild it with
  `scripts/import_alignment.py` from the alignment workbook.

## Key files
- `reminders.js` — all reminder/reply logic. Pure functions + a `store` interface.
- `server.js` — routes. `/api/messages/*` (Message Center), `/api/follow-ups`, `/api/sms`
  (inbound webhook), `/api/reminders/run`, `/api/sms-status` (delivery receipts).
- `public/index.html` — the whole front end, one file.
- `tests/reminders.test.js` — 89 tests, all passing. Run `npx jest`.
- `supabase/migrations/` — 001–007. **007 is the latest and is applied.**
  Run new ones by hand in the Supabase SQL editor (project `svbmvlnphdxausyrjlje`).

## How the Message Center works now
Compose asks one question — "What should happen?" — with three answers:
1. Text them now **and** put it on their follow-ups.
2. Put it on their follow-ups, **no text now** (it arrives in their 9am list on the due date).
3. Just text them, nothing tracked.
Then due date / time / repeat. A live line states exactly what will happen before you
press the button, naming anyone selected who hasn't signed up. After sending, a receipt
says who was texted, who was only added, and what happens next.

**Team tab** is the weekly driver's seat: filters for Overdue / Needs a date / Not signed
up; expand a person for every open item, what it will actually do, who assigned it, their
last reply, and what they closed this week — with ⏰ (reminder) and ✓ Done inline.

The same ⏰ reminder dialog is on matrix notes, follow-up cards, the Add Follow-Up modal,
and maintenance notes.

## Open items
- **16 follow-ups have no due date**, so they never text anyone. Message Center → Team →
  "Needs a date". This is the single biggest thing holding the system back.
- Lori and Preston haven't been invited yet (Harold's call).
- Three junk follow-ups titled "SMS from …" should be deleted.
- Stuck alerts still land in the email Inbox; moving them to the Team tab was offered.
- Repeats are daily only. A **monthly** option (e.g. expenses on the 1st) is the next
  natural feature.
- Gmail polling (`/api/poll`) is **disabled** at cron-job.org since June and staying off —
  Harold is making an Outlook mailbox instead (IMAP, like Terry's `TERRY_OUTLOOK_*` env
  vars, no OAuth re-auth). Send the address and add it to `gmail-poller.js`.

## Working agreements that matter
- Verify against live data before claiming something works; simulate the cron against real
  items rather than reasoning about it (`node` + `reminders.js` with a fake clock).
- Don't fabricate what a text will say — run the formatter.
- Check the Message Center log after any change that sends.
