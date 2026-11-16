import { d1Local } from "./d1Local";

// Tests that fail mid-flow leave dormant rows behind: a user the spec couldn't
// log back into for cleanup, a project whose owner-delete never ran, etc.
// Each spec's afterAll already does a best-effort cleanup, but it can't run
// when the dev stack is broken or the page is in a weird state.
//
// This hook is the safety net: after every spec finishes, wipe any row that
// was clearly created by the e2e suite. It runs as a Node process (no Page),
// so it writes the local D1 directly (scripts/d1-local.mjs, via the running
// api dev server). It also runs on Playwright failure exits.
//
// FK cascades handle most of the auth-DB tail (sessions, webauthn, backup
// codes, moderation events). email_verification_tokens has no cascade, so we
// delete it explicitly first. On the API DB, deleting projects cascades
// everything below (docs, folders, files, members, invite links).
export default async function globalTeardown() {
  const run = (db: "main" | "auth", sql: string) => {
    try {
      d1Local(db, sql);
    } catch (err) {
      // Dev stack might be down (we just torched it with the test run); that's
      // fine - there's nothing to clean if there's no DB to talk to.
      console.warn(`[globalTeardown] ${db}: ${(err as Error).message.split("\n")[0]}`);
    }
  };

  // Auth DB: orphan tokens first, then users (cascades the rest).
  run(
    "auth",
    "DELETE FROM email_verification_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%@example.com');",
  );
  run("auth", "DELETE FROM users WHERE email LIKE 'e2e-%@example.com';");

  // API DB: delete e2e-suite projects by name prefix (cascades everything).
  // Patterns track the names used in app.spec.ts, invites.spec.ts, and
  // limited-permissions.spec.ts.
  run(
    "main",
    "DELETE FROM projects WHERE name LIKE 'E2E Project %' OR name LIKE 'E2E Scroll %' OR name LIKE 'Invite Test %' OR name LIKE 'Limited Perm Test %';",
  );
}
