// Pure helpers backing the File Manager listing (FileManager.tsx). Extracted
// so the range/selection/move logic is unit-testable without rendering the
// component.

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// .md / .txt uploads import as documents rather than opaque file entries.
// Case-insensitive: Windows commonly produces README.MD / NOTES.TXT. The
// single regex is shared by the detection and the title-stripping so the
// importable-extension list can't drift between them.
const DOC_IMPORT_EXT_RE = /\.(md|txt)$/i;

export function isDocImportName(name: string): boolean {
  return DOC_IMPORT_EXT_RE.test(name);
}

// "notes.md" → "notes"; used as the imported document's title.
export function stripDocImportExt(name: string): string {
  return name.replace(DOC_IMPORT_EXT_RE, "");
}

export interface MoveFolderLike {
  id: string;
  name: string;
  parent_id: string | null;
}

// Destinations offered in the move picker: every folder in the project, minus
// (for a folder being moved) itself and its descendants, since the API rejects
// a move that would create a cycle. "Home" (root) is added separately in the UI.
export function moveDestinations<F extends MoveFolderLike>(
  all: F[],
  target: { type: "folder" | "doc" | "file"; id: string } | null,
): F[] {
  if (!target || target.type !== "folder") return all;
  const banned = new Set<string>([target.id]);
  let added = true;
  while (added) {
    added = false;
    for (const f of all) {
      if (f.parent_id && banned.has(f.parent_id) && !banned.has(f.id)) {
        banned.add(f.id);
        added = true;
      }
    }
  }
  return all.filter(f => !banned.has(f.id));
}

// Full ancestry label ("Parent / Child / Grandchild") for a folder in the move
// picker, so duplicate names in different branches stay distinguishable.
// Defensive against a broken parent chain (missing row or cycle) - it stops
// rather than looping forever. Callers labelling many folders should build the
// byId map once and pass it in (avoids O(n²) map rebuilds).
export function folderPathLabel(
  all: MoveFolderLike[],
  folder: MoveFolderLike,
  byId: Map<string, MoveFolderLike> = new Map(all.map(f => [f.id, f])),
): string {
  const names: string[] = [folder.name];
  const seen = new Set<string>([folder.id]);
  let parentId = folder.parent_id;
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    seen.add(parent.id);
    parentId = parent.parent_id;
  }
  return names.join(" / ");
}

// Inclusive [from, to] range for a shift-click selection, or null when there is
// no usable anchor. The anchor is clamped to the current list length so a stale
// anchor from a longer, previously-rendered list can never index out of bounds.
export function shiftSelectionRange(
  anchor: number | null,
  clicked: number,
  listLength: number,
): { from: number; to: number } | null {
  if (anchor === null || listLength === 0) return null;
  const clampedAnchor = Math.min(Math.max(anchor, 0), listLength - 1);
  const clampedClicked = Math.min(Math.max(clicked, 0), listLength - 1);
  return {
    from: Math.min(clampedAnchor, clampedClicked),
    to: Math.max(clampedAnchor, clampedClicked),
  };
}

export interface FolderCounts {
  docs: number;
  files: number;
  folders: number;
}

// Human label for the folder badge: "2 docs, 3 files, 1 folder". Empty string
// when the folder is empty or has no counts row (the badge is not rendered).
export function folderCountLabel(c: FolderCounts | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.docs > 0) parts.push(`${c.docs} ${c.docs === 1 ? "doc" : "docs"}`);
  if (c.files > 0) parts.push(`${c.files} ${c.files === 1 ? "file" : "files"}`);
  if (c.folders > 0) parts.push(`${c.folders} ${c.folders === 1 ? "folder" : "folders"}`);
  return parts.join(", ");
}
