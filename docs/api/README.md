# Annex Public API (`/v1`)

A small, scoped REST API for programmatically reading and writing documents, and
managing members, on a single site. It is authenticated with **API keys** that
you generate in **Site Settings → Developer → API Keys**.

> The public API is intentionally narrow and isolated. Keys work **only** on the
> `/v1` surface described here - they are rejected everywhere else.

---

## Base URL

```
https://<your-site-domain>/api/v1
```

For the hosted instance that is:

```
https://docs.cubityfir.st/api/v1
```

(The site's frontend transparently proxies `/api/*` to the API worker, so the
public API shares the app's origin. In local dev the same path works through the
Vite proxy: `http://localhost:5173/api/v1`.)

---

## Authentication

Send your key as a Bearer token:

```
Authorization: Bearer annx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

* Keys are prefixed `annx_`. The full secret is shown **once**, at creation - it
  is stored only as a hash and can never be retrieved again. If you lose it,
  revoke the key and create a new one.
* A missing, malformed, unknown, revoked, or expired key always returns a single
  opaque `401` - the API never reveals whether a key exists or why it was
  rejected.
* JWT/session tokens are **not** accepted on `/v1`. API keys are **not** accepted
  on any other route.

### What a key can do

Every key is bound to exactly **one site** and carries a capability ceiling:

| Property      | Values                | Controls                                              |
| ------------- | --------------------- | ---------------------------------------------------- |
| **scope**     | `read` / `readwrite`  | `read`: read docs only. `readwrite`: create/edit/move/delete docs. |
| **canInvite** | `true` / `false`      | When `true`, the key may invite/remove members.      |

A key is **only ever a ceiling**. Every request additionally re-checks the live
role of the key's owner on the site, so:

* A `readwrite` key still cannot write unless its owner is an **editor or above**.
* A `canInvite` key still cannot manage members unless its owner is an **admin or
  owner**.
* If the owner is removed from the site, **all of their keys stop working
  immediately**.

This means a key can never grant more access than its owner currently has.

---

## Rate limiting

Each key is limited to **120 requests per minute** across the whole `/v1`
surface. Over the limit returns:

```
HTTP 429
{ "ok": false, "error": "rate_limited", "status": 429 }
```

---

## Response format

All responses use a JSON envelope:

```jsonc
// success
{ "ok": true, "data": <payload> }

// error
{ "ok": false, "error": "<message>", "status": <http-status> }
```

### Status codes

| Status | Meaning                                                                 |
| ------ | ---------------------------------------------------------------------- |
| `200`  | OK                                                                     |
| `201`  | Created                                                                |
| `400`  | Bad request (missing/invalid fields, invalid folder, invalid role)    |
| `401`  | Unauthenticated (missing/invalid/revoked/expired key)                 |
| `403`  | Forbidden (scope or live-role check failed)                           |
| `404`  | Not found (or not visible to this key - e.g. a doc in another site)   |
| `409`  | Conflict (e.g. user is already a member)                              |
| `429`  | Rate limited                                                          |
| `503`  | API temporarily disabled (`{"error":"api_disabled"}`) - global killswitch |

---

## Documents

The site is always implied by your key. You never pass a site/project id.

### List documents

```
GET /v1/docs
```
Requires: any valid key. Returns document summaries for the site (a `limited`-role
owner only sees docs explicitly shared with them).

```bash
curl https://docs.cubityfir.st/api/v1/docs \
  -H "Authorization: Bearer $ANNEX_KEY"
```

```jsonc
{ "ok": true, "data": [
  { "id": "…", "title": "Getting started", "folderId": null,
    "publishedAt": null, "tags": [], "createdAt": "…", "updatedAt": "…" }
] }
```

### Get a document

```
GET /v1/docs/:id
```
Requires: any valid key. Returns the summary plus the markdown `content`. Returns
`404` if the doc isn't in this key's site.

```bash
curl https://docs.cubityfir.st/api/v1/docs/DOC_ID \
  -H "Authorization: Bearer $ANNEX_KEY"
```

### Create a document

```
POST /v1/docs
```
Requires: `readwrite` scope **and** owner is editor+.

| Field      | Type            | Required | Notes                               |
| ---------- | --------------- | -------- | ----------------------------------- |
| `title`    | string          | yes      |                                     |
| `content`  | string          | no       | Markdown body (frontmatter honoured)|
| `folderId` | string \| null  | no       | Must be a docs folder in this site  |

```bash
curl -X POST https://docs.cubityfir.st/api/v1/docs \
  -H "Authorization: Bearer $ANNEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Release notes", "content": "# Release notes\n\n…" }'
```

Returns `201` with the created document summary.

### Edit / publish a document

```
PATCH /v1/docs/:id
```
Requires: `readwrite` scope **and** owner is editor+. Send only the fields you
want to change.

| Field       | Type            | Notes                                            |
| ----------- | --------------- | ------------------------------------------------ |
| `title`     | string          |                                                  |
| `content`   | string          | A new revision is recorded when the body changes |
| `folderId`  | string \| null  | **Moves** the doc (see below)                    |
| `published` | boolean         | `true` publishes, `false` unpublishes            |

```bash
curl -X PATCH https://docs.cubityfir.st/api/v1/docs/DOC_ID \
  -H "Authorization: Bearer $ANNEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Release notes (v2)", "published": true }'
```

### Move a document

Moving is a `PATCH` that sets `folderId` to a target docs-folder in the same site
(or `null` for the site root). A folder id that doesn't belong to this site
returns `400`.

```bash
curl -X PATCH https://docs.cubityfir.st/api/v1/docs/DOC_ID \
  -H "Authorization: Bearer $ANNEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "folderId": "FOLDER_ID" }'
```

### Delete a document

```
DELETE /v1/docs/:id
```
Requires: `readwrite` scope **and** owner is editor+. The site's designated home
document cannot be deleted (`403`).

```bash
curl -X DELETE https://docs.cubityfir.st/api/v1/docs/DOC_ID \
  -H "Authorization: Bearer $ANNEX_KEY"
```

---

## Members

All member endpoints require a key with `canInvite: true` **and** an owner who is
currently an **admin or owner** of the site. Otherwise every member endpoint
returns `403`.

### List members

```
GET /v1/members
```

```jsonc
{ "ok": true, "data": [
  { "userId": "…", "email": "…", "name": "…", "role": "editor",
    "accepted": true, "createdAt": "…" }
] }
```

### Invite a member

```
POST /v1/members
```

| Field   | Type   | Required | Notes                                                   |
| ------- | ------ | -------- | ------------------------------------------------------- |
| `email` | string | yes      | The user must already have an account                   |
| `role`  | string | yes      | `limited` \| `viewer` \| `editor` \| `admin` (never `owner`) |

You can never assign a role higher than your own. The user must accept the invite
before it grants access (it appears as `accepted: false` until then).

```bash
curl -X POST https://docs.cubityfir.st/api/v1/members \
  -H "Authorization: Bearer $ANNEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "email": "teammate@example.com", "role": "editor" }'
```

Returns `404` if no account exists for that email, `409` if they're already a
member, `400` for an invalid/`owner` role.

### Revoke an invite / remove a member

```
DELETE /v1/members/:userId
```
The owner can never be removed; an admin cannot remove another admin.

```bash
curl -X DELETE https://docs.cubityfir.st/api/v1/members/USER_ID \
  -H "Authorization: Bearer $ANNEX_KEY"
```

---

## Managing keys

Keys are created and revoked from the app, not the API:

**Site Settings → Developer → API Keys → New key**

* Choose **Read only** or **Read & write** (read-only is the only option if your
  role on the site is below editor).
* Optionally enable **Manage members** (admins/owners only).
* Copy the secret immediately - it is shown once.
* Revoke a key at any time; integrations using it stop working instantly.

Programmatic management endpoints (JWT/session-authenticated, used by the UI):

| Method   | Path                                  | Description              |
| -------- | ------------------------------------- | ----------------------- |
| `GET`    | `/api/projects/:id/api-keys`          | List your own keys      |
| `POST`   | `/api/projects/:id/api-keys`          | Create a key (returns the secret once) |
| `DELETE` | `/api/projects/:id/api-keys/:keyId`   | Revoke a key            |
