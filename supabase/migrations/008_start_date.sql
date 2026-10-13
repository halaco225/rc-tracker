-- "Put this on their list later": the day an item starts appearing in the 8am text.
-- Until now the due date did both jobs — deadline and first appearance — so you
-- couldn't hand someone something on Monday that's due Friday.
-- Empty means it's on their list straight away.

alter table follow_ups add column if not exists start_date date;
