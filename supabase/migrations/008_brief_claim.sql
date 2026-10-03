-- 008_brief_claim.sql
--
-- One brief per person per local day, enforced by the database.
--
-- P.AI's brief sender inserts the claim row BEFORE calling Twilio. If two
-- ticks overlap, or the process restarts mid-send, the second insert violates
-- this index and that sender backs off. A SELECT-then-INSERT cannot do this:
-- both callers read "nothing sent" and both send.
--
-- Partial, so it constrains only kind='brief'. Existing digest, summary,
-- assignment, list and confirm rows are untouched and may still repeat within
-- a day exactly as they do today — RC Tracker's reminder engine is unaffected.

create unique index if not exists sms_reminders_brief_once_idx
  on sms_reminders (person, local_date)
  where kind = 'brief';
