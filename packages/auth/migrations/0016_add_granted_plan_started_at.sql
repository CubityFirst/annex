-- Tracks when a manual grant was applied. Lets the resolver surface a
-- "Supporter since X" date for gifted users the same way personal_plan_started_at
-- does for paid users. Backfills existing grants to "now" since we have no
-- prior timestamp - admins can correct individual rows manually if needed.
ALTER TABLE users ADD COLUMN granted_plan_started_at INTEGER;

UPDATE users
   SET granted_plan_started_at = strftime('%s', 'now') * 1000
 WHERE granted_plan IS NOT NULL
   AND granted_plan_started_at IS NULL;
