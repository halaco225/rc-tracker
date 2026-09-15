-- SMS consent log: web sign-ups and START/STOP keywords. The newest row per phone wins.

create table if not exists sms_consent (
  id uuid primary key default gen_random_uuid(),
  phone text not null,             -- +1XXXXXXXXXX
  name text,
  status text not null,            -- opted_in | opted_out
  source text not null,            -- web_form | keyword_start | keyword_stop
  consent_text text,               -- exact wording the person agreed to (web form)
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists sms_consent_phone_created_idx on sms_consent(phone, created_at desc);

-- Only the server (service key) reads/writes consent records
alter table sms_consent enable row level security;
