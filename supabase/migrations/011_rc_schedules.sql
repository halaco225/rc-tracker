-- Each RC decides which mornings the daily list goes out — one schedule for themselves,
-- one for their ACs — and whether the Monday recap is sent at all. Days are
-- 0=Sunday..6=Saturday, the same convention as follow_ups.repeat_days. No row for an RC
-- means every morning, which is how it worked before schedules existed.
create table if not exists rc_schedules (
  rc_name text primary key,
  self_days jsonb not null default '[0,1,2,3,4,5,6]',
  team_days jsonb not null default '[0,1,2,3,4,5,6]',
  weekly_recap boolean not null default true,
  updated_at timestamptz not null default now()
);
