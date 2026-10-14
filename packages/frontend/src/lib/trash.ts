// Client side of the site recycle bin (API: packages/api/src/lib/trash.ts,
// routes /projects/:id/trash). Deleting a doc, file or folder moves it to the
// bin; editors restore, admins delete forever, and entries auto-purge after
// `retentionDays`.

import { apiFetchJson } from "@/lib/apiFetch";

export type TrashItemType = "doc" | "file" | "folder";

export interface TrashEntry {
  id: string;
  item_type: TrashItemType;
  item_id: string;
  name: string;
  folder_id: string | null;
  folder_path: string | null;
  doc_count: number;
  file_count: number;
  folder_count: number;
  size: number;
  deleted_by: string;
  deleted_by_name: string | null;
  deleted_at: string;
}

export interface TrashListing {
  entries: TrashEntry[];
  retentionDays: number;
  canPurge: boolean;
}

export interface RestoreResult {
  type: TrashItemType;
  itemId: string;
  folderId: string | null;
}

export function restoreTrashEntry(projectId: string, entryId: string) {
  return apiFetchJson<RestoreResult>(`/api/projects/${projectId}/trash/${entryId}/restore`, { method: "POST" });
}

// Where a restored item lives now - the page to send the user to.
export function restoredItemUrl(projectId: string, r: RestoreResult): string {
  if (r.type === "doc") return `/projects/${projectId}/docs/${r.itemId}`;
  if (r.type === "file") return `/projects/${projectId}/files/${r.itemId}`;
  return `/projects/${projectId}/folders/${r.itemId}`;
}

// "3 docs, 1 file, 2 folders" for a binned folder's contents; "" for a lone
// doc/file (or an empty folder).
export function trashContentsLabel(e: Pick<TrashEntry, "item_type" | "doc_count" | "file_count" | "folder_count">): string {
  if (e.item_type !== "folder") return "";
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => { if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`); };
  add(e.doc_count, "doc", "docs");
  add(e.file_count, "file", "files");
  add(e.folder_count, "folder", "folders");
  return parts.join(", ");
}

// Whole days left before the retention sweep purges an entry, never negative
// (an overdue entry waits for the next daily run).
export function daysUntilPurge(deletedAt: string, retentionDays: number, now = Date.now()): number {
  const purgeAt = new Date(deletedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - now) / (24 * 60 * 60 * 1000)));
}
