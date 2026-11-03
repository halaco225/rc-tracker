-- An item can be tracked without texting anyone: it shows on the board and in the
-- Monday roll-up, but never joins the 8am list and sends no "new follow-up" text.
alter table follow_ups add column if not exists no_text boolean not null default false;
