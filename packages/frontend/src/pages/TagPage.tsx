import { useEffect } from "react";
import { useParams, useNavigate, useOutletContext } from "react-router-dom";
import { FileText, Tag } from "lucide-react";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";

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
  const { docs, folders, setBreadcrumbs } = useOutletContext<DocsLayoutContext>();

  const decodedTag = tag ? decodeURIComponent(tag) : "";

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
    setBreadcrumbs([{ id: null, name: decodedTag }]);
    return () => setBreadcrumbs([]);
  }, [decodedTag, setBreadcrumbs]);

  if (!projectId || !tag) return null;

  return (
    <div className="px-4 py-8 sm:px-8 sm:py-10 max-w-3xl">
      <div className="mb-8 flex items-center gap-2">
        <Tag className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-semibold tracking-tight">{decodedTag}</h1>
        <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {matchingDocs.length}
        </span>
      </div>

      {matchingDocs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No documents found with this tag.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {matchingDocs.map(doc => {
            const folderPath = buildFolderPath(doc.folder_id, folders);
            return (
              <button
                key={doc.id}
                onClick={() => navigate(`/projects/${projectId}/docs/${doc.id}`)}
                className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {doc.display_title ?? doc.title}
                  </p>
                  {folderPath && (
                    <p className="truncate text-xs text-muted-foreground">{folderPath}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
