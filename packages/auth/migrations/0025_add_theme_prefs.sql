-- Per-user site theme: dark (default) / light / custom. Stored on the
-- user_preferences satellite. NULL theme_mode means "use the default" (dark),
-- same convention as the font columns (0020/0021). theme_custom_color holds
-- the picked #rrggbb base when theme_mode = 'custom', NULL otherwise; the
-- frontend derives the full palette from it.
--
-- This is gated to global site admins (see routes/update-theme.ts). Same
-- caveat as 0020/0021 - read by loadCurrentSession, so a schema change here
-- requires redeploying auth + api + admin.
ALTER TABLE user_preferences ADD COLUMN theme_mode TEXT;
ALTER TABLE user_preferences ADD COLUMN theme_custom_color TEXT;
