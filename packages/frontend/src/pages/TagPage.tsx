import { useEffect, useState } from "react";
import { useParams, useNavigate, useOutletContext } from "react-router-dom";
import { FileText, Tag } from "lucide-react";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { formatRelativeTime } from "@/lib/fileManager";
import { getToken } from "@/lib/auth";

// Same column as the file viewer (FilePage's VIEWER_COLUMN_CLASS): a 44rem
// column centred in the content area that, at xl, keeps the doc column's
// left edge but may run wider to the right (capped at 56rem), so the list
// doesn't leave a wide empty band beside it.
const TAG_COLUMN_CLASS =
  "mx-auto max-w-[44rem] xl:mr-0 xl:ml-[max(0px,calc((100%_-_44rem)/2))] xl:max-w-[56rem]";

/** The colour a site's graph tag-colour rules give `tag` (the first matching
 *  rule wins, as in the graph), or null when no rule names it. */
function resolveTagColor(rawRules: string | null | undefined, tag: string): string | null {
  if (!rawRules) return null;
  try {
    const rules = JSON.parse(rawRules) as unknown;
    if (!Array.isArray(rules)) return null;
    for (const rule of rules as { tag?: unknown; color?: unknown }[]) {
      if (rule && rule.tag === tag && typeof rule.color === "string" && rule.color) return rule.color;
    }
  } catch {
    /* malformed rules: no colour */
  }
  return null;
}

/** Fetches the site's graph tag-colour rules and resolves `tag` against them. */
function useTagColor(projectId: string | undefined, tag: string): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    setColor(null);
    const token = getToken();
    if (!projectId || !tag || !token) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json() as Promise<{ ok: boolean; data?: { graph_tag_colors?: string | null } }>)
      .then(json => {
        if (!cancelled && json.ok) setColor(resolveTagColor(json.data?.graph_tag_colors, tag));
      })
      .catch(() => { /* no chip; the plain tag icon stays */ });
    return () => { cancelled = true; };
  }, [projectId, tag]);
  return color;
}

function buildFolderPath(
  folderId: string | null | undefined,
  folders: { id: string; name: string; parent_id: string | null }[],
): string {
  if (!folderId) return "";
  const parts: string[] = [];
  let current: string | null = folderId;
  while (current) {
    const folder = folders.find(f => f.id === current);
    if (!folder) break;
    parts.unshift(folder.name);
    current = folder.parent_id;
  }
  return parts.join(" / ");
}

export function TagPage() {
  const { projectId, tag } = useParams<{ projectId: string; tag: string }>();
  const navigate = useNavigate();
  const { docs, folders, projectName, setBreadcrumbs } = useOutletContext<DocsLayoutContext>();

  const decodedTag = tag ? decodeURIComponent(tag) : "";
  const tagColor = useTagColor(projectId, decodedTag);

  const matchingDocs = docs.filter(doc => {
    if (!doc.tags) return false;
    try {
      const tags = JSON.parse(doc.tags) as string[];
      return tags.includes(decodedTag);
    } catch {
      return false;
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      ...(projectName ? [{ id: null, name: projectName, onClick: () => navigate(`/projects/${projectId}`) }] : []),
      { id: null, name: "Tags" },
      { id: null, name: decodedTag },
    ]);
    return () => setBreadcrumbs([]);
  }, [decodedTag, projectId, projectName, navigate, setBreadcrumbs]);

  if (!projectId || !tag) return null;

  // Same reading layout as DocPage/FilePage (a 44rem column in a flex row,
  // with the empty w-60 outline rail reserved at xl), so the header doesn't
  // shift when you click a tag from a doc. Like the file viewer, the column
  // may widen to the right at xl (TAG_COLUMN_CLASS).
  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 px-5 py-6 sm:px-6 sm:py-10">
      <div data-testid="tag-column" className={TAG_COLUMN_CLASS}>
      <div className="mb-6">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">Tag</p>
        <div className="flex items-center gap-2.5">
          <Tag className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="min-w-0 truncate text-[1.75rem] font-semibold leading-tight tracking-tight">{decodedTag}</h1>
          {tagColor && (
            // The tag's graph colour (Site settings → Graph view → Tag colours).
            <span
              data-testid="tag-color-chip"
              role="img"
              aria-label="Tag colour"
              title="Tag colour"
              className="size-3 shrink-0 rounded-full ring-1 ring-inset ring-foreground/15"
              style={{ backgroundColor: tagColor }}
            />
          )}
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {matchingDocs.length} {matchingDocs.length === 1 ? "document" : "documents"} tagged{" "}
          <span className="font-medium text-foreground">{decodedTag}</span>
        </p>
      </div>

      {matchingDocs.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <Tag className="mb-2 size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">No documents found with this tag.</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Add <span className="font-mono">tags: [{decodedTag}]</span> to a document&apos;s frontmatter to list it here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {matchingDocs.map(doc => {
            const folderPath = buildFolderPath(doc.folder_id, folders);
            // The layout's doc list carries updated_at at runtime even though
            // the context type doesn't declare it.
            const updatedAt = (doc as { updated_at?: string | null }).updated_at ?? null;
            return (
              <li key={doc.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/projects/${projectId}/docs/${doc.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {doc.display_title ?? doc.title}
                    </p>
                    {folderPath && (
                      <p className="truncate text-xs text-muted-foreground">{folderPath}</p>
                    )}
                  </div>
                  {updatedAt && (
                    <time
                      dateTime={updatedAt}
                      title={new Date(updatedAt).toLocaleString()}
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                    >
                      {formatRelativeTime(updatedAt)}
                    </time>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      </div>
      </div>
      {/* Empty rail matching the doc outline rail. */}
      <div className="hidden w-60 shrink-0 xl:block" aria-hidden="true" />
    </div>
  );
}
