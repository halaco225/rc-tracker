-- 014_brief_optin.sql
--
-- Who gets the daily numbers brief each morning. P.AI's brief sender used to
-- text a hard-coded list of 14; now it asks RC Tracker, and an RC turns a
-- person on or off with the checkbox in the Message Center.
--
-- A missing row is not "off" — it means nobody has made a decision about that
-- person yet, and the default (Harold and Matt) applies. That keeps the table
-- empty until someone actually uses the checkbox, and means an unrun migration
-- leaves exactly the two people who should be getting it.

create table if not exists brief_optins (
  person text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
