-- Weekly repeats: "certifications for Vanderlyn every Wednesday and Sunday".
-- [0..6], Sunday = 0. Empty/null keeps the old meaning: every day.
alter table follow_ups add column if not exists repeat_days jsonb;
