# Organizations (a level above sites)

An **organization** is a collection of sites (`projects`) one level above the site
level, with **trickle-down roles**: a user added to an org gets that role on every
site in the org. Sites don't need an org, but each belongs to at most one.

## Product rules (as shipped)

- **Org owner = owner on every site in the org**, including deleting individual
  sites. Org roles map fully: owner→owner, admin→admin, editor→editor,
  viewer→viewer. Org roles never include `limited`.
- **Effective site role = the higher `ROLE_RANK` of** (the caller's direct
  `project_members` row) **and** (their accepted `organization_members` role for
  that site's `organization_id`). A direct-`limited` member who is also an org
  viewer+ is *elevated* out of the per-doc-share gate - intended.
- **One org per site**: nullable `projects.organization_id` (`ON DELETE SET NULL`,
  so deleting an org **detaches** its sites - they survive - rather than deleting
  them).
- **Attach** a site to an org: caller must be **org admin+ AND the site's *direct*
  owner**. **Detach**: org admin+ OR the site's owner. **Create-in-org**: go
  through `POST /projects` with `organizationId` (requires org admin+).
- Scope is core only - no org billing, branding, or feature-flag inheritance.

## Schema - `packages/api/migrations/0054_add_organizations.sql` (API DB)

- `organizations(id, name, owner_id, created_at)` - `owner_id` is a bare string
  (auth-DB user, no cross-DB FK), like `projects.owner_id`.
- `organization_members(id, organization_id FK CASCADE, user_id, email, name,
  role CHECK(viewer|editor|admin|owner), invited_by, created_at, accepted,
  UNIQUE(organization_id, user_id))` - mirrors `project_members` (minus
  favourite/hidden), `accepted` defaults 0 (invites).
- `ALTER TABLE projects ADD COLUMN organization_id TEXT REFERENCES
  organizations(id) ON DELETE SET NULL`. Indexes: `idx_org_members_user`,
  `idx_projects_org`.
- Local apply diverged from the migrations tracker (0053 was applied manually),
  so 0054 was applied to local dev via `wrangler d1 execute --file` (not
  `migrations apply`). Remote/deploy uses normal migration tracking.

## The access boundary - `packages/api/src/lib/access.ts`

`resolveAccess(db, projectId, userId)` → `EffectiveAccess | null` and the
role-only `resolveRole(...)`. **ONE D1 query**: `projects` anchor + LEFT JOIN
`project_members` (accepted) + LEFT JOIN `organization_members` (accepted, via
the site's `organization_id`); JS picks the higher `ROLE_RANK` (tie → org;
identical effect). Returns `null` when the project is missing or the user has
neither membership.

This **replaced the ~13 copy-pasted `getCallerRole`/`getCallerInfo`/`liveCaller`/
inline `SELECT role FROM project_members …` caller gates** across: projects,
members (gate only), docs (`resolveAccess` for `.role`+`.name`), folders, files,
docShares (gate only), search, graph (×2), export, inviteLinks (gate + the
`creatorRole` re-validation), apiKeys, v1 (`liveCaller`), and the **`index.ts`
collab-upgrade check** (which also now requires `accepted=1`).

**Direct `project_members` queries that intentionally REMAIN** (not caller gates -
do not "unify" these into `resolveAccess`):
- target-row escalation guards in `members.ts` / `docShares.ts` (they gate on the
  *target's stored* role, which org elevation must not change);
- attribution joins (`COALESCE(pm.name, author_id|uploaded_by, …)`) - org-only
  authors fall back to their raw id (known v1 cosmetic limitation);
- `GET /projects` "Your Sites" list (direct memberships only - org sites are
  browsed via the org page);
- the site members-list *contents* (the *gate* uses effective role; the list
  shows direct members);
- **attach's site-owner check** in `routes/organizations.ts` - must be the
  caller's *direct* `project_members` owner role, NOT `resolveRole` (an
  effective-owner via some *other* org must not be able to move the site).

## API surface - `packages/api/src/routes/organizations.ts`

Wired in `index.ts` via `url.pathname.startsWith("/organizations")`. Local
`getOrgRole(db, orgId, userId)` for org-level gates (org membership only).

- `GET/POST /organizations` - list my orgs (+ role, site/member counts) / create
  (+ owner member row).
- `GET/PATCH/DELETE /organizations/:id` - detail (member; 404 hides existence) /
  rename (admin+) / delete (owner; SET-NULL detaches sites, CASCADE wipes members).
- `GET/POST/PATCH/DELETE /organizations/:id/members[/:userId]` - list/invite/
  role-change/remove+self-leave, with the same escalation guards as `members.ts`.
- `GET /organizations/:id/projects` - sites in the org (how org sites are browsed).
- `POST|DELETE /organizations/:id/projects/:projectId/attach` - attach/detach.
- `POST /projects` accepts optional `organizationId` (org admin+ → create-in-org).
- `PATCH /me` name-sync also `UPDATE organization_members SET name`.

**Pending invites are unified**: `routes/pendingInvites.ts` UNIONs site + org
invites, each tagged `type: "site" | "org"`; accept/decline disambiguate via
`?type=org`. `PendingInvitesPage.tsx` renders both.

`liveCaller` in `routes/v1.ts` now delegates to `resolveAccess`, so a scoped
key's role *floor* includes org trickle-down; scope/`canInvite` remain
independent ceilings, and removing the owner from BOTH direct and org membership
still neuters the key (resolver → null).

## Frontend

- `DashboardPage` - "Your Orgs" section above "Your Sites" (shown when in ≥1 org)
  + an always-present "New organization" button.
- `DocsLayout` - `openCreateOrg` on the context + a create-org dialog.
- Routes (`App.tsx`): `/orgs/:orgId` (`OrgPage` - sites grid, create-in-org,
  settings link) and `/orgs/:orgId/settings` (`OrgSettingsPage` - General /
  Members / Sites attach-detach / Danger, modeled on `SiteSettingsPage` +
  `SettingsShell`). Attach UI lists the caller's *owned, org-less* sites
  (filtered from `GET /projects`, which now returns `organization_id`).
- `loadMemberPlans` is exported from `members.ts` and reused for org member avatars.

## Tests

- `packages/api/src/lib/access.test.ts` - resolver unit (direct/org/max/the
  load-bearing `limited`+org-viewer→viewer elevation/null cases).
- `packages/api/src/organizations.integration.test.ts` - live trickle-down
  read/write, isolation, org-owner-deletes-a-site-owned-by-another, attach
  gating + detach-revokes-access, escalation guards, owner-only delete-detaches.
  Auto-skips when dev servers are down.

## Known v1 limitations

- favourite/hidden are direct-membership-only; org-only sites aren't favouritable
  (they're browsed via the org page).
- A direct site owner who's been ejected/demoted from the org CAN still detach
  their own site via the API (`DELETE /organizations/:id/projects/:projectId/attach`
  allows direct-owner detach), but there is no site-settings UI for it yet - the
  `OrgSettingsPage` detach control is admin-only. A site-settings "Organization"
  control is a follow-up.
- Org-only doc authors show their raw id in list attribution (see above).
- The resolver's real-SQL invariants (accepted-gating, NULL-org isolation,
  cross-org isolation) are covered by `organizations.integration.test.ts`
  (live), not the mock-based `lib/access.test.ts`; that integration suite
  skips when dev servers are down, so CI without a backend has no real-SQL
  coverage of the resolver. Hardening (a seeded in-memory D1 test) is a follow-up.
