-- Third tier in the reading-font feature: chrome / UI text (sidebar, settings,
-- outline, etc.) gets its own font choice independent of reading and editing.
-- NULL means "use the default" same as the other two columns. Same caveat as
-- 0020 - read by loadCurrentSession, so a schema change here requires
-- redeploying auth + api workers.
ALTER TABLE users ADD COLUMN ui_font TEXT;
