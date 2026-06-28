import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { SearchPalette } from "@/components/SearchPalette";
import { cn } from "@/lib/utils";
import { Outlet, useMatch, useNavigate, useLocation, NavLink } from "react-router-dom";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { clearToken, getToken } from "@/lib/auth";
import { isDemoMode, exitDemoMode } from "@/lib/demo";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { type FontChoice, DEFAULT_READING_FONT, DEFAULT_EDITING_FONT, DEFAULT_UI_FONT, resolveFontChoice, readFontPrefsCookie, writeFontPrefsCookie, applyFontVarsToRoot } from "@/lib/fonts";
import { type ThemeMode, resolveThemeMode, readThemePrefsCookie, writeThemePrefsCookie, applyThemeToRoot } from "@/lib/theme";
import {
  BookOpen,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  FileText,
  SlidersHorizontal,
  Check,
  Network,
  Search,
  Image,
  Music,
  FileCode,
  FileArchive,
  File,
  Plus,
  Upload,
  Building2,
  Menu,
} from "lucide-react";
import { readRecentItems, onRecentItemsUpdated, type RecentItem } from "@/lib/recentDocs";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { UserAvatar } from "@/components/UserAvatar";
import { UserProfileCard } from "@/components/UserProfileCard";
import { ProjectSquareLogo } from "@/components/ProjectSquareLogo";

interface Project {
  id: string;
  name: string;
  role: string;
  published_at: string | null;
  changelog_mode: string;
  ai_enabled: number;
  ai_summarization_type: string;
  graph_enabled: number;
  is_favourite: number;
  is_hidden: number;
  features: number;
  logo_square_updated_at: string | null;
}

// Orgs the current user can create a site under (admin+ only - the API gates
// site creation in an org at admin rank). Used to populate the New Site picker.
interface CreatableOrg {
  id: string;
  name: string;
  role: string;
}

interface Doc {
  id: string;
  title: string;
  display_title?: string | null;
  folder_id?: string | null;
  tags?: string | null;
}

interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
}

type Section = { id: "documents" | "graph"; label: string; icon: typeof FileText };

const DOCUMENTS_SECTION: Section = { id: "documents", label: "Documents", icon: FileText };
const GRAPH_SECTION: Section = { id: "graph", label: "Graph", icon: Network };

function RecentItemIcon({ item, className }: { item: RecentItem; className?: string }) {
  if (item.kind === "doc") return <FileText className={className} />;
  const mime = item.mime ?? "";
  if (mime.startsWith("image/")) return <Image className={className} />;
  if (mime.startsWith("audio/")) return <Music className={className} />;
  if (mime === "application/pdf") return <FileText className={className} />;
  if (mime === "application/json" || mime.startsWith("text/")) return <FileCode className={className} />;
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("gzip") || mime.includes("archive")) return <FileArchive className={className} />;
  return <File className={className} />;
}

export interface BreadcrumbItem {
  id: string | null;
  name: string;
  onClick?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  isDropTarget?: boolean;
}

export interface DocsLayoutContext {
  updateDocTitle: (docId: string, title: string) => void;
  projectName: string;
  projectPublishedAt: string | null;
  changelogMode: string;
  myRole: string | null;
  aiEnabled: boolean;
  aiSummarizationType: string;
  projectFeatures: number;
  currentUser: { id: string; name: string; personalPlan: "free" | "ink"; personalPlanStyle: string | null; personalPresenceColor: string | null; personalCritSparkles: boolean; isAdmin: boolean } | null;
  // Lets nested routes (e.g. UserSettingsPage) push Ink cosmetic changes
  // back into the layout so the sidebar avatar updates without a reload.
  updateInkAppearance: (patch: { personalPlanStyle?: string | null; personalPresenceColor?: string | null; personalCritSparkles?: boolean }) => void;
  // Current resolved font choices + a setter so the settings page can apply
  // changes instantly (CSS variables on :root) without waiting for a refetch.
  readingFont: FontChoice;
  editingFont: FontChoice;
  uiFont: FontChoice;
  updateFontAppearance: (patch: { readingFont?: FontChoice; editingFont?: FontChoice; uiFont?: FontChoice }) => void;
  // Site theme (admin-only to change; gated by the custom-theming Flagship flag
  // + currentUser.isAdmin). Setter applies instantly via inline CSS vars on
  // <html> without waiting for a refetch.
  theme: ThemeMode;
  customColor: string | null;
  customThemingEnabled: boolean;
  updateTheme: (patch: { mode?: ThemeMode; customColor?: string | null }) => void;
  docs: { id: string; title: string; display_title?: string | null; folder_id?: string | null; tags?: string | null }[];
  folders: { id: string; name: string; parent_id: string | null }[];
  addDoc: (doc: { id: string; title: string; display_title?: string | null; folder_id?: string | null; tags?: string | null }) => void;
  setBreadcrumbs: Dispatch<SetStateAction<BreadcrumbItem[]>>;
  openCreateSite: () => void;
  openCreateOrg: () => void;
}

const PAGE_SIZE = 10;

function ProjectSwitcher({
  currentProject,
  projects,
  onSelect,
}: {
  currentProject: Project;
  projects: Project[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const filtered = query.trim()
    ? projects.filter(p => p.name.toLowerCase().includes(query.toLowerCase()))
    : projects;
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const visible = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) { setQuery(""); setPage(0); }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button className="flex flex-1 min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent group">
          <span className="flex-1 truncate font-semibold tracking-tight text-sm">{currentProject.name}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-56 p-1">
        <div className="px-1 pb-1">
          <Input
            placeholder="Search sites…"
            aria-label="Search sites"
            value={query}
            onChange={e => { setQuery(e.target.value); setPage(0); }}
            className="h-8 text-base sm:text-xs"
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-0.5">
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No sites found</p>
          ) : visible.map(p => (
            <button
              key={p.id}
              onClick={() => { onSelect(p.id); handleOpenChange(false); }}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-left transition-colors hover:bg-accent",
                p.id === currentProject.id ? "font-medium" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <ProjectSquareLogo projectId={p.id} logoSquareUpdatedAt={p.logo_square_updated_at} className="h-3.5 w-3.5" />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === currentProject.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
        {totalPages > 1 && (
          <div className="mt-1 flex items-center justify-between border-t border-border px-1 pt-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page"
              className="rounded p-2 sm:p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              aria-label="Next page"
              className="rounded p-2 sm:p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function DocsLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);

  useSwipeGesture({
    onSwipeLeft: () => setSidebarOpen(false),
    onSwipeRight: () => setSidebarOpen(true),
  });

  // Escape closes the sidebar when it's open as a mobile overlay (the backdrop
  // is the only other way to dismiss it on mobile). On desktop the sidebar is
  // an in-flow column, so only act below the md breakpoint.
  useEffect(() => {
    if (!sidebarOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && window.innerWidth < 768) {
        setSidebarOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);

  // site creation
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Org placement - "" = personal (no org). Populated lazily when the dialog opens.
  const [siteOrgId, setSiteOrgId] = useState("");
  const [creatableOrgs, setCreatableOrgs] = useState<CreatableOrg[]>([]);
  // Optional branding picked before the site exists; uploaded after creation.
  // Square arrives pre-cropped to a 512×512 WebP blob from AvatarCropDialog.
  const [squareBlob, setSquareBlob] = useState<Blob | null>(null);
  const [squarePreviewUrl, setSquarePreviewUrl] = useState<string | null>(null);
  const [wideFile, setWideFile] = useState<File | null>(null);
  const [widePreviewUrl, setWidePreviewUrl] = useState<string | null>(null);
  const [squareCropFile, setSquareCropFile] = useState<File | null>(null);
  const squareInputRef = useRef<HTMLInputElement>(null);
  const wideInputRef = useRef<HTMLInputElement>(null);

  // org creation
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgSaving, setOrgSaving] = useState(false);
  // True when the org dialog was opened from the New Site "Owner" picker - on
  // success we return to the still-open site dialog with the new org selected
  // instead of navigating away to the org page.
  const [orgFromSite, setOrgFromSite] = useState(false);

  // doc creation (instant, no form)
  const [creatingDoc, setCreatingDoc] = useState(false);

  // current user
  const [userName, setUserName] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [personalPlan, setPersonalPlan] = useState<"free" | "ink">("free");
  const [personalPlanStyle, setPersonalPlanStyle] = useState<string | null>(null);
  const [personalPresenceColor, setPersonalPresenceColor] = useState<string | null>(null);
  const [personalCritSparkles, setPersonalCritSparkles] = useState<boolean>(true);
  // Seed from the cookie (written on every prior change) so we render with the
  // user's choice immediately instead of flashing the default while /api/me is
  // in flight. /api/me overrides if it disagrees - the cookie is best-effort,
  // the server row is authoritative.
  const [readingFont, setReadingFont] = useState<FontChoice>(() => readFontPrefsCookie().readingFont);
  const [editingFont, setEditingFont] = useState<FontChoice>(() => readFontPrefsCookie().editingFont);
  const [uiFont, setUiFont] = useState<FontChoice>(() => readFontPrefsCookie().uiFont);
  const [isAdmin, setIsAdmin] = useState(false);
  const [customThemingEnabled, setCustomThemingEnabled] = useState(false);
  // Same cookie-seed-then-/api/me-override pattern as the fonts above.
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemePrefsCookie().mode);
  const [themeCustomColor, setThemeCustomColor] = useState<string | null>(() => readThemePrefsCookie().customColor);

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!getToken()) {
      navigate("/login", { replace: true, state: { from: location.pathname } });
    }
  }, [navigate, location.pathname]);
  const projectMatch = useMatch("/projects/:projectId/*");
  const projectId = projectMatch?.params.projectId ?? null;
  const currentProject = projectId ? projects.find(p => p.id === projectId) ?? null : null;
  // Hidden sites are kept out of every sidebar list (the inverse of favourites),
  // but the one you're actively viewing stays listed so the switcher can mark it.
  const visibleProjects = projects.filter(p => !p.is_hidden || p.id === projectId);

  // Recently accessed docs/files for the current project. Re-read on route
  // change AND when DocPage / FilePage push a new entry - pushes happen
  // after the fetch resolves, so they land later than the pathname change.
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  useEffect(() => {
    setRecentItems(projectId ? readRecentItems(projectId) : []);
  }, [projectId, location.pathname]);
  useEffect(() => {
    if (!projectId) return;
    return onRecentItemsUpdated(updatedProjectId => {
      if (updatedProjectId === projectId) setRecentItems(readRecentItems(projectId));
    });
  }, [projectId]);

  // full-text search palette
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => { if (projectId) setSearchOpen(true); }, [projectId]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch]);

  useEffect(() => {
    if (!getToken()) return;
    apiFetchJson<{ name: string; userId: string; personalPlan: "free" | "ink"; personalPlanStyle: string | null; personalPresenceColor: string | null; personalCritSparkles: boolean; readingFont: string | null; editingFont: string | null; uiFont: string | null; isAdmin: boolean; themeMode: string | null; themeCustomColor: string | null; customThemingEnabled: boolean }>("/api/me")
      .then(result => {
        if (result.ok && result.data) {
          setUserName(result.data.name);
          setUserId(result.data.userId);
          setPersonalPlan(result.data.personalPlan ?? "free");
          setPersonalPlanStyle(result.data.personalPlanStyle ?? null);
          setPersonalPresenceColor(result.data.personalPresenceColor ?? null);
          setPersonalCritSparkles(result.data.personalCritSparkles ?? true);
          setReadingFont(resolveFontChoice(result.data.readingFont, DEFAULT_READING_FONT));
          setEditingFont(resolveFontChoice(result.data.editingFont, DEFAULT_EDITING_FONT));
          setUiFont(resolveFontChoice(result.data.uiFont, DEFAULT_UI_FONT));
          setIsAdmin(result.data.isAdmin ?? false);
          setCustomThemingEnabled(result.data.customThemingEnabled ?? false);
          setThemeMode(resolveThemeMode(result.data.themeMode));
          setThemeCustomColor(result.data.themeCustomColor ?? null);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync the resolved font stacks to CSS variables on :root and persist the
  // pair in a cookie so unauthenticated/published-doc pages can apply the
  // user's choice without an /api/me round-trip. wysiwyg/styles.css reads
  // --reading-font on .cm-wysiwyg--reading .cm-content and --editing-font on
  // the not-reading variant. No cleanup that removes the vars - we want them
  // to persist across route changes (PublicDocPage doesn't re-set them).
  useEffect(() => {
    const prefs = { readingFont, editingFont, uiFont };
    applyFontVarsToRoot(prefs);
    writeFontPrefsCookie(prefs);
  }, [readingFont, editingFont, uiFont]);

  // Same pattern for the theme: sync the .dark class + inline CSS vars and
  // persist the cookie so the next pre-/api/me boot applies it without a flash.
  useEffect(() => {
    const prefs = { mode: themeMode, customColor: themeCustomColor };
    applyThemeToRoot(prefs);
    writeThemePrefsCookie(prefs);
  }, [themeMode, themeCustomColor]);

  useEffect(() => {
    if (!getToken()) return;
    apiFetchJson<Project[]>("/api/projects")
      .then(result => {
        // 401/403 redirects to /login are handled inside apiFetch; the page is
        // unloading by the time we get here, so just ignore those statuses.
        if (result.ok && result.data) setProjects([...result.data].sort((a, b) => b.is_favourite - a.is_favourite));
      })
      .catch(() => {});
  }, [navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectId) { setDocs([]); setFolders([]); return; }
    if (!getToken()) return;
    apiFetchJson<Doc[]>(`/api/docs?projectId=${projectId}`)
      .then(result => {
        // apiFetch already triggered window.location.replace - don't fight it
        // by also calling React Router navigate.
        if (result.redirected) return;
        if (result.status === 403 || result.status === 404) {
          navigate("/dashboard", { replace: true });
          return;
        }
        if (result.ok && result.data) setDocs(result.data);
      })
      .catch(() => {});
    apiFetchJson<Folder[]>(`/api/folders?projectId=${projectId}&all=1`)
      .then(result => { if (result.ok && result.data) setFolders(result.data); })
      .catch(() => {});
  }, [navigate, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazily load the orgs the user can place a new site under, the first time
  // the dialog opens. The API only lets admin+ create sites in an org, so we
  // filter to that here and skip the picker entirely when there are none.
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  useEffect(() => {
    if (!creating || orgsLoaded) return;
    setOrgsLoaded(true);
    apiFetchJson<CreatableOrg[]>("/api/organizations")
      .then(result => {
        if (result.ok && result.data) {
          setCreatableOrgs(result.data.filter(o => o.role === "owner" || o.role === "admin"));
        }
      })
      .catch(() => {});
  }, [creating, orgsLoaded]);

  function resetCreateForm() {
    setCreating(false);
    setError(null);
    setName("");
    setDescription("");
    setSiteOrgId("");
    setSquareBlob(null);
    setWideFile(null);
    setSquareCropFile(null);
    setSquarePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setWidePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
  }

  // Picked-file validation shared by both variants - mirrors the server's allow-list.
  function validateLogoFile(file: File): string | null {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(file.type)) return "Invalid file type. Allowed: JPEG, PNG, WebP, GIF.";
    if (file.size > 2 * 1024 * 1024) return "File too large. Maximum size is 2MB.";
    return null;
  }

  // Upload one branding variant to a freshly-created site. Returns the updated
  // project row (so the caller can pick up logo_*_updated_at) or null on failure.
  async function uploadSiteLogo(id: string, variant: "square" | "wide", file: File | Blob, filename: string): Promise<Partial<Project> | null> {
    try {
      const form = new FormData();
      // NB: `File` is shadowed by the lucide-react icon import above, so reach
      // the DOM constructor via globalThis.
      form.append("file", file instanceof globalThis.File ? file : new globalThis.File([file], filename, { type: file.type || "image/webp" }));
      const res = await apiFetch(`/api/projects/${id}/logo/${variant}`, { method: "POST", body: form });
      if (!res.ok) return null;
      const json = await res.json() as { ok: boolean; data?: Partial<Project> };
      return json.ok ? json.data ?? null : null;
    } catch {
      return null;
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetchJson<Project>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || undefined, organizationId: siteOrgId || undefined }),
      });
      if (!result.ok || !result.data) {
        setError(result.error ?? "Failed to create site.");
        return;
      }
      // Site exists now - upload any optional branding to its id, then merge the
      // returned logo timestamps so the sidebar icon shows up immediately.
      const newId = result.data.id;
      let created: Project = result.data;
      if (squareBlob) {
        const updated = await uploadSiteLogo(newId, "square", squareBlob, "logo-square.webp");
        if (updated) created = { ...created, ...updated };
      }
      if (wideFile) {
        const updated = await uploadSiteLogo(newId, "wide", wideFile, wideFile.name);
        if (updated) created = { ...created, ...updated };
      }
      setProjects(prev => [created, ...prev]);
      resetCreateForm();
      navigate(`/projects/${newId}`);
    } catch {
      setError("Could not connect to the server.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    setOrgSaving(true);
    setOrgError(null);
    try {
      const result = await apiFetchJson<{ id: string }>("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: orgName }),
      });
      if (result.ok && result.data) {
        const newOrg = { id: result.data.id, name: orgName, role: "owner" };
        setCreatingOrg(false);
        setOrgName("");
        if (orgFromSite) {
          // Came from the New Site picker - keep that dialog open, add the org
          // to the list and select it, rather than navigating to the org page.
          setOrgFromSite(false);
          setCreatableOrgs(prev => [...prev, newOrg]);
          setSiteOrgId(newOrg.id);
        } else {
          navigate(`/orgs/${newOrg.id}`);
        }
      } else {
        setOrgError(result.error ?? "Failed to create organization.");
      }
    } catch {
      setOrgError("Could not connect to the server.");
    } finally {
      setOrgSaving(false);
    }
  }

  async function handleNewDoc() {
    if (!projectId || creatingDoc) return;
    setCreatingDoc(true);
    try {
      const result = await apiFetchJson<Doc & { id: string }>("/api/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled", content: "", projectId }),
      });
      if (result.ok && result.data) {
        setDocs(prev => [...prev, result.data!]);
        navigate(`/projects/${projectId}/docs/${result.data.id}`, { state: { isNew: true } });
      }
    } catch {
      // fail silently - user can retry
    } finally {
      setCreatingDoc(false);
    }
  }

  function updateDocTitle(docId: string, title: string) {
    setDocs(prev => prev.map(d => d.id === docId ? { ...d, title } : d));
  }

  function addDoc(doc: { id: string; title: string; folder_id?: string | null }) {
    setDocs(prev => prev.some(d => d.id === doc.id) ? prev : [...prev, doc]);
  }

  const outletContext: DocsLayoutContext = {
    updateDocTitle,
    projectName: currentProject?.name ?? "",
    projectPublishedAt: currentProject?.published_at ?? null,
    changelogMode: currentProject?.changelog_mode ?? "off",
    myRole: currentProject?.role ?? null,
    aiEnabled: !!(currentProject?.ai_enabled),
    aiSummarizationType: currentProject?.ai_summarization_type ?? "manual",
    projectFeatures: currentProject?.features ?? 0,
    currentUser: userId && userName ? { id: userId, name: userName, personalPlan, personalPlanStyle, personalPresenceColor, personalCritSparkles, isAdmin } : null,
    updateInkAppearance: (patch) => {
      if ("personalPlanStyle" in patch) setPersonalPlanStyle(patch.personalPlanStyle ?? null);
      if ("personalPresenceColor" in patch) setPersonalPresenceColor(patch.personalPresenceColor ?? null);
      if ("personalCritSparkles" in patch && patch.personalCritSparkles !== undefined) setPersonalCritSparkles(patch.personalCritSparkles);
    },
    readingFont,
    editingFont,
    uiFont,
    updateFontAppearance: (patch) => {
      if (patch.readingFont) setReadingFont(patch.readingFont);
      if (patch.editingFont) setEditingFont(patch.editingFont);
      if (patch.uiFont) setUiFont(patch.uiFont);
    },
    theme: themeMode,
    customColor: themeCustomColor,
    customThemingEnabled,
    updateTheme: (patch) => {
      if (patch.mode !== undefined) setThemeMode(patch.mode);
      if (patch.customColor !== undefined) setThemeCustomColor(patch.customColor);
    },
    docs,
    folders,
    addDoc,
    setBreadcrumbs,
    openCreateSite: () => setCreating(true),
    openCreateOrg: () => setCreatingOrg(true),
  };

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {isDemoMode() && (
        <div className="z-30 flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-center text-xs font-medium text-amber-600 dark:text-amber-400 sm:text-sm">
          <span>This is a demo environment, any changes you make here are local, and will not be saved.</span>
          <button
            type="button"
            onClick={() => {
              exitDemoMode();
              // Full reload so the demo fetch patch and in-memory data are dropped.
              window.location.replace("/");
            }}
            className="shrink-0 rounded-md border border-amber-500/40 px-2 py-0.5 text-xs transition-colors hover:bg-amber-500/20"
          >
            Exit demo
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      {/* Backdrop - mobile only: closes sidebar when tapping the content area */}
      {sidebarOpen && (
        <div
          className="absolute inset-0 z-10 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={cn(
        "z-20 flex flex-col shrink-0 border-r border-border bg-background w-64",
        // Mobile: fixed overlay that slides in over the content (doesn't push it wider).
        "fixed inset-y-0 left-0 transition-transform duration-200",
        sidebarOpen ? "translate-x-0" : "-translate-x-full",
        // Desktop: static-flow column (relative, so it keeps its place in the row
        // and anchors the toggle button) whose width collapses instead of translating.
        "md:relative md:inset-auto md:translate-x-0 md:transition-[width] md:duration-200",
        sidebarOpen ? "md:w-64" : "md:w-0 md:border-r-0",
      )}>
        {/* Inner wrapper - clips content on desktop when collapsed; toggle button lives outside so it stays visible */}
        <div className={cn("flex flex-col flex-1 min-h-0 w-64 overflow-hidden transition-[width] duration-200", !sidebarOpen && "md:w-0")}>
        {/* Logo / Site header */}
        <div className="flex h-14 items-center gap-2 px-4 border-b border-border">
          {projectId && currentProject ? (
            <>
              <button
                onClick={() => navigate("/dashboard")}
                className="shrink-0 rounded-md p-2 sm:p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="All sites"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <ProjectSwitcher
                currentProject={currentProject}
                projects={visibleProjects}
                onSelect={id => navigate(`/projects/${id}`)}
              />
              <NavLink
                to={`/projects/${projectId}/settings`}
                className={({ isActive }) =>
                  `shrink-0 rounded-md p-2 sm:p-1 transition-colors hover:bg-accent hover:text-foreground ${
                    isActive ? "bg-accent text-foreground" : "text-muted-foreground"
                  }`
                }
                title="Site Settings"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </NavLink>
            </>
          ) : (
            <button
              onClick={() => navigate("/dashboard")}
              className="flex items-center cursor-pointer"
              aria-label="Go to dashboard"
            >
              {/* Wordmark artwork is black. dark:invert flips it white only
                  when the effective theme is dark - .dark now tracks the true
                  polarity, incl. custom-dark (see applyThemeToRoot). */}
              <img src="/annexwordmark.svg" alt="Annex" className="h-5 w-auto dark:invert" />
            </button>
          )}
        </div>

        {projectId ? (
          /* ── Project sidebar ── */
          <ScrollArea className="flex-1 px-2 py-3 app-sidebar-scroller">
            {/* Sections */}
            <nav className="flex flex-col gap-1">
              <button
                onClick={openSearch}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "w-full justify-between text-muted-foreground")}
              >
                <span className="flex items-center gap-1.5">
                  <Search className="h-3.5 w-3.5 shrink-0" />
                  Search
                </span>
                <Kbd className="hidden sm:inline-flex">
                  {/Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K"}
                </Kbd>
              </button>
              <div className="flex items-center mb-1">
                <NavLink
                  to={`/projects/${projectId}`}
                  end
                  className={({ isActive }) =>
                    cn(buttonVariants({ variant: "ghost", size: "sm" }), "flex-1 justify-start", isActive ? "bg-accent text-foreground" : "text-muted-foreground")
                  }
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  File Manager
                </NavLink>
                {currentProject?.graph_enabled ? (
                  <NavLink
                    to={`/projects/${projectId}/graph`}
                    className={({ isActive }) =>
                      cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0 px-2", isActive ? "bg-accent text-foreground" : "text-muted-foreground")
                    }
                    title="Graph"
                  >
                    <Network className="h-3.5 w-3.5" />
                  </NavLink>
                ) : null}
              </div>
            </nav>

            {recentItems.length > 0 && (
              <div className="mt-4">
                <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Recently accessed
                </p>
                <nav className="flex flex-col gap-0.5">
                  {recentItems.map(item => (
                    <NavLink
                      key={`${item.kind}:${item.id}`}
                      to={item.kind === "doc"
                        ? `/projects/${projectId}/docs/${item.id}`
                        : `/projects/${projectId}/files/${item.id}`}
                      className={({ isActive }) =>
                        cn(buttonVariants({ variant: "ghost", size: "sm" }), "w-full justify-start", isActive ? "bg-accent text-foreground" : "text-muted-foreground")
                      }
                      title={item.title}
                    >
                      <RecentItemIcon item={item} className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{item.title}</span>
                    </NavLink>
                  ))}
                </nav>
              </div>
            )}
          </ScrollArea>
        ) : (
          /* ── Overview sidebar ── */
          <ScrollArea className="flex-1 px-2 py-3 app-sidebar-scroller">
            <nav className="flex flex-col gap-1">
              {visibleProjects.map(p => (
                <Button
                  key={p.id}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={() => navigate(`/projects/${p.id}`)}
                >
                  <ProjectSquareLogo projectId={p.id} logoSquareUpdatedAt={p.logo_square_updated_at} className="h-4 w-4" />
                  {p.name}
                </Button>
              ))}
            </nav>
          </ScrollArea>
        )}

        <Separator />

        {/* Footer */}
        <div className="p-2">
          <div className="flex items-center gap-2 px-2 py-1.5">
            {userId && userName ? (
              <UserProfileCard userId={userId} name={userName}>
                <button
                  type="button"
                  aria-label="Open profile"
                  title={userName}
                  className="flex flex-1 min-w-0 items-center gap-2 rounded-md -mx-1 px-1 py-1 ring-offset-background transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <UserAvatar userId={userId} name={userName} className="size-7 shrink-0 text-xs" personalPlan={personalPlan} personalPlanStyle={personalPlanStyle} />
                  <span className="flex-1 truncate text-left text-sm font-medium">
                    {userName}
                  </span>
                </button>
              </UserProfileCard>
            ) : (
              <>
                <div className="size-7 shrink-0 rounded-full bg-muted" />
                <span className="flex-1 truncate text-sm font-medium">-</span>
              </>
            )}
            <Badge variant="secondary" className={cn("shrink-0 text-[10px] capitalize", !currentProject && "hidden")}>
              {currentProject?.role ?? "owner"}
            </Badge>
            <button
              onClick={() => navigate("/settings")}
              title="Settings"
              aria-label="Settings"
              className="flex items-center justify-center shrink-0 rounded-md p-2.5 sm:p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              onClick={async () => {
                // Best-effort: revoke the server-side session so the JWT is dead
                // even if it gets exfiltrated from localStorage post-logout. We
                // proceed with the local clear regardless of the network result.
                if (getToken()) {
                  try {
                    await apiFetch("/api/me/sessions/logout", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                    });
                  } catch { /* ignore */ }
                }
                clearToken();
                navigate("/login");
              }}
              title="Sign out"
              aria-label="Sign out"
              className="flex items-center justify-center shrink-0 rounded-md p-2.5 sm:p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        </div>
        <button
          onClick={() => setSidebarOpen(v => !v)}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          className="absolute top-1/2 -translate-y-1/2 -right-3 z-10 hidden md:flex h-10 w-3 items-center justify-center rounded-r-full border border-l-0 border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors before:absolute before:inset-y-0 before:-right-3 before:left-0 before:content-['']"
        >
          <ChevronLeft className={cn("h-2.5 w-2.5 transition-transform duration-200", !sidebarOpen && "rotate-180")} />
        </button>
      </aside>

      {/* Main content - full-width and static; the sidebar overlays it on mobile */}
      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        {/* Top bar: holds the mobile menu opener and the breadcrumbs. Rendered on
            mobile whenever the sidebar is closed (so the opener sits in the bar
            instead of floating over content); on desktop only when there are
            crumbs. The opener itself is md:hidden. */}
        {(breadcrumbs.length > 0 || !sidebarOpen) && (
          <div className={cn(
            "shrink-0 flex h-14 items-center gap-1 overflow-x-auto whitespace-nowrap px-2 sm:px-6 border-b border-border bg-background text-sm [-ms-overflow-style:none] [scrollbar-width:none]",
            breadcrumbs.length === 0 && "md:hidden",
          )}>
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation menu"
                className="md:hidden shrink-0 mr-1 flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Menu className="h-5 w-5" />
              </button>
            )}
            <nav aria-label="Breadcrumb" className="flex items-center">
              <ol className="flex items-center gap-1">
                {breadcrumbs.map((crumb, i) => {
                  const isLast = i === breadcrumbs.length - 1;
                  const clickable = !isLast && !!crumb.onClick;
                  return (
                    <li key={i} className="flex items-center gap-1 shrink-0">
                      {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" aria-hidden="true" />}
                      {clickable ? (
                        <button
                          type="button"
                          title={crumb.name}
                          onClick={crumb.onClick}
                          onDragOver={crumb.onDragOver}
                          onDragLeave={crumb.onDragLeave}
                          onDrop={crumb.onDrop}
                          className={`max-w-[55vw] sm:max-w-none truncate px-1.5 py-0.5 rounded transition-colors text-muted-foreground cursor-pointer hover:text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${crumb.isDropTarget ? "bg-primary/15 text-primary ring-1 ring-primary/40" : ""}`}
                        >
                          {crumb.name}
                        </button>
                      ) : (
                        <span
                          title={crumb.name}
                          aria-current={isLast ? "page" : undefined}
                          className={`max-w-[55vw] sm:max-w-none truncate px-1.5 py-0.5 rounded transition-colors ${
                            isLast ? "text-foreground font-medium" : "text-muted-foreground"
                          } ${crumb.isDropTarget ? "bg-primary/15 text-primary ring-1 ring-primary/40" : ""}`}
                          onDragOver={crumb.onDragOver}
                          onDragLeave={crumb.onDragLeave}
                          onDrop={crumb.onDrop}
                        >
                          {crumb.name}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
          </div>
        )}
        <div className="flex-1 overflow-y-auto overscroll-contain min-h-0">
          <Outlet context={outletContext} />
        </div>
      </main>
      </div>
      {projectId && (
        <SearchPalette
          open={searchOpen}
          onOpenChange={setSearchOpen}
          projectId={projectId}
        />
      )}
      <Dialog open={creating} onOpenChange={open => { if (!open) resetCreateForm(); }}>
        <DialogContent className="sm:max-w-lg" hideClose>
          <DialogHeader>
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <BookOpen className="size-5" />
              </span>
              <div className="flex flex-col gap-0.5">
                <DialogTitle>Create a new site</DialogTitle>
                <DialogDescription>You can change any of this later in Site Settings.</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <form onSubmit={handleCreate} className="flex flex-col gap-5 py-1">
            <div className="flex flex-col gap-2">
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                placeholder="My Docs"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="site-description">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                id="site-description"
                placeholder="A short description of this site…"
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
                className="resize-none"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="site-org">Owner</Label>
              <Select
                value={siteOrgId || "personal"}
                onValueChange={v => {
                  if (v === "__new_org__") { setOrgFromSite(true); setCreatingOrg(true); return; }
                  setSiteOrgId(v === "personal" ? "" : v);
                }}
              >
                <SelectTrigger id="site-org">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">
                    <span className="flex items-center gap-2"><BookOpen className="size-3.5 text-muted-foreground" /> Personal</span>
                  </SelectItem>
                  {creatableOrgs.map(org => (
                    <SelectItem key={org.id} value={org.id}>
                      <span className="flex items-center gap-2"><Building2 className="size-3.5 text-muted-foreground" /> {org.name}</span>
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value="__new_org__" className="text-primary focus:text-primary">
                    <span className="flex items-center gap-2"><Plus className="size-3.5" /> New org</span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {siteOrgId ? "Org members inherit access to this site." : "A personal site you own directly."}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Branding <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <div className="flex flex-col gap-3 rounded-md border border-border px-4 py-3 sm:flex-row sm:items-start">
                {/* Square icon - cropped to 512×512 via AvatarCropDialog. */}
                <div className="flex flex-1 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => squareInputRef.current?.click()}
                    aria-label="Upload square icon"
                    className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 transition-colors hover:border-primary/50"
                  >
                    {squarePreviewUrl
                      ? <img src={squarePreviewUrl} alt="" className="size-full object-cover" />
                      : <Image className="size-5 text-muted-foreground" />}
                  </button>
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-sm font-medium">Square icon</p>
                    <button type="button" className="self-start text-xs text-primary hover:underline" onClick={() => squareInputRef.current?.click()}>
                      {squareBlob ? "Change" : "Upload"}
                    </button>
                    <p className="text-xs text-muted-foreground">Sidebar &amp; favourites.</p>
                  </div>
                  <input
                    ref={squareInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const err = validateLogoFile(file);
                      if (err) { setError(err); return; }
                      setError(null);
                      setSquareCropFile(file);
                    }}
                  />
                </div>
                {/* Wide wordmark - native aspect, no crop. */}
                <div className="flex flex-1 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => wideInputRef.current?.click()}
                    aria-label="Upload wordmark"
                    className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 transition-colors hover:border-primary/50"
                  >
                    {widePreviewUrl
                      ? <img src={widePreviewUrl} alt="" className="max-h-full max-w-full object-contain" />
                      : <Image className="size-5 text-muted-foreground" />}
                  </button>
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-sm font-medium">Wordmark</p>
                    <button type="button" className="self-start text-xs text-primary hover:underline" onClick={() => wideInputRef.current?.click()}>
                      {wideFile ? "Change" : "Upload"}
                    </button>
                    <p className="text-xs text-muted-foreground">Published header.</p>
                  </div>
                  <input
                    ref={wideInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const err = validateLogoFile(file);
                      if (err) { setError(err); return; }
                      setError(null);
                      setWideFile(file);
                      setWidePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
                      if (wideInputRef.current) wideInputRef.current.value = "";
                    }}
                  />
                </div>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter className="pt-1">
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={saving}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={saving} className="gap-1.5">
                <Plus className="size-4" />
                {saving ? "Creating…" : "Create site"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {squareCropFile && (
        <AvatarCropDialog
          file={squareCropFile}
          shape="square"
          onClose={() => { setSquareCropFile(null); if (squareInputRef.current) squareInputRef.current.value = ""; }}
          onApply={async blob => {
            setSquareBlob(blob);
            setSquarePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
            setSquareCropFile(null);
            if (squareInputRef.current) squareInputRef.current.value = "";
          }}
        />
      )}
      <Dialog open={creatingOrg} onOpenChange={open => { if (!open) { setCreatingOrg(false); setOrgError(null); setOrgName(""); setOrgFromSite(false); } }}>
        <DialogContent className="sm:max-w-md" hideClose>
          <DialogHeader className="pb-2">
            <DialogTitle>New organization</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateOrg} className="flex flex-col gap-5 py-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                placeholder="My Organization"
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                required
                autoFocus
              />
            </div>
            {orgError && <p className="text-sm text-destructive">{orgError}</p>}
            <DialogFooter className="pt-2">
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={orgSaving}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={orgSaving}>
                {orgSaving ? "Creating…" : "Create organization"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
