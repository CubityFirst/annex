// Client-side sorting for the File Manager listing. The listing renders three
// independent groups - folders, docs, files - in that fixed order; a header
// click sorts the rows *within* each group, never across groups. Sorting keys
// off the raw fields (`file.size: number`, ISO date strings), not the formatted
// `formatBytes` / `formatRelativeTime` display strings.

export type SortDir = "asc" | "desc";

export interface SortState {
  colIdx: number;
  dir: SortDir;
}

// Mirrors FILE_COLUMNS order in FileManager: Name, Created by, Size, Last updated.
export const SortCol = {
  Name: 0,
  CreatedBy: 1,
  Size: 2,
  Updated: 3,
} as const;

type SortKind = "text" | "number" | "date";

function isMissing(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

// Ascending comparison for a given kind. Text uses the project's localeCompare
// idiom with natural numeric ordering so "item2" sorts before "item10".
function compareBy(kind: SortKind, a: unknown, b: unknown): number {
  if (kind === "number") return (a as number) - (b as number);
  if (kind === "date") {
    const ta = Date.parse(a as string);
    const tb = Date.parse(b as string);
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    return String(a).localeCompare(String(b));
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

// Stable sort that keeps missing/empty keys at the end in *both* directions
// (the direction only flips the order of present values). Equal keys keep
// their original relative order.
function stableSort<T>(items: T[], getKey: (t: T) => unknown, kind: SortKind, dir: SortDir): T[] {
  const present: { value: T; index: number; key: unknown }[] = [];
  const missing: T[] = [];
  items.forEach((value, index) => {
    const key = getKey(value);
    if (isMissing(key)) missing.push(value);
    else present.push({ value, index, key });
  });
  const sign = dir === "asc" ? 1 : -1;
  present.sort((x, y) => {
    const c = compareBy(kind, x.key, y.key);
    // Tiebreak on original index (not sign-flipped) so equal keys stay stable
    // regardless of direction.
    return c !== 0 ? sign * c : x.index - y.index;
  });
  return [...present.map(p => p.value), ...missing];
}

// Folders only carry a name. Every non-Name column falls back to Name-ascending
// so the folder group stays deterministic and never looks empty/unsorted.
export function sortFolders<T extends { name: string }>(folders: T[], sort: SortState | null): T[] {
  if (!sort) return folders;
  if (sort.colIdx === SortCol.Name) return stableSort(folders, f => f.name, "text", sort.dir);
  return stableSort(folders, f => f.name, "text", "asc");
}

export function sortDocs<
  T extends { title: string; author_name?: string | null; updated_at: string },
>(docs: T[], sort: SortState | null): T[] {
  if (!sort) return docs;
  switch (sort.colIdx) {
    case SortCol.Name:
      return stableSort(docs, d => d.title, "text", sort.dir);
    case SortCol.CreatedBy:
      return stableSort(docs, d => d.author_name, "text", sort.dir);
    case SortCol.Updated:
      return stableSort(docs, d => d.updated_at, "date", sort.dir);
    default:
      // Docs have no Size - fall back to title-ascending.
      return stableSort(docs, d => d.title, "text", "asc");
  }
}

export function sortFiles<
  T extends { name: string; uploader_name?: string | null; size: number; created_at: string },
>(files: T[], sort: SortState | null): T[] {
  if (!sort) return files;
  switch (sort.colIdx) {
    case SortCol.Name:
      return stableSort(files, f => f.name, "text", sort.dir);
    case SortCol.CreatedBy:
      return stableSort(files, f => f.uploader_name, "text", sort.dir);
    case SortCol.Size:
      return stableSort(files, f => f.size, "number", sort.dir);
    case SortCol.Updated:
      return stableSort(files, f => f.created_at, "date", sort.dir);
    default:
      return files;
  }
}
