// Tracks per-project "recently accessed" items (docs + files) for display
// in the project sidebar. localStorage rather than a cookie so we don't pay
// the round-trip cost on every request and don't squeeze the 4KB cookie cap
// across many projects.

const STORAGE_KEY = "cd_recent_docs";
const MAX_PER_PROJECT = 3;
const UPDATED_EVENT = "cd:recent-items-updated";

export type RecentItemKind = "doc" | "file";

export interface RecentItem {
  id: string;
  title: string;
  kind: RecentItemKind;
  mime?: string;
  accessedAt: number;
}

type Store = Record<string, RecentItem[]>;

function readAll(): Store {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Drop entries written under prior schemas (no `kind` field) - they
    // route to /files/ by default and 404 because the id is a doc id.
    const cleaned: Store = {};
    for (const [pid, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      cleaned[pid] = list.filter((it): it is RecentItem =>
        !!it && typeof it === "object" &&
        typeof (it as RecentItem).id === "string" &&
        ((it as RecentItem).kind === "doc" || (it as RecentItem).kind === "file"),
      );
    }
    return cleaned;
  } catch {
    return {};
  }
}

function writeAll(data: Store): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // quota exceeded or storage disabled - silently skip
  }
}

export function readRecentItems(projectId: string): RecentItem[] {
  return readAll()[projectId] ?? [];
}

export function pushRecentItem(
  projectId: string,
  item: { id: string; title: string; kind: RecentItemKind; mime?: string },
): void {
  const all = readAll();
  // Dedupe by (kind, id) so a doc and a file sharing an id don't collide.
  const previous = (all[projectId] ?? []).filter(d => !(d.id === item.id && d.kind === item.kind));
  const next: RecentItem[] = [
    {
      id: item.id,
      title: item.title || "Untitled",
      kind: item.kind,
      mime: item.mime,
      accessedAt: Date.now(),
    },
    ...previous,
  ].slice(0, MAX_PER_PROJECT);
  all[projectId] = next;
  writeAll(all);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UPDATED_EVENT, { detail: { projectId } }));
  }
}

export function onRecentItemsUpdated(callback: (projectId: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ projectId: string }>).detail;
    if (detail?.projectId) callback(detail.projectId);
  };
  window.addEventListener(UPDATED_EVENT, handler);
  return () => window.removeEventListener(UPDATED_EVENT, handler);
}
