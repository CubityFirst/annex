# Excalidraw Drawing Files

Excalidraw drawings (`@excalidraw/excalidraw`, MIT) are a **file kind**, not a separate
entity - they live in the existing `files` table + R2 blob storage and reuse the
`POST /files` upload path. No realtime collaboration (single-editor save/load). Read
this before touching the drawing editor, the mutable-content path, or the `"drawing"`
file kind.

## The one structural change: mutable file content

Uploaded media is immutable (one blob per id, strong content ETag `"<id>"`, long cache).
Drawings are edited in place, so **only drawings** get a mutable blob:

- A drawing carries the vendor MIME **`application/vnd.excalidraw+json`** (`EXCALIDRAW_MIME`
  in `packages/api/src/lib.ts` and `packages/frontend/src/lib/excalidraw.ts` - they must
  match). `isMutableFile(mime)` keys off this exact type - **never the file name**, so a
  rename via `PUT /files/:id` can't flip mutability, and media can never be flipped mutable.
- `PUT /files/:id/content` (`routes/files.ts`, editor+) overwrites `files/<id>` in R2 and
  sets `files.updated_at`. It **hard-rejects any non-mutable file with 400** - uploaded
  media cannot be overwritten through any route.
- The content ETag is **versioned**: `"<id>-<updatedAtMs>"` (both `routes/files.ts` and
  `routes/public.ts`). Mutable files serve `no-cache` (always revalidate); immutable media
  keep their long cache and a stable ETag (their `updated_at == created_at` forever).
- Migration `0056_add_file_updated_at.sql` added `files.updated_at`, backfilled to
  `created_at`. `files` is API-DB-only → **deploy = API worker only** (no triple-redeploy).

## Frontend

- `lib/fileKind.ts` - `.excalidraw` → kind `"drawing"` (extension-first, before text/MIME so
  a JSON-typed drawing never previews as a code block). `FileTypeIcon` → `PenTool`.
- `components/ExcalidrawCanvas.tsx` - the canvas, **lazy-loaded** (heavy chunk; default
  export, `React.lazy`). One component, two modes: `readOnly` → `<Excalidraw viewModeEnabled>`
  (a live pan/zoom canvas - chosen over a static SVG export); editable → full editor + a **single
  floating Save button** (bottom-right). No custom toolbar/Download of our own - Excalidraw's
  own menu handles export/download/zoom. Save serializes (`serializeAsJSON`) and `PUT`s to the
  content URL; also Ctrl/Cmd-S. Fetches the scene with `cache:"no-store"`, syncs theme
  (`isLightTheme`), dirty-tracking via a `settledRef` gate. **Save-on-exit safety net:** a
  `keepalive` PUT fires on unmount (SPA nav, which `beforeunload` can't catch) + `pagehide`
  when dirty, so edits aren't silently lost. Loading states use `components/ui/spinner.tsx`.
  No collab.
- `FilePage.tsx` - `kind === "drawing"` branch: editor+ get the editable canvas, everyone
  else read-only; fills the content area (`h-full`). `FileManager.tsx` - "New drawing" button
  (`handleNewDrawing`) POSTs an empty scene as a file. `PublicDocPage.tsx` - published drawings
  render **full-bleed in the right pane** (read-only canvas via plain `fetch`, lifted out of
  `PublicFileView`/`ScrollArea` to fill `flex-1 min-h-0`, like the graph view), not in a box.
- `lib/excalidraw.ts` - `EXCALIDRAW_MIME`, `EXCALIDRAW_EXT`, `emptyExcalidrawScene()`.
- `vite.config.ts` - `define: { "process.env.IS_PREACT": ... }` (Excalidraw reads it at
  runtime; without it the chunk throws "process is not defined").

## Not gated by a feature flag

Always-on for every site - a client-rendered stored blob has the same risk profile as
images/PDFs, none of which are flagged. No admin surface.

## Tests

- `packages/api/src/lib.test.ts` - `isMutableFile`. `integration.test.ts` - create drawing →
  `PUT content` (200 + ETag bust), non-drawing `PUT content` → 400, unauthenticated → 401.
- `packages/frontend/src/lib/fileKind.test.ts` - `.excalidraw` → `"drawing"`.
- `e2e/tests/excalidraw.spec.ts` - New drawing → editor mounts → draw + Save → reload persists.
- Demo mode (`lib/demoServer.ts`) has a `PUT .../content` branch so saving doesn't 404.
