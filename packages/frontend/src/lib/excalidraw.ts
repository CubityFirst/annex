// Shared constants + helpers for the Excalidraw drawing file kind. The heavy
// @excalidraw/excalidraw package itself is only imported by ExcalidrawCanvas
// (lazy-loaded), never from here, so importing these stays cheap.

// Vendor MIME stored on a drawing's file row. The API keys its mutable-content
// path (PUT /files/:id/content + versioned ETag) off this exact type, so it must
// match packages/api/src/lib.ts EXCALIDRAW_MIME. Keyed on MIME (not the name) so a
// rename can't flip a drawing back to "immutable".
export const EXCALIDRAW_MIME = "application/vnd.excalidraw+json";
export const EXCALIDRAW_EXT = ".excalidraw";

// Client-side mirror of the content ETag the API maintains for mutable files:
// `"<fileId>-<updatedAtMs>"` (quoted, per HTTP). Used for If-Match on drawing
// saves whenever a response's own ETag header isn't available - keep in sync
// with the server's formula in packages/api/src/routes/files.ts.
export function fileContentEtag(fileId: string, updatedAtIso: string): string {
  return `"${fileId}-${new Date(updatedAtIso).getTime()}"`;
}

// A blank Excalidraw scene, matching the shape the editor reads/writes. Used when
// creating a new drawing file (FileManager → "New drawing").
export function emptyExcalidrawScene(): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://annex",
    elements: [],
    appState: {},
    files: {},
  });
}
