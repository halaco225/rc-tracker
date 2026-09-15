-- SMS reminders: text log + reminder tracking on follow-ups

create table if not exists sms_reminders (
  id uuid primary key default gen_random_uuid(),
  person text not null,
  phone text not null,
  kind text not null,              -- digest | assignment | list | confirm | summary
  item_ids jsonb not null default '[]'::jsonb, -- follow_up ids in the order they were numbered
  body text not null,
  local_date date,                 -- set for once-a-day texts (digest, summary)
  twilio_sid text,
  error text,
  created_at timestamptz not null default now()
);

-- One morning list / summary per person per day
create unique index if not exists sms_reminders_once_per_day
  on sms_reminders(person, kind, local_date) where local_date is not null;

create index if not exists sms_reminders_person_created_idx
  on sms_reminders(person, created_at desc);

-- Only the server (service key) reads/writes the log
alter table sms_reminders enable row level security;

alter table follow_ups add column if not exists due_push_count integer not null default 0;
alter table follow_ups add column if not exists last_texted_at timestamptz;
alter table follow_ups add column if not exists last_reply text;
alter table follow_ups add column if not exists last_reply_at timestamptz;
alter table follow_ups add column if not exists stuck_alerted_at timestamptz;
