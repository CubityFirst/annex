import { useState, useEffect, useRef, type ReactNode } from "react";
import { useOutletContext, Link } from "react-router-dom";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { getToken } from "@/lib/auth";
import { IDENTITY_ACCOUNT_URL, IDENTITY_SECURITY_URL } from "@/lib/signIn";
import { UserAvatar } from "@/components/UserAvatar";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";
import { InlineSaveControls, SavedIndicator, useSavedFlash } from "@/components/InlineSaveControls";
import { InkSparkle } from "@/components/InkSparkle";
import { LockKeyhole, Trash2, Loader2, Copy, AlertCircle, Camera, Upload, Sparkles, ChevronDown, Globe, X, Search, Plus, Sun, Moon, RotateCcw, Check, Star, ExternalLink } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ColorPicker } from "@/components/ui/color-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TIMEZONE_GROUPS, detectTimezoneGroup, getTimezoneGroup, formatTimezoneLabel, formatTimeInZone } from "@/lib/timezone";
import { formatInkSince } from "@/lib/inkDate";
import { INK_PERKS } from "@/lib/inkPerks";
import { FONT_CHOICES, FONT_LABELS, FONT_STACKS, DEFAULT_READING_FONT, DEFAULT_EDITING_FONT, DEFAULT_UI_FONT, type FontChoice } from "@/lib/fonts";
import { type ThemeMode, DEFAULT_CUSTOM_COLOR } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { normalizeHandle, handleProblem, HANDLE_MAX_LENGTH, HANDLE_PROBLEM_MESSAGES, type HandleProblem } from "@/lib/handle";
import {
  DESTRUCTIVE_OUTLINE_BUTTON,
  DangerRow,
  SETTINGS_ROW_CARD,
  SettingsEmptyRow,
  SettingsEmptyState,
  SettingsSectionHeader,
  SettingsShell,
  type SettingsGroupDef,
  type SettingsSectionDef,
} from "@/components/settings/SettingsShell";
import { getAvatarVariant, type AvatarVariant } from "@/lib/avatarVariant";
import { toast as sonnerToast } from "sonner";

// Mirrors INK_RING_STYLES in packages/api/src/account/plan.ts. Order is the
// display order in the picker. 'shimmer' is the default - selecting it
// stores NULL on the row.
const INK_RING_STYLE_OPTIONS: { id: "shimmer" | "aurora" | "ember" | "mono" | "none"; label: string }[] = [
  { id: "shimmer", label: "Shimmer" },
  { id: "aurora", label: "Aurora" },
  { id: "ember", label: "Ember" },
  { id: "mono", label: "Mono" },
  { id: "none", label: "None" },
];

// Grouped outline for the settings nav. Section→group membership lives
// in the per-render `settingsSections` array (its visibility depends on
// currentUser). Order here is the outline order and matches DOM order.
// Danger zone is an all-danger group, so SettingsShell sets it apart after a
// divider with no eyebrow.
const USER_SETTINGS_GROUPS: SettingsGroupDef[] = [
  { id: "profile", label: "Profile" },
  { id: "plan", label: "Plan" },
  { id: "preferences", label: "Preferences" },
  { id: "security", label: "Security" },
  { id: "danger", label: "Danger zone" },
];

// Header row of a security row card: title + status pill + description on the
// left, the outline action(s) right-aligned (stacked below on narrow screens),
// matching the Account/Danger zone row geometry.
function SecurityRowHeader({ title, status, description, action }: { title: string; status?: ReactNode; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {status}
        </div>
        <p className="text-[13px] leading-snug text-muted-foreground">{description}</p>
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export function UserSettingsPage() {
  const { updateInkAppearance, readingFont, editingFont, uiFont, updateFontAppearance, currentUser, theme, customColor, customThemingEnabled, updateTheme } = useOutletContext<DocsLayoutContext>();
  const [fontPrefsBusy, setFontPrefsBusy] = useState(false);
  const [themePrefsBusy, setThemePrefsBusy] = useState(false);
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // The identity service's account pages (from GET /me; build-time defaults
  // until it loads).
  const [accountUrl, setAccountUrl] = useState(IDENTITY_ACCOUNT_URL);
  const [securityUrl, setSecurityUrl] = useState(IDENTITY_SECURITY_URL);
  const identityHost = new URL(accountUrl).host;

  const [timezone, setTimezone] = useState<string | null>(null);
  const [timezonePrivate, setTimezonePrivate] = useState(false);
  const [timezoneSaving, setTimezoneSaving] = useState(false);
  const [timezoneSaved, flashTimezoneSaved] = useSavedFlash();
  const [bioSaved, flashBioSaved] = useSavedFlash();

  const [avatarKey, setAvatarKey] = useState(0);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPopoverOpen, setAvatarPopoverOpen] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  // Which avatar slot the toggle is viewing/editing (app-wide, per-browser).
  // Which avatar slot the upload/remove controls target. Display elsewhere
  // follows the theme automatically (useAvatarVariant); this is page-local so
  // the user can edit the opposite variant without changing their theme.
  const [avatarVariant, setAvatarVariant] = useState<AvatarVariant>(getAvatarVariant);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const changePhotoButtonRef = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();

  // Annex Ink billing state. personalPlanStatus === "granted" means a comp
  // grant (no Stripe linkage); we hide the Manage button in that case.
  // personalPlanCancelAt is non-null when the user has scheduled a
  // cancel-at-period-end via Customer Portal - UI shows the expiry date.
  const [personalPlan, setPersonalPlan] = useState<"free" | "ink">("free");
  const [personalPlanSince, setPersonalPlanSince] = useState<number | null>(null);
  const [personalPlanStatus, setPersonalPlanStatus] = useState<string | null>(null);
  const [personalPlanCancelAt, setPersonalPlanCancelAt] = useState<number | null>(null);
  const [personalPlanStyle, setPersonalPlanStyle] = useState<string | null>(null);
  const [personalPresenceColor, setPersonalPresenceColor] = useState<string | null>(null);
  const [personalCritSparkles, setPersonalCritSparkles] = useState<boolean>(true);
  const [inkPrefsBusy, setInkPrefsBusy] = useState(false);
  const [cosmeticsOpen, setCosmeticsOpen] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);

  // Supporter bio. `currentBio` is what's saved on the server; `bio` is the
  // textarea draft. Diff drives the InlineSaveControls visibility.
  const [bio, setBio] = useState("");
  const [currentBio, setCurrentBio] = useState("");
  const [bioSaving, setBioSaving] = useState(false);
  const BIO_MAX = 280;

  // Opt-in `/@handle` profile link. Off = no handle saved (null). The switch
  // can be flipped on locally before a handle is saved; turning it off with a
  // saved handle releases the name (after a confirm).
  const [handle, setHandle] = useState("");
  const [currentHandle, setCurrentHandle] = useState<string | null>(null);
  const [handleEnabled, setHandleEnabled] = useState(false);
  const [handleSaving, setHandleSaving] = useState(false);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleDisableConfirmOpen, setHandleDisableConfirmOpen] = useState(false);
  // Admin lock (admin worker PATCH /api/users/:id/handle): read-only here.
  const [handleLocked, setHandleLocked] = useState(false);

  // Favourite published sites for the profile card.
  const [favouriteSites, setFavouriteSites] = useState<Array<{ id: string; name: string; vanitySlug: string | null; logoSquareUpdatedAt: string | null; note: string | null }>>([]);
  const [favouritesLoading, setFavouritesLoading] = useState(true);
  const [favouriteRemovingId, setFavouriteRemovingId] = useState<string | null>(null);
  const [favouriteSearch, setFavouriteSearch] = useState("");
  const [favouriteSearchResults, setFavouriteSearchResults] = useState<Array<{ id: string; name: string; vanitySlug: string | null; logoSquareUpdatedAt: string | null }>>([]);
  const [favouriteSearchLoading, setFavouriteSearchLoading] = useState(false);
  const [favouriteAddingId, setFavouriteAddingId] = useState<string | null>(null);
  // Draft notes keyed by project id - separate from server state so we can
  // show a save/reset affordance only while the draft differs.
  const [favouriteNoteDrafts, setFavouriteNoteDrafts] = useState<Record<string, string>>({});
  const [favouriteNoteSavingId, setFavouriteNoteSavingId] = useState<string | null>(null);
  const [favouriteNoteExpanded, setFavouriteNoteExpanded] = useState<Record<string, boolean>>({});
  const FAV_NOTE_MAX = 140;

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json() as Promise<{ ok: boolean; data?: { name: string; email: string; accountUrl?: string; securityUrl?: string; userId: string; timezone: string | null; bio: string | null; handle?: string | null; handleLocked?: boolean; personalPlan: "free" | "ink"; personalPlanSince: number | null; personalPlanStatus: string | null; personalPlanCancelAt: number | null; personalPlanStyle: string | null; personalPresenceColor: string | null; personalCritSparkles: boolean } }>)
      .then(json => {
        if (json.ok && json.data) {
          setName(json.data.name);
          setEmail(json.data.email);
          if (json.data.accountUrl) setAccountUrl(json.data.accountUrl);
          if (json.data.securityUrl) setSecurityUrl(json.data.securityUrl);
          setUserId(json.data.userId);
          setTimezone(json.data.timezone);
          setTimezonePrivate(json.data.timezone === null);
          setBio(json.data.bio ?? "");
          setCurrentBio(json.data.bio ?? "");
          setCurrentHandle(json.data.handle ?? null);
          setHandle(json.data.handle ?? "");
          setHandleEnabled(!!json.data.handle);
          setHandleLocked(!!json.data.handleLocked);
          setPersonalPlan(json.data.personalPlan);
          setPersonalPlanSince(json.data.personalPlanSince);
          setPersonalPlanStatus(json.data.personalPlanStatus);
          setPersonalPlanCancelAt(json.data.personalPlanCancelAt);
          setPersonalPlanStyle(json.data.personalPlanStyle);
          setPersonalPresenceColor(json.data.personalPresenceColor);
          setPersonalCritSparkles(json.data.personalCritSparkles ?? true);
        }
      })
      .catch(() => {});

    fetch("/api/me/favourite-sites", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json() as Promise<{ ok: boolean; data?: Array<{ id: string; name: string; vanitySlug: string | null; logoSquareUpdatedAt: string | null; note: string | null }> }>)
      .then(json => {
        if (json.ok && json.data) {
          setFavouriteSites(json.data);
          setFavouriteNoteDrafts(Object.fromEntries(json.data.map(s => [s.id, s.note ?? ""])));
        }
      })
      .catch(() => {})
      .finally(() => setFavouritesLoading(false));

  }, []);

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarPopoverOpen(false);
    setCropFile(file);
    if (avatarInputRef.current) avatarInputRef.current.value = "";
  }

  async function handleCropApply(blob: Blob) {
    const token = getToken();
    const form = new FormData();
    form.append("file", new File([blob], "avatar.webp", { type: blob.type }));
    const res = await fetch(`/api/avatar?variant=${avatarVariant}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const json = await res.json() as { ok: boolean; error?: string };
    if (json.ok) {
      setAvatarKey(k => k + 1);
      setCropFile(null);
      toast({ title: "Avatar updated" });
    } else {
      toast({ title: json.error ?? "Failed to upload avatar", variant: "destructive" });
    }
  }

  async function handleRemoveAvatar() {
    setAvatarUploading(true);
    try {
      const token = getToken();
      const res = await fetch(`/api/avatar?variant=${avatarVariant}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json() as { ok: boolean; error?: string };
      if (json.ok) {
        setAvatarKey(k => k + 1);
        toast({ title: "Avatar removed" });
      } else {
        toast({ title: json.error ?? "Failed to remove avatar", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server", variant: "destructive" });
    } finally {
      setAvatarUploading(false);
    }
  }

  async function saveTimezone(newTimezone: string | null) {
    setTimezoneSaving(true);
    try {
      const token = getToken();
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ timezone: newTimezone }),
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        flashTimezoneSaved();
      } else {
        toast({ title: "Failed to update timezone", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server", variant: "destructive" });
    } finally {
      setTimezoneSaving(false);
    }
  }

  async function startCheckoutOrPortal(path: "/api/billing/checkout" | "/api/billing/portal") {
    if (billingBusy) return;
    setBillingBusy(true);
    try {
      const token = getToken();
      if (!token) return;
      const res = await fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean; data?: { url: string } };
      if (json.ok && json.data?.url) {
        window.location.href = json.data.url;
        return;
      }
      toast({ title: "Couldn't open billing", description: "Please try again in a moment.", variant: "destructive" });
    } catch {
      toast({ title: "Couldn't open billing", description: "Please try again in a moment.", variant: "destructive" });
    } finally {
      setBillingBusy(false);
    }
  }

  // Persists Ink cosmetic prefs through the api worker, which proxies to
  // the auth worker. Optimistic local state - we mirror the value into
  // the picker before the request returns so the avatar updates instantly,
  // and roll it back on failure.
  async function saveInkPrefs(patch: { style?: string | null; presenceColor?: string | null; critSparkles?: boolean | null }) {
    if (inkPrefsBusy) return;
    setInkPrefsBusy(true);
    const prevStyle = personalPlanStyle;
    const prevColor = personalPresenceColor;
    const prevCritSparkles = personalCritSparkles;
    // Optimistic - update both this page and the layout so the sidebar
    // avatar reflects the change immediately. If the save fails we roll
    // both back together.
    const layoutPatch: { personalPlanStyle?: string | null; personalPresenceColor?: string | null; personalCritSparkles?: boolean } = {};
    if ("style" in patch) {
      setPersonalPlanStyle(patch.style ?? null);
      layoutPatch.personalPlanStyle = patch.style ?? null;
    }
    if ("presenceColor" in patch) {
      setPersonalPresenceColor(patch.presenceColor ?? null);
      layoutPatch.personalPresenceColor = patch.presenceColor ?? null;
    }
    if ("critSparkles" in patch) {
      const next = patch.critSparkles ?? true;
      setPersonalCritSparkles(next);
      layoutPatch.personalCritSparkles = next;
    }
    updateInkAppearance(layoutPatch);
    try {
      const token = getToken();
      if (!token) return;
      const res = await fetch("/api/me/ink-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const rollback: { personalPlanStyle?: string | null; personalPresenceColor?: string | null; personalCritSparkles?: boolean } = {};
        if ("style" in patch) { setPersonalPlanStyle(prevStyle); rollback.personalPlanStyle = prevStyle; }
        if ("presenceColor" in patch) { setPersonalPresenceColor(prevColor); rollback.personalPresenceColor = prevColor; }
        if ("critSparkles" in patch) { setPersonalCritSparkles(prevCritSparkles); rollback.personalCritSparkles = prevCritSparkles; }
        updateInkAppearance(rollback);
        toast({ title: "Couldn't save", description: "Please try again in a moment.", variant: "destructive" });
      }
    } catch {
      const rollback: { personalPlanStyle?: string | null; personalPresenceColor?: string | null; personalCritSparkles?: boolean } = {};
      if ("style" in patch) { setPersonalPlanStyle(prevStyle); rollback.personalPlanStyle = prevStyle; }
      if ("presenceColor" in patch) { setPersonalPresenceColor(prevColor); rollback.personalPresenceColor = prevColor; }
      if ("critSparkles" in patch) { setPersonalCritSparkles(prevCritSparkles); rollback.personalCritSparkles = prevCritSparkles; }
      updateInkAppearance(rollback);
      toast({ title: "Couldn't save", description: "Please try again in a moment.", variant: "destructive" });
    } finally {
      setInkPrefsBusy(false);
    }
  }

  // Persists the user's reading / editing prose-font choice. Optimistic
  // update via DocsLayout's updateFontAppearance - that's the source of
  // truth for the CSS variables, so writing it immediately flips the
  // wysiwyg viewport without waiting for the round-trip. Rolls back the
  // same way on failure.
  async function saveFontPrefs(patch: { readingFont?: FontChoice; editingFont?: FontChoice; uiFont?: FontChoice }) {
    if (fontPrefsBusy) return;
    setFontPrefsBusy(true);
    const prev: { readingFont?: FontChoice; editingFont?: FontChoice; uiFont?: FontChoice } = {};
    if (patch.readingFont) prev.readingFont = readingFont;
    if (patch.editingFont) prev.editingFont = editingFont;
    if (patch.uiFont) prev.uiFont = uiFont;
    updateFontAppearance(patch);
    try {
      const token = getToken();
      if (!token) return;
      const res = await fetch("/api/me/reading-font", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        updateFontAppearance(prev);
        sonnerToast.error("Couldn't save", { description: "Please try again in a moment." });
        return;
      }
      const labels = [
        patch.readingFont && "Reading",
        patch.editingFont && "Editing",
        patch.uiFont && "Other",
      ].filter(Boolean) as string[];
      sonnerToast.success(labels.length === 1 ? `${labels[0]} font updated` : "Fonts updated");
    } catch {
      updateFontAppearance(prev);
      sonnerToast.error("Couldn't save", { description: "Please try again in a moment." });
    } finally {
      setFontPrefsBusy(false);
    }
  }

  // Reset all three tiers to NULL on the row - frontend treats that as the
  // default sans stack. Same optimistic-update pattern as saveFontPrefs.
  async function resetFontPrefs() {
    if (fontPrefsBusy) return;
    setFontPrefsBusy(true);
    const prev = { readingFont, editingFont, uiFont };
    updateFontAppearance({ readingFont: DEFAULT_READING_FONT, editingFont: DEFAULT_EDITING_FONT, uiFont: DEFAULT_UI_FONT });
    try {
      const token = getToken();
      if (!token) return;
      const res = await fetch("/api/me/reading-font", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ readingFont: null, editingFont: null, uiFont: null }),
      });
      if (!res.ok) {
        updateFontAppearance(prev);
        sonnerToast.error("Couldn't reset", { description: "Please try again in a moment." });
        return;
      }
      sonnerToast.success("Fonts reset to defaults");
    } catch {
      updateFontAppearance(prev);
      sonnerToast.error("Couldn't reset", { description: "Please try again in a moment." });
    } finally {
      setFontPrefsBusy(false);
    }
  }

  // Persists the site theme. Admin-only (the section is hidden otherwise and
  // the route is 403-guarded). Optimistic via DocsLayout's updateTheme - that
  // owns the .dark class + inline CSS vars, so the UI reskins immediately and
  // rolls back the same way on failure. Switching to Custom with no colour yet
  // falls back to the current/seed colour.
  async function saveTheme(next: { mode: ThemeMode; customColor?: string | null }) {
    if (themePrefsBusy) return;
    setThemePrefsBusy(true);
    const prev = { mode: theme, customColor };
    const optimistic = {
      mode: next.mode,
      customColor: next.mode === "custom"
        ? (next.customColor ?? customColor ?? DEFAULT_CUSTOM_COLOR)
        : null,
    };
    updateTheme(optimistic);
    try {
      const token = getToken();
      if (!token) return;
      const res = await fetch("/api/me/theme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(
          optimistic.mode === "custom"
            ? { theme: "custom", customColor: optimistic.customColor }
            : { theme: optimistic.mode },
        ),
      });
      if (!res.ok) {
        updateTheme(prev);
        sonnerToast.error("Couldn't save", { description: "Please try again in a moment." });
        return;
      }
      sonnerToast.success("Theme updated");
    } catch {
      updateTheme(prev);
      sonnerToast.error("Couldn't save", { description: "Please try again in a moment." });
    } finally {
      setThemePrefsBusy(false);
    }
  }

  // PATCH /me/handle. `next` null turns the profile link off.
  async function saveHandle(next: string | null): Promise<boolean> {
    setHandleSaving(true);
    setHandleError(null);
    try {
      const token = getToken();
      const res = await fetch("/api/me/handle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ handle: next }),
      });
      const json = await res.json() as { ok: boolean; error?: string; reason?: HandleProblem | "locked"; data?: { handle: string | null } };
      if (json.ok) {
        const saved = json.data?.handle ?? null;
        setCurrentHandle(saved);
        setHandle(saved ?? "");
        return true;
      }
      if (res.status === 409) setHandleError("That username is taken.");
      else if (json.reason === "locked") {
        setHandleLocked(true);
        setHandle(currentHandle ?? "");
        toast({ title: "Your profile link is locked by an admin.", variant: "destructive" });
      } else if (json.reason && HANDLE_PROBLEM_MESSAGES[json.reason]) setHandleError(HANDLE_PROBLEM_MESSAGES[json.reason]);
      else toast({ title: json.error ?? "Failed to update profile link", variant: "destructive" });
      return false;
    } catch {
      toast({ title: "Could not connect to the server", variant: "destructive" });
      return false;
    } finally {
      setHandleSaving(false);
    }
  }

  async function handleSaveHandle(e: React.FormEvent) {
    e.preventDefault();
    const next = normalizeHandle(handle);
    if (!next || next === currentHandle) return;
    const problem = handleProblem(next);
    if (problem) {
      setHandleError(HANDLE_PROBLEM_MESSAGES[problem]);
      return;
    }
    const wasOn = currentHandle !== null;
    if (await saveHandle(next)) toast({ title: wasOn ? "Profile link updated" : "Profile link turned on" });
  }

  function handleToggleProfileLink(next: boolean) {
    setHandleError(null);
    if (next) {
      setHandleEnabled(true);
      return;
    }
    if (currentHandle) {
      setHandleDisableConfirmOpen(true);
    } else {
      setHandleEnabled(false);
      setHandle("");
    }
  }

  async function confirmDisableProfileLink() {
    setHandleDisableConfirmOpen(false);
    if (await saveHandle(null)) {
      setHandleEnabled(false);
      toast({ title: "Profile link turned off" });
    }
  }

  async function handleSaveBio(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = bio.trim();
    if (trimmed === currentBio) return;
    if (trimmed.length > BIO_MAX) return;
    setBioSaving(true);
    try {
      const token = getToken();
      const res = await fetch("/api/me/bio", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ bio: trimmed.length === 0 ? null : trimmed }),
      });
      const json = await res.json() as { ok: boolean; data?: { bio: string | null } };
      if (json.ok) {
        const next = json.data?.bio ?? "";
        setCurrentBio(next);
        setBio(next);
        flashBioSaved();
      } else {
        toast({ title: "Failed to update bio", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server", variant: "destructive" });
    } finally {
      setBioSaving(false);
    }
  }

  // Debounced search for the favourites picker. Server already excludes
  // sites the user has already favourited, so the result list is what's
  // *addable*. Empty query clears results without a request.
  useEffect(() => {
    const q = favouriteSearch.trim();
    if (q.length < 1) {
      setFavouriteSearchResults([]);
      setFavouriteSearchLoading(false);
      return;
    }
    setFavouriteSearchLoading(true);
    const handle = setTimeout(() => {
      const token = getToken();
      if (!token) return;
      fetch(`/api/me/favourite-sites/search?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json() as Promise<{ ok: boolean; data?: Array<{ id: string; name: string; vanitySlug: string | null; logoSquareUpdatedAt: string | null }> }>)
        .then(json => {
          if (json.ok && json.data) setFavouriteSearchResults(json.data);
        })
        .catch(() => {})
        .finally(() => setFavouriteSearchLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [favouriteSearch, favouriteSites]);

  async function handleAddFavourite(site: { id: string; name: string; vanitySlug: string | null; logoSquareUpdatedAt: string | null }) {
    setFavouriteAddingId(site.id);
    try {
      const token = getToken();
      const res = await fetch(`/api/me/favourite-sites/${site.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        setFavouriteSites(list => [{ ...site, note: null }, ...list.filter(s => s.id !== site.id)]);
        setFavouriteNoteDrafts(d => ({ ...d, [site.id]: "" }));
        setFavouriteNoteExpanded(e => ({ ...e, [site.id]: true }));
        setFavouriteSearchResults(list => list.filter(s => s.id !== site.id));
      } else {
        toast({ title: "Couldn't add favourite", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server", variant: "destructive" });
    } finally {
      setFavouriteAddingId(null);
    }
  }

  async function handleRemoveFavourite(projectId: string) {
    setFavouriteRemovingId(projectId);
    try {
      const token = getToken();
      const res = await fetch(`/api/me/favourite-sites/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        setFavouriteSites(list => list.filter(s => s.id !== projectId));
        setFavouriteNoteDrafts(d => {
          const { [projectId]: _, ...rest } = d;
          return rest;
        });
      } else {
        toast({ title: "Couldn't remove favourite", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server", variant: "destructive" });
    } finally {
      setFavouriteRemovingId(null);
    }
  }

  async function handleSaveFavouriteNote(projectId: string) {
    const draft = (favouriteNoteDrafts[projectId] ?? "").trim();
    if (draft.length > FAV_NOTE_MAX) return;
    setFavouriteNoteSavingId(projectId);
    try {
      const token = getToken();
      const res = await fetch(`/api/me/favourite-sites/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ note: draft.length === 0 ? null : draft }),
      });
      const json = await res.json() as { ok: boolean; data?: { note: string | null } };
      if (json.ok) {
        const saved = json.data?.note ?? null;
        setFavouriteSites(list => list.map(s => s.id === projectId ? { ...s, note: saved } : s));
        setFavouriteNoteDrafts(d => ({ ...d, [projectId]: saved ?? "" }));
      } else {
        toast({ title: "Couldn't save note", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server", variant: "destructive" });
    } finally {
      setFavouriteNoteSavingId(null);
    }
  }

  const settingsSections: SettingsSectionDef[] = [
    { id: "account", label: "Account", group: "profile" },
    { id: "favourites", label: "Favourite sites", group: "profile" },
    { id: "billing", label: "Billing", group: "plan" },
    { id: "appearance", label: "Appearance", group: "preferences" },
    { id: "security", label: "Sign-in & security", group: "security" },
    { id: "danger", label: "Danger zone", group: "danger", danger: true },
  ];

  return (
    <SettingsShell
      title="Account settings"
      description="Manage your account preferences."
      groups={USER_SETTINGS_GROUPS}
      sections={settingsSections}
    >
          {/* Account section */}
          <section id="account">
            <h2 className="text-base font-semibold">Account</h2>
            <p className="mt-1 text-sm text-muted-foreground">Update your personal information.</p>

            {/* Avatar block: an 80px avatar with "Change photo" beside it, the
                compact Dark/Light preview toggle directly under that button
                and a one-line helper under the toggle. */}
            {userId && (
              <div className="mt-5 flex flex-col items-start gap-3">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={handleAvatarChange}
                />
                <Popover open={avatarPopoverOpen} onOpenChange={setAvatarPopoverOpen}>
                  {/* A grid at every width: avatar | controls (Change photo
                      over the Dark/Light selector). The helper sits under the
                      controls from sm up and spans the full row on phones. */}
                  <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
                    <PopoverTrigger asChild>
                      <button type="button" aria-label="Change profile photo" className="relative group rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0 row-span-2">
                        <UserAvatar userId={userId} name={name || "?"} className="size-20 [&_[data-slot=avatar-fallback]]:text-[1.875rem] [&_[data-slot=avatar-fallback]]:font-medium" cacheBust={avatarKey} personalPlan={personalPlan} personalPlanStyle={personalPlanStyle} variant={avatarVariant} />
                        <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                          {avatarUploading
                            ? <Loader2 className="size-5 text-white animate-spin" />
                            : <Camera className="size-5 text-white" />}
                        </div>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      className="w-40 p-1"
                      align="start"
                      // The visible "Change photo" button toggles this same
                      // popover; don't let its press count as an outside
                      // click (which would close and instantly reopen it).
                      onInteractOutside={e => {
                        if (changePhotoButtonRef.current?.contains(e.target as Node)) e.preventDefault();
                      }}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        disabled={avatarUploading}
                        onClick={() => avatarInputRef.current?.click()}
                      >
                        <Upload className="size-3.5 mr-2" />
                        Upload photo
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start text-destructive hover:text-destructive"
                        disabled={avatarUploading}
                        onClick={handleRemoveAvatar}
                      >
                        <Trash2 className="size-3.5 mr-2" />
                        Remove photo
                      </Button>
                    </PopoverContent>

                    {/* Visible entry point to the same Upload/Remove popover
                        (the avatar itself is the hidden-affordance trigger);
                        the popover anchors here so it never covers it. The
                        compact Dark/Light toggle sits directly under it and
                        picks which avatar slot the preview shows and
                        Upload/Remove target (one image per background). */}
                    <div className="flex min-w-0 flex-col items-start gap-2 self-end">
                      <PopoverAnchor asChild>
                        <Button
                          ref={changePhotoButtonRef}
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-haspopup="dialog"
                          aria-expanded={avatarPopoverOpen}
                          disabled={avatarUploading}
                          onClick={() => setAvatarPopoverOpen(open => !open)}
                        >
                          <Camera className="size-3.5" aria-hidden />
                          Change photo
                        </Button>
                      </PopoverAnchor>
                      {/* "Editing photo for" lead-in so the segments read as
                          "which photo you're editing", not an app theme switch. */}
                      <div className="flex items-center gap-2">
                        <span aria-hidden className="whitespace-nowrap text-xs text-muted-foreground">Editing photo for</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              role="radiogroup"
                              aria-label="Avatar preview background"
                              aria-describedby="avatar-variant-hint"
                              className="inline-flex shrink-0 rounded-md border border-border bg-muted/40 p-0.5"
                            >
                              {(["dark", "light"] as const).map(v => {
                                const selected = avatarVariant === v;
                                const Icon = v === "dark" ? Moon : Sun;
                                return (
                                  <button
                                    key={v}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => setAvatarVariant(v)}
                                    className={cn(
                                      "inline-flex h-11 items-center gap-1 whitespace-nowrap rounded-[5px] px-2.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6",
                                      selected
                                        ? "bg-background font-medium text-foreground shadow-xs"
                                        : "text-muted-foreground hover:text-foreground",
                                    )}
                                  >
                                    <Icon className="size-3.5" aria-hidden />
                                    {v === "dark" ? "Dark" : "Light"}
                                  </button>
                                );
                              })}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-56 text-xs">
                            Preview your avatar on dark or light backgrounds. Each can use a different photo.
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <p id="avatar-variant-hint" className="col-span-2 mt-1.5 text-xs text-muted-foreground sm:col-span-1 sm:col-start-2 sm:mt-0 sm:self-start">
                      Use a different photo on light backgrounds (optional).
                    </p>
                  </div>
                </Popover>

                {cropFile && (
                  <AvatarCropDialog
                    file={cropFile}
                    onApply={handleCropApply}
                    onClose={() => setCropFile(null)}
                  />
                )}
              </div>
            )}

            {/* Email + display name come from the identity service (read-only
                here); "Manage" opens the account page on auth.cubityfir.st. The
                read-only inputs keep the label association and the values the
                e2e specs read. */}
            <div className="mt-6 flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Label htmlFor="email">Email</Label>
                  <input
                    id="email"
                    value={email}
                    readOnly
                    className="min-h-0! w-full min-w-0 truncate bg-transparent p-0 text-[13px] leading-snug text-muted-foreground outline-none"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Label htmlFor="display-name">Display name</Label>
                  <input
                    id="display-name"
                    value={name}
                    readOnly
                    className="min-h-0! w-full min-w-0 truncate bg-transparent p-0 text-[13px] leading-snug text-muted-foreground outline-none"
                  />
                </div>
                <Button asChild variant="outline" size="sm" className="h-11 shrink-0 sm:h-8">
                  <a href={accountUrl} aria-label={`Change email or display name at ${identityHost}`}>
                    Manage
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                </Button>
              </div>
            </div>

            {/* Profile-card visibility rows: bordered row cards, matching the
                site-settings row pattern. Each reveals its detail inline. */}
            <div className="mt-6 flex flex-col gap-3">
              <div className="rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <Label htmlFor="tz-visible">Show my timezone on my profile card</Label>
                    <p className="text-[13px] leading-snug text-muted-foreground">
                      {timezonePrivate
                        ? "Off – nobody sees your local time."
                        : "People who open your card see your local time."}
                    </p>
                  </div>
                  <Switch
                    id="tz-visible"
                    checked={!timezonePrivate}
                    disabled={timezoneSaving}
                    onCheckedChange={async visible => {
                      if (!visible) {
                        setTimezonePrivate(true);
                        setTimezone(null);
                        await saveTimezone(null);
                      } else {
                        const g = detectTimezoneGroup();
                        if (g) {
                          setTimezone(g.iana);
                          setTimezonePrivate(false);
                          await saveTimezone(g.iana);
                        } else {
                          setTimezonePrivate(false);
                        }
                      }
                    }}
                  />
                </div>
                {!timezonePrivate && (
                  <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="timezone">Timezone</Label>
                      {timezoneSaving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                      <SavedIndicator show={!timezoneSaving && timezoneSaved} />
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Select
                        value={timezone ?? ""}
                        onValueChange={async val => {
                          const iana = val || null;
                          setTimezone(iana);
                          setTimezonePrivate(false);
                          await saveTimezone(iana);
                        }}
                        disabled={timezoneSaving}
                      >
                        <SelectTrigger id="timezone" className="flex-1">
                          <SelectValue placeholder="Select timezone…">
                            {timezone && (() => {
                              const g = getTimezoneGroup(timezone);
                              return g ? formatTimezoneLabel(g) : timezone;
                            })()}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          {TIMEZONE_GROUPS.map(g => (
                            <SelectItem key={g.iana} value={g.iana}>{formatTimezoneLabel(g)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0 self-start sm:self-auto"
                        disabled={timezoneSaving}
                        onClick={async () => {
                          const g = detectTimezoneGroup();
                          if (g) {
                            setTimezone(g.iana);
                            setTimezonePrivate(false);
                            await saveTimezone(g.iana);
                          }
                        }}
                      >
                        Auto-detect
                      </Button>
                    </div>
                    {timezone && (() => {
                      const g = getTimezoneGroup(timezone);
                      return (
                        <p className="text-[13px] text-muted-foreground">
                          Currently {formatTimeInZone(timezone)} – {g?.offset ?? timezone}
                        </p>
                      );
                    })()}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <Label htmlFor="profile-link-toggle">Profile link</Label>
                    <p className="text-[13px] leading-snug text-muted-foreground">
                      Pick a username so signed-in people can open your profile at <span className="font-mono">/@username</span>.
                    </p>
                    {handleLocked && (
                      <p className="mt-0.5 flex items-center gap-1 text-[13px] text-muted-foreground">
                        <LockKeyhole className="size-3 shrink-0" />
                        Managed by an Annex admin – you can't change it.
                      </p>
                    )}
                  </div>
                  <Switch
                    id="profile-link-toggle"
                    checked={handleEnabled}
                    disabled={handleSaving || handleLocked}
                    onCheckedChange={handleToggleProfileLink}
                  />
                </div>
                {handleEnabled && (() => {
                  const draft = normalizeHandle(handle);
                  const changed = !handleLocked && draft !== (currentHandle ?? "");
                  const draftProblem = draft ? handleProblem(draft) : null;
                  const message = handleError ?? (changed && draftProblem ? HANDLE_PROBLEM_MESSAGES[draftProblem] : null);
                  const link = currentHandle ? `${window.location.origin}/@${currentHandle}` : null;
                  return (
                    <form onSubmit={handleSaveHandle} className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
                      <Label htmlFor="profile-handle" className="sr-only">Username</Label>
                      <div className="flex items-center">
                        <InlineSaveControls
                          changed={changed}
                          saving={handleSaving}
                          onReset={() => { setHandle(currentHandle ?? ""); setHandleError(null); }}
                          saveDisabled={!draft || !!draftProblem}
                          resetLabel="Reset username"
                          saveLabel="Save username"
                        >
                          <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">@</span>
                          <Input
                            id="profile-handle"
                            value={handle}
                            onChange={e => { setHandle(e.target.value); setHandleError(null); }}
                            readOnly={handleLocked}
                            placeholder="username"
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            maxLength={HANDLE_MAX_LENGTH + 1}
                            aria-invalid={!!message}
                            aria-describedby={message ? "profile-handle-error" : undefined}
                            className="flex-1 pl-7"
                          />
                        </InlineSaveControls>
                      </div>
                      {message ? (
                        <p id="profile-handle-error" role="alert" className="text-xs text-destructive">{message}</p>
                      ) : link ? (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Link to={`/@${currentHandle}`} className="truncate font-mono hover:text-foreground hover:underline">{link}</Link>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                aria-label="Copy profile link"
                                onClick={() => {
                                  navigator.clipboard.writeText(link)
                                    .then(() => toast({ title: "Profile link copied" }))
                                    .catch(() => toast({ title: "Couldn't copy the link", variant: "destructive" }));
                                }}
                                className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <Copy className="size-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">Copy profile link</TooltipContent>
                          </Tooltip>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">Letters, numbers, - and _. Save to turn the link on.</p>
                      )}
                    </form>
                  );
                })()}
              </div>
            </div>

            <AlertDialog open={handleDisableConfirmOpen} onOpenChange={setHandleDisableConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Turn off your profile link?</AlertDialogTitle>
                  <AlertDialogDescription>
                    /@{currentHandle} will stop working and the username will be released, so someone else could claim it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction onClick={confirmDisableProfileLink}>Turn off</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </section>

          <Separator className="my-10" />

          {/* Favourite sites - published projects the user has bookmarked.
              Surfaces on their profile card; managed here. */}
          <section id="favourites">
            <h2 className="text-base font-semibold">Favourite sites</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Up to 3 published sites you've added. They appear on your profile card.
            </p>

            {/* Picker: search any published site by name. Server excludes
                already-favourited sites so the dropdown only shows additions.
                Hidden once the user is at the 3-favourite cap. */}
            {favouriteSites.length < 3 && (
            <div className="mt-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  value={favouriteSearch}
                  onChange={e => setFavouriteSearch(e.target.value)}
                  placeholder="Search published sites to add…"
                  className="pl-8 pr-8"
                />
                {favouriteSearch && (
                  <button
                    type="button"
                    onClick={() => setFavouriteSearch("")}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              {favouriteSearch.trim().length > 0 && (
                <div className="mt-2 rounded-md border bg-card">
                  {favouriteSearchLoading ? (
                    <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                    </div>
                  ) : favouriteSearchResults.length === 0 ? (
                    <p className="px-3 py-3 text-center text-xs text-muted-foreground">No matching sites.</p>
                  ) : (
                    <ul className="flex flex-col">
                      {favouriteSearchResults.map(site => {
                        const adding = favouriteAddingId === site.id;
                        return (
                          <li
                            key={site.id}
                            className="flex items-center gap-3 px-3 py-2 border-b border-border/40 last:border-b-0"
                          >
                            {site.logoSquareUpdatedAt ? (
                              <img
                                src={`/api/public/projects/${site.id}/logo/square?v=${encodeURIComponent(site.logoSquareUpdatedAt)}`}
                                alt=""
                                className="size-6 shrink-0 rounded object-cover"
                              />
                            ) : (
                              <Globe className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-sm">{site.name}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={adding}
                              onClick={() => handleAddFavourite(site)}
                            >
                              {adding ? <Loader2 className="size-3.5 animate-spin" /> : <><Plus className="size-3.5 mr-1" />Add</>}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
            )}

            {favouritesLoading ? (
              <div className="mt-4 space-y-2">
                <div className="h-11 rounded-md bg-muted/40 animate-pulse" />
                <div className="h-11 rounded-md bg-muted/40 animate-pulse" />
              </div>
            ) : favouriteSites.length === 0 ? (
              <div className="mt-3">
                <SettingsEmptyState
                  size="compact"
                  icon={Star}
                  title="No favourites yet"
                  hint="Add up to 3 published sites to show on your profile."
                />
              </div>
            ) : (
              <>
              <p className="mt-3 text-[13px] text-muted-foreground">
                {favouriteSites.length} of 3 added{favouriteSites.length >= 3 && " – remove one to add another"}.
              </p>
              <ul className="mt-2 flex flex-col gap-2">
                {favouriteSites.map(site => {
                  const slug = site.vanitySlug ?? site.id;
                  const removing = favouriteRemovingId === site.id;
                  const draft = favouriteNoteDrafts[site.id] ?? "";
                  const savedNote = site.note ?? "";
                  const noteDirty = draft.trim() !== savedNote.trim();
                  const noteSaving = favouriteNoteSavingId === site.id;
                  const noteTooLong = draft.trim().length > FAV_NOTE_MAX;
                  // Default-open if there's a saved note or unsaved draft, so the
                  // user can see/edit existing content without an extra click.
                  // Explicit toggle state overrides the default once the user
                  // touches the chevron.
                  const explicitExpanded = favouriteNoteExpanded[site.id];
                  const expanded = explicitExpanded ?? (savedNote.length > 0 || noteDirty);
                  return (
                    <li
                      key={site.id}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-2"
                    >
                      <div className="flex items-center gap-3">
                        {site.logoSquareUpdatedAt ? (
                          <img
                            src={`/api/public/projects/${site.id}/logo/square?v=${encodeURIComponent(site.logoSquareUpdatedAt)}`}
                            alt=""
                            className="size-7 shrink-0 rounded object-cover"
                          />
                        ) : (
                          <Globe className="size-5 shrink-0 text-muted-foreground" />
                        )}
                        <Link
                          to={`/s/${slug}`}
                          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                        >
                          {site.name}
                        </Link>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setFavouriteNoteExpanded(e => ({ ...e, [site.id]: !expanded }))}
                          aria-label={expanded ? `Hide note for ${site.name}` : `Add a note for ${site.name}`}
                          aria-expanded={expanded}
                        >
                          <ChevronDown className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={removing}
                          onClick={() => handleRemoveFavourite(site.id)}
                          aria-label={`Remove ${site.name} from favourites`}
                        >
                          {removing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                        </Button>
                      </div>
                      {expanded && (
                        <form
                          className="flex"
                          onSubmit={e => { e.preventDefault(); if (noteDirty && !noteTooLong) handleSaveFavouriteNote(site.id); }}
                        >
                          <InlineSaveControls
                            changed={noteDirty}
                            saving={noteSaving}
                            onReset={() => setFavouriteNoteDrafts(d => ({ ...d, [site.id]: savedNote }))}
                            saveDisabled={noteTooLong}
                            resetLabel={`Reset note for ${site.name}`}
                            saveLabel={`Save note for ${site.name}`}
                          >
                            <Textarea
                              value={draft}
                              onChange={e => setFavouriteNoteDrafts(d => ({ ...d, [site.id]: e.target.value }))}
                              maxLength={FAV_NOTE_MAX}
                              rows={2}
                              placeholder="Why is this site on your list? (optional)"
                              className="min-h-[52px] resize-none text-sm"
                              aria-label={`Note for ${site.name}`}
                            />
                            <span className="pointer-events-none absolute bottom-1.5 right-2 text-[11px] tabular-nums text-muted-foreground">
                              {draft.trim().length}/{FAV_NOTE_MAX}
                            </span>
                          </InlineSaveControls>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
              </>
            )}
          </section>

          <Separator className="my-10" />

          {/* Billing section - Annex Ink supporter tier */}
          <section id="billing">
            <h2 className="text-base font-semibold flex items-center gap-2">
              Billing
              {personalPlan === "ink" && <Sparkles className="size-3.5 text-amber-500" />}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Your supporter subscription.</p>

            {personalPlanStatus === "past_due" && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-start gap-2">
                <AlertCircle className="size-4 mt-0.5 shrink-0" />
                <span>Your last payment failed. Update your payment method to keep your Ink perks.</span>
              </div>
            )}

            {personalPlan === "free" ? (
              <div className="mt-5 rounded-lg border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                      <InkSparkle className="size-3.5 ink-icon" />
                      Annex Ink
                    </h3>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">Helps keep the lights on.</p>
                  </div>
                  <p className="shrink-0 whitespace-nowrap leading-none">
                    <span className="text-2xl font-semibold tracking-tight">$5</span>
                    <span className="ml-1 text-sm text-muted-foreground">/ month</span>
                  </p>
                </div>
                <ul className="mt-4 flex flex-col gap-2 text-sm">
                  {INK_PERKS.map(perk => (
                    <li key={perk} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span>{perk}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-5 flex justify-end border-t border-border pt-4">
                  <Button className="w-full sm:w-auto" onClick={() => startCheckoutOrPortal("/api/billing/checkout")} disabled={billingBusy}>
                    {billingBusy ? <Loader2 className="size-4 animate-spin" /> : <>Become a supporter</>}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-5 rounded-lg border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-4">
                    {userId && (
                      <UserAvatar userId={userId} name={name || "?"} className="size-12" cacheBust={avatarKey} personalPlan="ink" personalPlanStyle={personalPlanStyle} />
                    )}
                    <div>
                      <h3 className="text-sm font-semibold flex items-center gap-1.5">
                        <Sparkles className="size-3.5 text-amber-500" />
                        Annex Ink
                        {personalPlanStatus === "granted" && <span className="text-xs font-normal text-muted-foreground">(gifted)</span>}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {(() => {
                          const since = formatInkSince(personalPlanSince);
                          const sinceLine = since ? `Supporter since ${since}.` : "Active supporter.";
                          if (personalPlanStatus === "granted") {
                            return <>{sinceLine}<br />Annex Ink is on us. Thank you for being here.</>;
                          }
                          return sinceLine;
                        })()}
                      </p>
                      {personalPlanCancelAt && personalPlanStatus !== "granted" && (() => {
                        const expires = formatInkSince(personalPlanCancelAt);
                        return expires ? (
                          <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                            Your Annex Ink will expire on {expires}.
                          </p>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  {personalPlanStatus !== "granted" && (
                    <Button variant="outline" size="sm" onClick={() => startCheckoutOrPortal("/api/billing/portal")} disabled={billingBusy}>
                      {billingBusy ? <Loader2 className="size-4 animate-spin" /> : <>Manage subscription</>}
                    </Button>
                  )}
                </div>

                {/* Cosmetic prefs - Ink-only. Hidden by default; expanded
                    via the Customise toggle. Ring style swaps the conic
                    gradient on the avatar; presence colour overrides the
                    deterministic per-user collab cursor colour. */}
                <Separator className="my-5" />
                <Collapsible open={cosmeticsOpen} onOpenChange={setCosmeticsOpen}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-md px-1 py-1 text-sm font-medium transition-colors hover:bg-accent"
                      aria-expanded={cosmeticsOpen}
                    >
                      <span>Customise appearance</span>
                      <ChevronDown className={`size-4 text-muted-foreground transition-transform ${cosmeticsOpen ? "rotate-180" : ""}`} />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="space-y-5 pt-4">
                      <div>
                        <h4 className="text-sm font-semibold">Ring style</h4>
                        <p className="mt-0.5 text-xs text-muted-foreground">Pick the animated ring around your avatar.</p>
                        <div className="mt-3 flex flex-wrap gap-3">
                          {INK_RING_STYLE_OPTIONS.map(opt => {
                            const active = (personalPlanStyle ?? "shimmer") === opt.id;
                            const swatch = <span className="block size-8 rounded-full bg-muted" />;
                            const wrappedSwatch = opt.id === "none"
                              ? swatch
                              : <span className={opt.id === "shimmer" ? "ink-border inline-block" : `ink-border ink-style-${opt.id} inline-block`}>{swatch}</span>;
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                disabled={inkPrefsBusy}
                                onClick={() => saveInkPrefs({ style: opt.id === "shimmer" ? null : opt.id })}
                                className={`flex flex-col items-center gap-1.5 rounded-md border px-3 py-2 transition-colors disabled:opacity-50 ${active ? "border-foreground bg-accent" : "border-border hover:bg-accent"}`}
                                aria-pressed={active}
                              >
                                {wrappedSwatch}
                                <span className="text-xs">{opt.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <h4 className="text-sm font-semibold">Presence colour</h4>
                        <p className="mt-0.5 text-xs text-muted-foreground">The colour your cursor appears in to others when collaborating in real time. Leave default for an auto-picked colour.</p>
                        <div className="mt-3 flex items-center gap-3">
                          <ColorPicker
                            value={personalPresenceColor ?? "#888888"}
                            disabled={inkPrefsBusy}
                            onChange={(next) => setPersonalPresenceColor(next)}
                            onCommit={(next) => saveInkPrefs({ presenceColor: next })}
                          />
                          <span className="text-xs text-muted-foreground tabular-nums">{personalPresenceColor ?? "default"}</span>
                          {personalPresenceColor && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={inkPrefsBusy}
                              onClick={() => saveInkPrefs({ presenceColor: null })}
                            >
                              Reset
                            </Button>
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <h4 className="text-sm font-semibold">Dice crit sparkles</h4>
                            <p className="mt-0.5 text-xs text-muted-foreground">Sparkle burst when your dice rolls land a critical success.</p>
                          </div>
                          <Switch
                            checked={personalCritSparkles}
                            disabled={inkPrefsBusy}
                            onCheckedChange={(next) => saveInkPrefs({ critSparkles: next ? null : false })}
                            aria-label="Toggle dice crit sparkles"
                          />
                        </div>
                      </div>

                      <form onSubmit={handleSaveBio}>
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-semibold"><label htmlFor="settings-bio">Bio</label></h4>
                          <SavedIndicator show={bioSaved} />
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">A short note shown on your profile card. Leave empty to fall back to favourites or shared sites.</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Supports markdown: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">**bold**</code>, <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">*italic*</code>, <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">[links](https://…)</code>, <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">`code`</code>.</p>
                        <div className="mt-3 flex">
                          <InlineSaveControls
                            changed={bio.trim() !== currentBio}
                            saving={bioSaving}
                            onReset={() => setBio(currentBio)}
                            saveDisabled={bio.trim().length > BIO_MAX}
                            resetLabel="Reset bio"
                            saveLabel="Save bio"
                          >
                            <Textarea
                              id="settings-bio"
                              value={bio}
                              onChange={e => setBio(e.target.value)}
                              maxLength={BIO_MAX}
                              rows={3}
                              placeholder="Tell people a little about yourself"
                              className="min-h-[80px]"
                            />
                            <span className="pointer-events-none absolute bottom-1.5 right-2 text-[11px] tabular-nums text-muted-foreground">{bio.trim().length}/{BIO_MAX}</span>
                          </InlineSaveControls>
                        </div>
                      </form>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
          </section>

          <Separator className="my-10" />

          {/* Appearance - the theme (when available) first, then fonts. */}
          <section id="appearance">
            <h2 className="text-base font-semibold">Appearance</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose how the app looks and which fonts it uses.</p>

            {/* Theme - admins always see this; other users see it when the
                custom-theming Flagship flag is enabled for them. Dark is the
                default; Light drops .dark; Custom derives a palette from one
                colour. Server enforces the same logic. */}
            {(currentUser?.isAdmin || customThemingEnabled) && (
              <div className={cn("mt-5", SETTINGS_ROW_CARD)}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p id="theme-label" className="text-sm font-medium">Theme</p>
                    <p className="text-[13px] leading-snug text-muted-foreground">
                      Custom derives a full palette – surfaces, borders and accents – from a single colour.
                    </p>
                  </div>
                  <div role="group" aria-labelledby="theme-label" className="flex shrink-0 flex-wrap gap-2">
                    {([
                      { mode: "dark", label: "Dark", icon: Moon },
                      { mode: "light", label: "Light", icon: Sun },
                      { mode: "custom", label: "Custom", icon: null },
                    ] as const).map(opt => {
                      const active = theme === opt.mode;
                      const Icon = opt.icon;
                      return (
                        <button
                          key={opt.mode}
                          type="button"
                          disabled={themePrefsBusy}
                          onClick={() => saveTheme({ mode: opt.mode })}
                          aria-pressed={active}
                          className={cn(
                            "flex h-11 items-center gap-2 rounded-md border px-3 text-sm transition-colors disabled:opacity-50 sm:h-8",
                            active ? "border-foreground bg-accent" : "border-border hover:bg-accent",
                          )}
                        >
                          {Icon && <Icon className="size-4" aria-hidden />}
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {theme === "custom" && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                    <ColorPicker
                      value={customColor ?? DEFAULT_CUSTOM_COLOR}
                      disabled={themePrefsBusy}
                      onChange={(next) => updateTheme({ mode: "custom", customColor: next })}
                      onCommit={(next) => saveTheme({ mode: "custom", customColor: next })}
                    />
                    <span className="text-xs text-muted-foreground tabular-nums">{customColor ?? DEFAULT_CUSTOM_COLOR}</span>
                    <span className="text-xs text-muted-foreground">Lighter/darker shades are derived from this for the whole site.</span>
                  </div>
                )}
              </div>
            )}

            {/* Fonts - picks the prose font used in document reading and
                editing views. Free for all users (not Ink-gated); OpenDyslexic
                is an accessibility option. Each column is a radio across the
                three font rows; code lines stay monospace either way. */}
            <h3 className="mt-6 text-sm font-medium">Fonts</h3>
            <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
              Pick a font for each part of the app: Reading is used for docs, Editing for the editor, and
              Interface for menus and the rest of the UI.
              Inline code always stays monospaced.
            </p>

            <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full min-w-[20rem] table-fixed text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 text-left font-medium">Font</th>
                    {/* The last column carries the row's 16px right inset
                        (matching the Font column's left inset) and is widened
                        by the same amount, so every radio column keeps an
                        equal content width. Below sm the radio columns
                        narrow to 64px so all three fit a 390px phone without
                        sideways scrolling (the old 30rem floor hid Interface
                        off-screen with no scroll hint). */}
                    {(["Reading", "Editing", "Interface"] as const).map(label => (
                      <th key={label} scope="col" className="w-16 px-1 py-2.5 text-center font-medium last:w-[4.75rem] last:pr-4 sm:w-20 sm:last:w-[5.75rem]">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FONT_CHOICES.map(choice => {
                    const columns: { key: "readingFont" | "editingFont" | "uiFont"; checked: boolean; label: string }[] = [
                      { key: "readingFont", checked: readingFont === choice, label: "reading mode" },
                      { key: "editingFont", checked: editingFont === choice, label: "editing mode" },
                      { key: "uiFont", checked: uiFont === choice, label: "the rest of the app" },
                    ];
                    return (
                      <tr key={choice} className="border-t border-border">
                        <td className="px-4 py-3">
                          {/* One line per row (a short sample, truncated if
                              a wide face still overflows) so every row is the
                              same height and the radios align across rows. */}
                          <div className="truncate font-medium">{FONT_LABELS[choice]}</div>
                          <div className="mt-0.5 truncate text-sm leading-snug text-muted-foreground" style={{ fontFamily: FONT_STACKS[choice] }}>
                            The quick brown fox
                          </div>
                        </td>
                        {columns.map(col => (
                          <td key={col.key} className="px-1 py-3 text-center last:pr-4">
                            <label className={cn(
                              "relative flex w-full min-h-[40px] items-center justify-center",
                              fontPrefsBusy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                            )}>
                              <input
                                type="radio"
                                name={col.key}
                                value={choice}
                                checked={col.checked}
                                disabled={fontPrefsBusy}
                                onChange={() => saveFontPrefs({ [col.key]: choice })}
                                aria-label={`Use ${FONT_LABELS[choice]} for ${col.label}`}
                                className="peer sr-only"
                              />
                              <span className={cn(
                                "flex size-[18px] items-center justify-center rounded-full border-[1.5px] transition-colors",
                                col.checked ? "border-foreground" : "border-foreground/45 hover:border-foreground/70",
                                "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card",
                              )}>
                                {col.checked && <span className="size-2.5 rounded-full bg-foreground" />}
                              </span>
                            </label>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="disabled:opacity-60"
                disabled={fontPrefsBusy || (readingFont === DEFAULT_READING_FONT && editingFont === DEFAULT_EDITING_FONT && uiFont === DEFAULT_UI_FONT)}
                onClick={resetFontPrefs}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Reset to defaults
              </Button>
            </div>
          </section>

          <Separator className="my-10" />

          {/* Sign-in & security: owned by the identity service. */}
          <section id="security">
            <SettingsSectionHeader
              title="Sign-in & security"
              description={`Your password, two-factor, passkeys, email address and signed-in devices are managed at ${identityHost}.`}
            />
            <div className="mt-5 flex flex-col gap-3">
              <div className="rounded-lg border border-border bg-card">
                <SecurityRowHeader
                  title="Password, two-factor & passkeys"
                  description="Change your password, set up an authenticator app or passkey, and see where you're signed in."
                  action={
                    <Button asChild variant="outline" size="sm">
                      <a href={securityUrl}>
                        Manage
                        <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    </Button>
                  }
                />
              </div>
              <div className="rounded-lg border border-border bg-card">
                <SecurityRowHeader
                  title="Email & display name"
                  description="Your name and email are shared by every cubityfir.st service. Changes show up here the next time Annex syncs."
                  action={
                    <Button asChild variant="outline" size="sm">
                      <a href={accountUrl}>
                        Manage
                        <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    </Button>
                  }
                />
              </div>
            </div>
          </section>

          <Separator className="my-10" />

          {/* Danger zone */}
          <section id="danger" className="flex flex-col gap-4">
            <SettingsSectionHeader title="Danger zone" description="Irreversible actions for your account." />
            <DangerRow
              title="Delete your account"
              description={`Accounts are deleted at ${identityHost}. Transfer or delete the sites and organizations you own first.`}
              action={
                <Button asChild variant="outline" size="sm" className={DESTRUCTIVE_OUTLINE_BUTTON}>
                  <a href={accountUrl}>
                    Delete account
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                </Button>
              }
            />
          </section>
    </SettingsShell>
  );
}
