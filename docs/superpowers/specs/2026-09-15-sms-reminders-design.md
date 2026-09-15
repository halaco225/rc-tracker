# SMS Reminders — Design

**Date:** 2026-09-15
**Status:** Approved, implemented

## Goal
Text people about their follow-ups when they're assigned and as due dates approach, and let them reply by text to finish items, move due dates, or add notes.

## Who gets texts
The 8 people with phone numbers in `reminders.js` (`PEOPLE`), each with a time zone. Items assigned to anyone else or to "Everyone" are skipped. Numbers are added in code for now.

## Texts
| Text | When | To |
|---|---|---|
| New assignment | Immediately when a follow-up is created for, or reassigned to, someone (not when assigning yourself) | Assignee |
| Morning list | Once a day, 9am–noon local time, if they have open items due tomorrow, today, or overdue | Assignee |
| List | When they text "list" | Replier |
| Confirmation | After a reply is applied | Replier |
| Monday summary | Monday 9am–noon Eastern: done last 7 days, overdue now, pushed back, stuck | Harold (text + inbox) |

- Items are numbered (max 10 shown). The first 3 texts a person receives include full reply instructions; later ones a short hint.

## Replies
A reply refers to the numbering of the person's most recent assignment/morning/list text from the last 7 days.
- `1 done`, `all done`, `done` (single item) → status `done`
- `2 Friday`, `3 by tomorrow` → new `due_date`; `due_push_count` +1 when the date moves later
- `3 waiting on parts` → note only
- `list` → sends all open items, numbered
- Ambiguous (clearly about an item but which one is unclear) → "Which one?" text
- Unrelated, or picture messages → SMS inbox as before

Simple forms are parsed with regex; everything else goes to Claude Haiku, which returns JSON that is validated (item in range, date between today and +90 days). Every applied reply is added as a note and stored as `last_reply` / `last_reply_at`.

## Stuck items
Open item 3+ days overdue (Eastern date) or `due_push_count >= 3`. For texted people, one inbox entry per item (`gmail_message_id = stuck-<id>`), marked via `stuck_alerted_at`. Cards show a red "⚠ Stuck" badge (any assignee).

## Card status
Cards show `📱 Texted <day time> · replied "<reply>"` from `last_texted_at` / `last_reply`.

## Architecture
- `reminders.js` — all logic. Dependencies are injected: `store` (Supabase), `sms` (Twilio Messaging Service), `ai` (Claude), `now`.
- `GET /api/reminders/run` — called hourly by cron-job.org. `?dry=1` previews all morning lists/stuck items/summary without sending or writing.
- `POST /api/follow-ups`, `PATCH /api/follow-ups/:id` — trigger assignment texts (fire-and-forget).
- `POST /api/sms` — offers each inbound text to `handleInboundSms` first.

## Data (`003_sms_reminders.sql`)
- `sms_reminders`: log of every text (person, phone, kind, ordered `item_ids`, body, `local_date`, twilio sid, error). Unique `(person, kind, local_date)` makes morning lists and summaries once-a-day. RLS on; server writes with the service key.
- `follow_ups`: `due_push_count`, `last_texted_at`, `last_reply`, `last_reply_at`, `stuck_alerted_at`.

## Error handling
- The log row is inserted before sending; if the insert fails (duplicate or missing table) nothing is sent, so code is inert until the migration is run.
- A failed send records the error and clears `local_date`, so the next hourly run retries (window closes at noon).
- Reply-handling errors fall back to the inbox.

## Testing
`tests/reminders.test.js` covers time zones, due selection, formatting/instructions, reply parsing and validation, stuck rules, once-a-day sending and retry, dry run, summary, assignment rules, and reply handling with a fake store/SMS/AI.

## Setup
1. Run `supabase/migrations/003_sms_reminders.sql` in the Supabase SQL editor.
2. Confirm `SUPABASE_SERVICE_KEY`, `TWILIO_*`, and `tracker_key` are set on Render.
3. Add an hourly cron-job.org job: `GET https://<render-app>/api/reminders/run`.
4. Confirm the Twilio toll-free number is verified.
