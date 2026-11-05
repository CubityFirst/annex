import { useEffect, useState } from "react";
import { useParams, useNavigate, useOutletContext } from "react-router-dom";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { getToken } from "@/lib/auth";
import { GraphView, type GraphData } from "@/components/GraphView";

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

  return (
    <div className="h-full w-full">
      <GraphView
        showControls
        data={data}
        onNodeClick={id => navigate(`/projects/${projectId}/docs/${id}`)}
      />
    </div>
  );
}
