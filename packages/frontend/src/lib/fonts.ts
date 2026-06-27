// Font-stack catalogue used by both the wysiwyg editor (via CSS variables
// on :root) and the user-settings preview. Keep these stacks in sync with
// the auth FONT_CHOICES list (packages/auth/src/fonts.ts) - a row added
// there needs a stack entry here.
//
// OpenDyslexic woff2 files are self-hosted under /public/fonts/ with an
// @font-face block in index.css. The dyslexic stack falls back to sans
// if the font hasn't loaded yet (font-display: swap).

export const FONT_CHOICES = ["mono", "sans", "dyslexic"] as const;
export type FontChoice = typeof FONT_CHOICES[number];

const SANS_STACK = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const MONO_STACK = `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
const DYSLEXIC_STACK = `"OpenDyslexic", ${SANS_STACK}`;

export const FONT_STACKS: Record<FontChoice, string> = {
  sans: SANS_STACK,
  mono: MONO_STACK,
  dyslexic: DYSLEXIC_STACK,
};

export const FONT_LABELS: Record<FontChoice, string> = {
  sans: "Default (Sans)",
  mono: "Monospace",
  dyslexic: "OpenDyslexic",
};

export const DEFAULT_READING_FONT: FontChoice = "sans";
export const DEFAULT_EDITING_FONT: FontChoice = "mono";
export const DEFAULT_UI_FONT: FontChoice = "sans";

export function resolveFontChoice(value: string | null | undefined, fallback: FontChoice): FontChoice {
  if (value && (FONT_CHOICES as readonly string[]).includes(value)) return value as FontChoice;
  return fallback;
}

// Cookie persistence so published-doc pages (which never hit /api/me) and the
// pre-/api/me boot phase of authenticated pages render with the user's chosen
// font instead of flashing the default. Same origin as the SPA, so a single
// cookie with path=/ is enough - no Domain= needed.
//
// Format: `r:<readingChoice>|e:<editingChoice>` - kept short and human-readable
// so dev-tooling cookie inspectors stay legible. Unknown choices are ignored
// and fall back to defaults at parse time.
const COOKIE_NAME = "cd_fonts";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export interface FontPrefs {
  readingFont: FontChoice;
  editingFont: FontChoice;
  uiFont: FontChoice;
}

export const DEFAULT_FONT_PREFS: FontPrefs = {
  readingFont: DEFAULT_READING_FONT,
  editingFont: DEFAULT_EDITING_FONT,
  uiFont: DEFAULT_UI_FONT,
};

export function readFontPrefsCookie(): FontPrefs {
  if (typeof document === "undefined") return DEFAULT_FONT_PREFS;
  const raw = document.cookie.split("; ").find(c => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return DEFAULT_FONT_PREFS;
  const value = decodeURIComponent(raw.slice(COOKIE_NAME.length + 1));
  let r: string | null = null;
  let e: string | null = null;
  let u: string | null = null;
  for (const part of value.split("|")) {
    if (part.startsWith("r:")) r = part.slice(2);
    else if (part.startsWith("e:")) e = part.slice(2);
    else if (part.startsWith("u:")) u = part.slice(2);
  }
  return {
    readingFont: resolveFontChoice(r, DEFAULT_READING_FONT),
    editingFont: resolveFontChoice(e, DEFAULT_EDITING_FONT),
    uiFont: resolveFontChoice(u, DEFAULT_UI_FONT),
  };
}

export function writeFontPrefsCookie(prefs: FontPrefs): void {
  if (typeof document === "undefined") return;
  const value = `r:${prefs.readingFont}|e:${prefs.editingFont}|u:${prefs.uiFont}`;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

// Writes the three font-family stacks to CSS variables on <html>. Called both
// at module-load time in main.tsx (before React mounts, so PublicDocPage and
// the pre-/api/me boot phase already render in the right font) and from
// DocsLayout's font-state effect whenever the user picks a new choice.
//   --reading-font → .cm-wysiwyg--reading .cm-content + .reading-prose
//   --editing-font → .cm-wysiwyg:not(.cm-wysiwyg--reading) .cm-content
//   --ui-font      → body (cascades to everything that doesn't have its own
//                    font-family rule)
export function applyFontVarsToRoot(prefs: FontPrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--reading-font", FONT_STACKS[prefs.readingFont]);
  root.style.setProperty("--editing-font", FONT_STACKS[prefs.editingFont]);
  root.style.setProperty("--ui-font", FONT_STACKS[prefs.uiFont]);
}
