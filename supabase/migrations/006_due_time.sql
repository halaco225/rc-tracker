-- Time-of-day reminders: "remind me at 2:10pm today to check e6 learning"
-- due_date alone only ever produced a 9am digest; due_time fires at the minute asked for.

alter table follow_ups add column if not exists due_time text;          -- 'HH:MM', 24h, local to the assignee
alter table follow_ups add column if not exists timed_sent_at timestamptz; -- the timed text went out (claim before send)

create index if not exists follow_ups_due_time_idx
  on follow_ups(due_date, due_time) where due_time is not null and timed_sent_at is null;
