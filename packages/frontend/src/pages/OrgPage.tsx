import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { BookOpen, Building2, ChevronLeft, Globe, Plus, Settings, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetchJson } from "@/lib/apiFetch";

type Role = "viewer" | "editor" | "admin" | "owner";

interface OrgDetail {
  id: string;
  name: string;
  role: Role;
}

interface OrgSite {
  id: string;
  name: string;
  description: string | null;
  published_at: string | null;
  doc_count: number;
  member_count: number;
}

export function OrgPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [sites, setSites] = useState<OrgSite[]>([]);
  const [notFound, setNotFound] = useState(false);

  // create-site-in-org dialog
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    apiFetchJson<OrgDetail>(`/api/organizations/${orgId}`)
      .then(result => {
        if (result.redirected) return;
        if (result.status === 404 || result.status === 403) { setNotFound(true); return; }
        if (result.ok && result.data) setOrg(result.data);
      })
      .catch(() => {});
    apiFetchJson<OrgSite[]>(`/api/organizations/${orgId}/projects`)
      .then(result => { if (result.ok && result.data) setSites(result.data); })
      .catch(() => {});
  }, [orgId]);

  const canManage = org !== null && (org.role === "admin" || org.role === "owner");

  async function handleCreateSite(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetchJson<{ id: string }>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, organizationId: orgId }),
      });
      if (result.ok && result.data) {
        navigate(`/projects/${result.data.id}`);
      } else {
        setError("Failed to create site.");
      }
    } catch {
      setError("Could not connect to the server.");
    } finally {
      setSaving(false);
    }
  }

  if (notFound) {
    return (
      <div className="px-4 py-8 sm:px-8 sm:py-10">
        <p className="text-sm text-muted-foreground">Organization not found, or you don't have access.</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate("/dashboard")}>Back to dashboard</Button>
      </div>
    );
  }

  return (
    <div className="px-4 py-8 sm:px-8 sm:py-10">
      <button
        onClick={() => navigate("/dashboard")}
        className="mb-6 flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> All sites
      </button>

      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{org?.name ?? "…"}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Sites in this organization{org && <> · <span className="capitalize">{org.role}</span></>}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canManage && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(`/orgs/${orgId}/settings`)}>
              <Settings className="h-4 w-4" /> Settings
            </Button>
          )}
          {canManage && (
            <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New site
            </Button>
          )}
        </div>
      </div>

      {sites.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-20 text-center">
          <BookOpen className="mb-3 h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm font-medium">No sites in this organization yet</p>
          {canManage && (
            <p className="mt-1 text-xs text-muted-foreground">
              Create a new site here, or attach an existing one from Settings.
            </p>
          )}
        </div>
      ) : (
        <>
        <h2 className="sr-only">Sites in this organization</h2>
        <div className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map(site => (
            <Card
              key={site.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/projects/${site.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/projects/${site.id}`);
                }
              }}
              className="group flex cursor-pointer flex-col transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <BookOpen className="h-4 w-4 text-primary" />
                  </div>
                  <CardTitle>{site.name}</CardTitle>
                </div>
                <Badge variant="outline" className="shrink-0">
                  {site.doc_count} {site.doc_count === 1 ? "doc" : "docs"}
                </Badge>
              </CardHeader>
              <CardContent className="flex-1">
                {site.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">{site.description}</p>
                )}
              </CardContent>
              <CardFooter className="flex items-center gap-3">
                {site.published_at ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-2 h-9 gap-1.5 px-2 text-xs text-green-600 hover:text-green-500"
                    onClick={(e) => { e.stopPropagation(); navigate(`/s/${site.id}`); }}
                  >
                    <Globe className="h-[18px] w-[18px]" strokeWidth={1.5} /> View public site
                  </Button>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Globe className="h-[18px] w-[18px]" strokeWidth={1.5} /> Private
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1 text-muted-foreground">
                  <Users className="h-[18px] w-[18px]" strokeWidth={1.5} />
                  <span className="text-xs">{site.member_count}</span>
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
        </>
      )}

      <Dialog open={creating} onOpenChange={open => { if (!open) { setCreating(false); setError(null); setName(""); } }}>
        <DialogContent className="sm:max-w-md" hideClose>
          <DialogHeader className="pb-2">
            <DialogTitle>New site in {org?.name}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateSite} className="flex flex-col gap-5 py-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="org-site-name">Name</Label>
              <Input
                id="org-site-name"
                placeholder="My Docs"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter className="pt-2">
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={saving}>Cancel</Button>
              </DialogClose>
              <Button type="submit" disabled={saving}>{saving ? "Creating…" : "Create site"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
