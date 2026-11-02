-- Opt-in public profile handle, served by the app at /@<handle>. Lives on the
-- user_preferences satellite: NULL (or no row) means the user hasn't turned
-- the profile link on. Stored already-normalized (lowercase, see src/handle.ts)
-- so the plain unique index is effectively case-insensitive.
--
-- Partial index: SQLite already lets UNIQUE columns hold many NULLs, but the
-- WHERE clause keeps the index to just the users who opted in.
--
-- Read directly by the API worker's /users/by-handle resolver via AUTH_DB, so
-- apply this migration before deploying api.
--
-- handle_locked is an admin control (admin worker, PATCH /api/users/:id/handle):
-- when 1 the user can't set, change or clear their own handle. Locking with a
-- NULL handle bars the user from claiming one (moderation of abusive names);
-- locking with a handle set pins an admin-assigned name.
ALTER TABLE user_preferences ADD COLUMN handle TEXT;
ALTER TABLE user_preferences ADD COLUMN handle_locked INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_user_preferences_handle ON user_preferences(handle) WHERE handle IS NOT NULL;
