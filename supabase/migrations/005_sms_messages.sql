-- Message Center: every text in and out, with delivery status and attachments.

create table if not exists sms_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null,            -- outbound | inbound
  person text,                        -- staff name when the number is known
  phone text not null,                -- the other party, +1XXXXXXXXXX
  body text,
  media jsonb not null default '[]'::jsonb,   -- [{url, type, name}]
  kind text,                          -- digest | assignment | list | confirm | summary | ask_due | compose | inbound
  status text,                        -- queued | sent | delivered | undelivered | failed | received | scheduled | canceled
  twilio_sid text,
  error text,
  follow_up_ids jsonb not null default '[]'::jsonb,
  send_at timestamptz,                -- scheduled sends only
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sms_messages_created_idx on sms_messages(created_at desc);
create index if not exists sms_messages_person_idx on sms_messages(person, created_at desc);
create index if not exists sms_messages_sid_idx on sms_messages(twilio_sid);

-- Only the server (service key) reads/writes the message log
alter table sms_messages enable row level security;
