-- Weekly items stay open after "done" so they come back on their next day. This is
-- when someone last closed one out, which is the only record that the week was done.
alter table follow_ups add column if not exists last_done_at timestamptz;
