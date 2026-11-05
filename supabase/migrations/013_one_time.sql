-- A reminder that goes out once instead of every day.
-- A due date plus a time has always meant "text at that minute, then at the same
-- minute every day until done", so there was no way to ask for a single nudge at
-- 2pm Thursday. Default false, so every row that existed before this keeps
-- repeating exactly as it does now.

alter table follow_ups add column if not exists one_time boolean not null default false;
