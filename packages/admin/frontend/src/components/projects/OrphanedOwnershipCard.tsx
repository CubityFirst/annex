import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type OrphanedOwnership, listOrphanedOwnership } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

// Sites and orgs whose owner deleted their account on auth.cubityfir.st. The
// deletion sync keeps them (other members may still rely on them); an
// operator decides here whether to delete them. Renders nothing when there's
// nothing to review.
export function OrphanedOwnershipCard({ onFilterSite, refreshKey }: { onFilterSite: (name: string) => void; refreshKey: unknown }) {
  const [data, setData] = useState<OrphanedOwnership | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listOrphanedOwnership(controller.signal)
      .then(d => { setData(d); setError(null); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Failed to load"); });
    return () => controller.abort();
  }, [refreshKey]);

  if (error) {
    return <p className="text-sm text-destructive">Couldn&apos;t load sites with deleted owners: {error}</p>;
  }
  if (!data || (data.sites.length === 0 && data.orgs.length === 0 && data.pending_deletions.length === 0)) return null;

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
          Owner account deleted
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          These owners deleted their account on auth.cubityfir.st. Their sites and organizations were kept for
          review: delete them here, or leave them for the remaining members.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data.sites.map(site => (
          <div key={site.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div className="min-w-0">
              <p className="font-medium">{site.name}</p>
              <p className="font-mono text-xs text-muted-foreground">{site.id}</p>
              <p className="text-xs text-muted-foreground">
                Owner deleted {formatDateTime(new Date(site.owner_deleted_at).toISOString())} ·{" "}
                {site.other_members} other member{site.other_members === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {site.published && <Badge variant="secondary">Published</Badge>}
              <Button size="sm" variant="outline" onClick={() => onFilterSite(site.name)}>
                Show in list
              </Button>
            </div>
          </div>
        ))}
        {data.orgs.map(org => (
          <div key={org.id} className="rounded-md border p-3">
            <p className="font-medium">{org.name} <span className="text-xs font-normal text-muted-foreground">(organization)</span></p>
            <p className="font-mono text-xs text-muted-foreground">{org.id}</p>
            <p className="text-xs text-muted-foreground">
              Owner deleted {formatDateTime(new Date(org.owner_deleted_at).toISOString())} · {org.sites} attached site
              {org.sites === 1 ? "" : "s"}
            </p>
          </div>
        ))}
        {data.pending_deletions.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium">
              {data.pending_deletions.length} deleted account{data.pending_deletions.length === 1 ? "" : "s"} not cleaned up yet
            </p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {data.pending_deletions.map(p => (
                <li key={p.user_id}>
                  <span className="font-mono">{p.user_id}</span>
                  {p.last_error ? ` - ${p.last_error}` : " - waiting for the next hourly run"}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
