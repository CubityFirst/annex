import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useOutletContext } from "react-router-dom";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { getToken } from "@/lib/auth";
import { GraphView, type GraphData } from "@/components/GraphView";

/** Links as the canvas draws them: one per unordered pair of docs, so a
 *  two-way pair (A→B and B→A) counts once and self-links don't count. */
function countUniqueLinks(edges: GraphData["edges"]): number {
  const pairs = new Set<string>();
  for (const e of edges) {
    const s = String(e.source);
    const t = String(e.target);
    if (s === t) continue;
    pairs.add(s < t ? `${s}\u0000${t}` : `${t}\u0000${s}`);
  }
  return pairs.size;
}

export function GraphPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { projectName, setBreadcrumbs } = useOutletContext<DocsLayoutContext>();

  // Give the graph the same top bar as every other site page so it doesn't
  // render as a bare canvas with no title or way back.
  useEffect(() => {
    setBreadcrumbs([
      { id: null, name: projectName, onClick: () => navigate(`/projects/${projectId}`) },
      { id: "graph", name: "Graph" },
    ]);
    return () => setBreadcrumbs([]);
  }, [projectId, projectName, navigate, setBreadcrumbs]);

  useEffect(() => {
    if (!projectId) return;
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    fetch(`/api/projects/${projectId}/graph`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json() as Promise<{ ok: boolean; data?: GraphData; error?: string }>)
      .then(json => {
        if (json.ok && json.data) setData(json.data);
        else setError(json.error ?? "Failed to load graph.");
      })
      .catch(() => setError("Could not connect to the server."))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Legend: only the tag-colour rules that actually colour a node here, so
  // the card doesn't list tags no document carries.
  const legend = useMemo(() => {
    if (!data?.tagColors?.length) return [];
    const used = new Set(data.nodes.flatMap(n => n.tags ?? []));
    const seen = new Set<string>();
    return data.tagColors.filter(rule => {
      if (!rule.tag || !used.has(rule.tag) || seen.has(rule.tag)) return false;
      seen.add(rule.tag);
      return true;
    });
  }, [data]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading graph…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">No documents to graph yet.</p>
      </div>
    );
  }

  const docCount = data.nodes.length;
  const linkCount = countUniqueLinks(data.edges);

  return (
    <div className="relative h-full w-full">
      <GraphView
        showControls
        showLegend={false}
        data={data}
        onNodeClick={id => navigate(`/projects/${projectId}/docs/${id}`)}
      />
      {/* Summary card: what the canvas shows, plus the tag-colour key when
          the site has tag colours. Pointer-transparent so it never blocks
          dragging or clicking nodes underneath. */}
      <div
        data-testid="graph-summary"
        className="pointer-events-none absolute left-4 top-4 max-w-[calc(100%-2rem)] rounded-lg border border-border bg-card/90 px-3 py-2 text-xs shadow-sm backdrop-blur sm:max-w-xs"
      >
        <p className="font-medium text-foreground tabular-nums">
          {docCount} {docCount === 1 ? "doc" : "docs"} · {linkCount} {linkCount === 1 ? "link" : "links"}
        </p>
        {legend.length > 0 && (
          <ul aria-label="Tag colour legend" className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
            {legend.map(rule => (
              <li key={rule.tag} className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: rule.color }}
                />
                <span className="truncate">{rule.tag}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
