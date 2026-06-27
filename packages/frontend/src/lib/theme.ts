// Per-user site theme. Mirrors the font-preference machinery in lib/fonts.ts:
// a cookie carries the choice so the pre-/api/me boot phase and published-doc
// pages render correctly, and applyThemeToRoot() is the single place that
// mutates <html> (the .dark class + inline CSS-variable overrides).
//
// The site already ships a full light token set in index.css (:root) next to
// .dark, so:
//   - "dark"   → ensure the .dark class (the historic, hard-coded default)
//   - "light"  → drop .dark; the existing :root tokens take over
//   - "custom" → drop .dark and override the ~19 theme tokens inline with a
//                palette derived from one base colour
//
// Setting the theme is admin-only - the settings UI is hidden and the write
// route is 403-guarded unless the user is a global site admin. THEME_MODES
// must stay in sync with packages/auth/src/theme.ts.

import { converter, formatCss, clampChroma } from "culori";

export const THEME_MODES = ["dark", "light", "custom"] as const;
export type ThemeMode = typeof THEME_MODES[number];

export const DEFAULT_THEME: ThemeMode = "dark";

// Seed colour used when the user first switches to Custom before picking one.
// Matches the teal used in the planning preview.
export const DEFAULT_CUSTOM_COLOR = "#2e7d6b";

export interface ThemePrefs {
  mode: ThemeMode;
  customColor: string | null;
}

export const DEFAULT_THEME_PREFS: ThemePrefs = { mode: DEFAULT_THEME, customColor: null };

export function resolveThemeMode(value: string | null | undefined, fallback: ThemeMode = DEFAULT_THEME): ThemeMode {
  if (value && (THEME_MODES as readonly string[]).includes(value)) return value as ThemeMode;
  return fallback;
}

// The public landing page and the auth screens always render in the default
// (dark) brand look - the per-user theme is an in-app preference and must not
// leak onto these. Everything else (the DocsLayout app, public docs, etc.)
// uses the saved theme. Exact-match paths: none of these have sub-routes.
const UNTHEMED_PATHS = new Set(["/", "/login", "/register"]);

export function pathUsesUserTheme(pathname: string): boolean {
  return !UNTHEMED_PATHS.has(pathname);
}

// --- palette derivation ----------------------------------------------------

// Backdrop colours used for <html> itself so overscroll / pre-paint matches
// the active theme (index.html hard-codes the dark one as the static default).
const DARK_HTML_BG = "oklch(0.141 0.005 285.823)";
const LIGHT_HTML_BG = "oklch(1 0 0)";
const NEAR_WHITE = "oklch(0.985 0 0)";
const NEAR_BLACK = "oklch(0.21 0.006 285.885)";
// destructive stays a stock red, never tinted toward the base - recolouring
// "danger" muddies its meaning. Two variants so a light custom theme gets the
// lighter red (matches :root) and a dark one the darker red (matches .dark).
const DESTRUCTIVE_DARK = "oklch(0.396 0.141 25.723)";
const DESTRUCTIVE_LIGHT = "oklch(0.577 0.245 27.325)";

// Base oklch lightness at/above which a pick builds a LIGHT theme rather than
// a dark one. Set high enough that mid-tone brand colours still read as dark
// themes; only genuinely pale picks flip to light.
const LIGHT_THEME_THRESHOLD = 0.65;

const toOklch = converter("oklch");

// The full set of CSS custom properties applyThemeToRoot manages inline. Kept
// as a constant so non-custom modes can reliably clear every one and let the
// stylesheet (:root / .dark) reapply.
export const MANAGED_VARS = [
  "--background", "--foreground", "--card", "--card-foreground",
  "--popover", "--popover-foreground", "--primary", "--primary-foreground",
  "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--destructive", "--destructive-foreground",
  "--border", "--input", "--ring",
] as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// clampChroma keeps the colour inside the sRGB gamut (the app renders sRGB);
// without it, high-chroma picks would clip per-channel and shift hue.
function fmt(l: number, c: number, h: number): string {
  return formatCss(clampChroma({ mode: "oklch", l, c, h }, "oklch"));
}

// "Tinted surfaces (full)" strategy: the picked colour drives a tinted neutral
// scale (background → card → border) plus a base-coloured primary/ring, with
// auto-contrast text. The picked colour's lightness chooses the polarity -
// a pale pick yields a light theme, a dark pick a dark one - so users can
// build either. Each polarity uses its own banded lightness scale (not a
// free-floating background), so a mid-tone pick still resolves to a clearly
// light or dark backdrop instead of a muddy, low-contrast in-between. Chroma
// is bounded so even neon picks stay legible.
export function derivePalette(baseHex: string): Record<string, string> {
  const base = toOklch(baseHex);
  const h = base?.h ?? 0;
  const cBase = base?.c ?? 0;
  const lBase = base?.l ?? 0.55;

  const dark = lBase < LIGHT_THEME_THRESHOLD;
  const surfaceC = Math.min(cBase, dark ? 0.045 : 0.035);
  const mutedFgC = Math.min(cBase, 0.03);
  const fg = dark ? NEAR_WHITE : NEAR_BLACK;

  // Banded surface lightnesses per polarity. The light band mirrors the
  // index.css :root scale (≈1 / 0.967 / 0.92), the dark band the .dark scale.
  const bgL = dark ? 0.18 : 0.975;
  const cardL = dark ? 0.18 : 0.99;
  const subtleL = dark ? 0.26 : 0.955; // secondary / muted
  const edgeL = dark ? 0.30 : 0.90; // accent / border / input
  const mutedFgL = dark ? 0.72 : 0.50;

  // Primary keeps the picked hue at a usable mid lightness with the picked
  // chroma, bounded so it stays distinct from both text and surfaces in
  // either polarity.
  const primL = clamp(lBase, 0.48, 0.62);
  const primC = clamp(cBase, 0.05, 0.16);
  const primaryFg = primL > 0.6 ? NEAR_BLACK : NEAR_WHITE;
  const primary = fmt(primL, primC, h);

  return {
    "--background": fmt(bgL, surfaceC, h),
    "--foreground": fg,
    "--card": fmt(cardL, surfaceC, h),
    "--card-foreground": fg,
    "--popover": fmt(cardL, surfaceC, h),
    "--popover-foreground": fg,
    "--primary": primary,
    "--primary-foreground": primaryFg,
    "--secondary": fmt(subtleL, surfaceC, h),
    "--secondary-foreground": fg,
    "--muted": fmt(subtleL, surfaceC, h),
    "--muted-foreground": fmt(mutedFgL, mutedFgC, h),
    "--accent": fmt(edgeL, surfaceC, h),
    "--accent-foreground": fg,
    "--destructive": dark ? DESTRUCTIVE_DARK : DESTRUCTIVE_LIGHT,
    "--destructive-foreground": NEAR_WHITE,
    "--border": fmt(edgeL, surfaceC, h),
    "--input": fmt(edgeL, surfaceC, h),
    "--ring": primary,
  };
}

// Whether the effective theme renders on a light backdrop (near-black text).
// Consumers that key off the .dark class can't tell - custom never sets it,
// yet a pale pick yields a light theme - so use this instead (e.g. to keep
// the black wordmark un-inverted). Mirrors derivePalette's polarity decision
// and applyThemeToRoot's "custom-without-colour falls back to dark" rule.
export function isLightTheme(prefs: ThemePrefs): boolean {
  if (prefs.mode === "light") return true;
  if (prefs.mode === "custom" && prefs.customColor) {
    return (toOklch(prefs.customColor)?.l ?? 0.55) >= LIGHT_THEME_THRESHOLD;
  }
  return false; // dark, or custom with no colour (→ dark fallback)
}

// --- cookie ---------------------------------------------------------------

// Same rationale as the font cookie: a short, human-readable same-origin
// cookie so published-doc pages and the pre-/api/me boot apply the choice
// without an /api/me round-trip. Format: `m:<mode>|c:<#hex>` (c omitted unless
// custom). Unknown values fall back to defaults at parse time.
const COOKIE_NAME = "cd_theme";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function readThemePrefsCookie(): ThemePrefs {
  if (typeof document === "undefined") return DEFAULT_THEME_PREFS;
  const raw = document.cookie.split("; ").find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return DEFAULT_THEME_PREFS;
  const value = decodeURIComponent(raw.slice(COOKIE_NAME.length + 1));
  let m: string | null = null;
  let c: string | null = null;
  for (const part of value.split("|")) {
    if (part.startsWith("m:")) m = part.slice(2);
    else if (part.startsWith("c:")) c = part.slice(2);
  }
  const mode = resolveThemeMode(m);
  return {
    mode,
    customColor: mode === "custom" && c && HEX_RE.test(c) ? c.toLowerCase() : null,
  };
}

export function writeThemePrefsCookie(prefs: ThemePrefs): void {
  if (typeof document === "undefined") return;
  const parts = [`m:${prefs.mode}`];
  if (prefs.mode === "custom" && prefs.customColor) parts.push(`c:${prefs.customColor}`);
  const value = parts.join("|");
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

// --- apply ----------------------------------------------------------------

// Mutates <html>: the .dark class plus inline CSS-variable overrides. Called
// both at module-load in main.tsx (before React mounts) and from DocsLayout's
// theme-state effect. Always clears the managed vars first so switching out of
// custom lets :root / .dark reapply cleanly.
export function applyThemeToRoot(prefs: ThemePrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const name of MANAGED_VARS) root.style.removeProperty(name);

  if (prefs.mode === "custom" && prefs.customColor) {
    const palette = derivePalette(prefs.customColor);
    // Match .dark to the derived polarity so the ~39 `dark:*` utilities and
    // `dark:prose-invert` (AI summary, file summary, public doc body) behave
    // correctly - a custom *dark* theme still needs them. The inline vars
    // below beat both :root and .dark for the 19 theme tokens, so toggling
    // the class only steers the non-token `dark:` utilities and the wordmark.
    root.classList.toggle("dark", !isLightTheme(prefs));
    for (const [name, val] of Object.entries(palette)) root.style.setProperty(name, val);
    root.style.backgroundColor = palette["--background"];
    return;
  }

  if (prefs.mode === "light") {
    root.classList.remove("dark");
    root.style.backgroundColor = LIGHT_HTML_BG;
    return;
  }

  // dark - the historic default, and the fallback for custom-without-colour.
  root.classList.add("dark");
  root.style.backgroundColor = DARK_HTML_BG;
}
