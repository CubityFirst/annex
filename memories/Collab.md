# Realtime Collaboration

Yjs-based realtime co-editing for docs, gated per-project by a feature flag and served from a Durable Object behind the API worker. Read this before touching `DocCollabRoom`, the `/api/docs/:id/collab` WebSocket route, `CollabProvider`, `EditorPresence`, or anything wiring the `collab` prop on `WysiwygEditor`.

## Feature flag

Enabled per-project via `projects.features & 4` (`ProjectFeatures.REALTIME`). Toggle in the admin panel.

## Architecture

Browser ↔ WebSocket `/api/docs/:id/collab?token=<jwt>` ↔ API Worker (auth + flag check) ↔ `DocCollabRoom` Durable Object (Yjs CRDT server, WebSocket hibernation).

## Key files

- `packages/api/src/collab/DocCollabRoom.ts` - Durable Object; holds `Y.Doc` in memory, persists snapshot to R2 via a debounced alarm after edits and on last-client-close. The Awareness `_checkInterval` is cleared at construction to allow WebSocket hibernation, and `teardown()` is called when the last client disconnects so the DO can be evicted.
- `packages/frontend/src/components/wysiwyg/WysiwygEditor.tsx` - CodeMirror 6 editor used universally (flag-on and flag-off); Yjs/WebSocket extensions only wired when the `collab` prop is set.
- `packages/frontend/src/components/EditorPresence.tsx` - title-bar avatars (first 3 + "+N" overflow popover) fed from Yjs awareness state.
- `packages/frontend/src/lib/userColor.ts` - deterministic HSL color from user UUID.

## WebSocket auth

Token passed as `?token=` (browsers can't set headers on WS); API worker re-wraps it as `Authorization: Bearer` and calls `authenticate()`, which verifies inline against `AUTH_DB` (see CLAUDE.md "Verification boundary").

## DO room key

`${projectId}:${docId}` - one room per document.

## Reconnect backoff

`CollabProvider` uses a single once-fired `onDisconnect` handler (covers both `close` and `error` events) with exponential backoff starting at 1s, capped at 30s, reset to 1s on successful open. This prevents double-reconnect spam.

## Enabling for a project locally

```
cd packages/api && npx wrangler d1 execute cubedocs-main --local --persist-to ../../.wrangler/state \
  --command "UPDATE projects SET features = features | 4 WHERE id = '<projectId>';"
```
