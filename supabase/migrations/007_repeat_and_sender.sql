-- Repeating reminders: "twice daily until marked complete"
alter table follow_ups add column if not exists repeat_times jsonb;     -- ["09:00","15:00"], local to the assignee; daily until done
alter table follow_ups add column if not exists repeat_last_slot text;  -- 'YYYY-MM-DD HH:MM' of the last slot sent (claim before send)

-- Message Center: who wrote or scheduled a text, so you can see what other people send
alter table sms_messages add column if not exists sent_by text;
