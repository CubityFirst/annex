# Annex MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) that
lets AI clients (Claude Code, Claude Desktop, Cursor, …) read and edit Annex
docs through the public [`/v1` API](../../docs/api/README.md).

It authenticates with **site-scoped API keys** only. Each key is bound to one
site on the server, so the MCP can never reach a site you didn't hand it a key
for. To work across several sites, give it several keys.

## Setup

1. In Annex, open **Site Settings → Developer → API Keys** for each site and
   create a key. Prefer **Read only** unless you want the agent to edit. Only
   enable **Manage members** if you need it.
2. Build the server:

   ```sh
   pnpm install
   pnpm --filter @annex/mcp build
   ```

3. Register it with your client. For Claude Code (`.mcp.json`):

   ```json
   {
     "mcpServers": {
       "annex": {
         "command": "node",
         "args": ["/absolute/path/to/annex/packages/mcp/dist/index.js"],
         "env": {
           "ANNEX_API_KEYS": "handbook=annx_xxxxxxxx,wiki=annx_yyyyyyyy"
         }
       }
     }
   }
   ```

   Keep this file out of version control. It contains secrets.

## Configuration

| Variable              | Required | Description |
| --------------------- | -------- | ----------- |
| `ANNEX_API_KEYS`      | yes\*    | One or more keys, separated by commas, spaces or newlines. Each entry is `annx_…` or `alias=annx_…`. |
| `ANNEX_API_KEY`       | yes\*    | A single key (merged with `ANNEX_API_KEYS`). |
| `ANNEX_API_URL`       | no       | API base. Default `https://docs.cubityfir.st/api`. Must be `https` (plain `http` only for localhost, e.g. `http://localhost:5173/api` in dev). |
| `ANNEX_MCP_READ_ONLY` | no       | `1`/`true` hides every content- and member-mutating tool, even for read-write keys. |

\* At least one key is required.

### Multiple keys

On startup the server calls `GET /v1/key` for every key to learn which site it
belongs to and what it may do. Each key becomes a **site handle**:

- the alias, if you gave one (`wiki=annx_…`), else
- the site's vanity slug, else a slug of the site name (`Team Handbook` →
  `team-handbook`), with `-2`, `-3`, … appended on collisions (e.g. two keys for
  the same site).

Tools take a `site` argument: a handle, site id, vanity slug or exact site
name. With exactly one usable site it may be omitted. `list_sites` re-checks
every key and shows its status. A key that fails (revoked, owner removed, API
unreachable) is reported there and never blocks the others.

## Tools

| Tool | Needs | Description |
| ---- | ----- | ----------- |
| `list_sites` | any key | Sites, handles, scope, `canInvite`, owner's live role, status |
| `list_docs` | any key | Doc summaries (optional `titleContains` filter) |
| `get_doc` | any key | Metadata + full markdown body |
| `create_doc` | `readwrite`, owner editor+ | New doc (optional `folderId`) |
| `update_doc` | `readwrite`, owner editor+ | Retitle, replace body, move (`folderId`), publish/unpublish |
| `delete_doc` | `readwrite`, owner editor+ | Moves to the recycle bin (30-day restore) |
| `list_members` | `canInvite`, owner admin+ | Members + pending invites |
| `invite_member` | `canInvite`, owner admin+ | Invite an existing user by email |
| `remove_member` | `canInvite`, owner admin+ | Remove a member / revoke an invite |
| `revoke_key` | the key itself | Permanently revokes that site's key (`DELETE /v1/key`). Requires an explicit `site` and `confirm: true` |

Results are compact JSON, kept small because they all land in the model's
context. Fields left out mean the default: in `list_docs` a doc with no
`folderId` is at the site root (single-doc results say `folderId: null`), and
only unaccepted invites carry `pending: true`. `published` is always a boolean,
because models in evals distrusted an absent flag. Tool descriptions are also kept short. Server `instructions`
hold only the site/key model and the prompt-injection rule, because some
clients drop them, so each tool's own text has to be enough to use it.

Write and member tools are only listed if at least one configured key could use
them. This is re-evaluated whenever the keys are re-checked (`list_sites`, a
retry after an unresolved key, a revoked key), and the client is sent a
`tools/list_changed` notification when the listing changes. Annex still enforces the real ceiling on every request (key scope **and**
the owner's current role), so the MCP never needs to be trusted for authorization.

## Security notes

- **Prompt injection.** Doc bodies are user-authored and are returned to the
  model as data. If you configure keys for several sites, a malicious doc in one
  could try to get the agent to copy content into another. Give the agent
  read-only keys where you can, and only the sites it needs.
- **Leaked key?** Revoke it from Site Settings, call `revoke_key`, or run
  `curl -X DELETE https://docs.cubityfir.st/api/v1/key -H "Authorization: Bearer annx_…"`.
  Self-revocation works even while the API killswitch is on, and even if the
  key's owner has since lost access.
- Full keys are never logged or returned by any tool. Only the display prefix
  (`annx_AbC123…`) is shown.

## Development

```sh
pnpm --filter @annex/mcp test        # vitest (fake /v1 backend over the real MCP protocol)
pnpm --filter @annex/mcp typecheck
pnpm --filter @annex/mcp build       # → dist/
```

To run against the local stack, use `ANNEX_API_URL=http://localhost:8787` (API
worker directly) or `http://localhost:5173/api` (through the Vite proxy).
