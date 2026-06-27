-- Annex Ink supporter cosmetic preferences. Both columns are NULL for free
-- users and for supporters who haven't customised - the resolver and the UI
-- treat NULL as "use the default" (default ring = 'shimmer'; default
-- presence colour = the deterministic per-user HSL from userColor()).
--
-- These are surfaced through resolvePersonalPlan and loadCurrentSession,
-- so a schema change here requires redeploying auth + api workers.
ALTER TABLE users ADD COLUMN personal_plan_style TEXT;
ALTER TABLE users ADD COLUMN personal_presence_color TEXT;
