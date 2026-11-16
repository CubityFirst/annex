// Initialises the Shiki highlighter once at module load.
// codeToHtml() is synchronous after the highlighter is created, so after
// the first async init, all subsequent code blocks highlight with no delay.
//
// Uses Shiki's JavaScript RegExp engine rather than the default WASM
// (oniguruma) engine: it skips the ~1MB WASM fetch + compile/instantiate, so
// the highlighter is ready far sooner on page load (shrinking the brief
// plain→highlighted flash) and adds no WASM to the bundle. `forgiving: true`
// makes the engine fall back instead of throwing on the rare grammar pattern
// it can't translate to native RegExp, so highlighting never hard-fails.

import { createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

let _highlighter: Highlighter | null = null;

// Light + dark variants of one theme: codeToHtml emits the light colour inline
// plus a --shiki-dark variable, and index.css swaps to it under .dark. Before,
// light mode painted vitesse-dark's pale tokens on a white card.
const CODE_THEMES = { light: "vitesse-light", dark: "vitesse-dark" } as const;

// Vitesse's muted tokens (comments, punctuation, the translucent quote/key
// marks) sit around 2-3.5:1 on our card surfaces. Same hues, nudged until each
// clears WCAG AA 4.5:1 - dark values checked against #212121 (lighter than the
// dark card, so conservative), light ones against white.
const COLOR_REPLACEMENTS = {
  "vitesse-dark": {
    "#758575dd": "#849484", // comments (was 3.5-3.8:1)
    "#666666": "#8c8c8c", // brackets, delimiters
    "#c98a7d77": "#a6837c", // string quotes
    "#b8a96577": "#978c60", // property-key quotes
    "#6872ab": "#8189ba", // type identifiers, regexp classes
    "#4d9375": "#529a7b", // HTML tags
    "#c4704f": "#c87757", // regexps
  },
  "vitesse-light": {
    "#a0ada0": "#677767", // comments (was 2.3:1)
    "#999999": "#737373", // brackets, delimiters
    "#59873a": "#527d36", // entity names
    "#b56959": "#ab5d4c", // strings
    "#b5695977": "#ab5d4c", // string quotes
    "#99841877": "#7c7136", // property-key quotes
    "#998418": "#827013", // support
    "#b07d48": "#956a3d", // attribute names
    "#2e8f82": "#297e73", // primitive types
    "#bda437": "#837226", // regexp escapes
    "#e36209": "#bd5208", // markup.changed
    "#393a3490": "#72736f", // markdown link URLs
  },
};

/** Highlighted HTML for a code block, or null until the highlighter is ready. */
export function highlightCode(code: string, lang: string): string | null {
  const h = _highlighter;
  if (!h) return null;
  const opts = { themes: CODE_THEMES, defaultColor: "light", colorReplacements: COLOR_REPLACEMENTS } as const;
  try {
    return h.codeToHtml(code, { lang, ...opts });
  } catch {
    // Unknown language - fall back to plain text.
    return h.codeToHtml(code, { lang: "text", ...opts });
  }
}

export const highlighterReady: Promise<Highlighter> = createHighlighter({
  themes: [CODE_THEMES.light, CODE_THEMES.dark],
  langs: [
    "typescript", "tsx", "javascript", "jsx",
    "python", "rust", "go", "java", "c", "cpp", "csharp",
    "bash", "sh", "powershell",
    "json", "yaml", "toml",
    "html", "css", "scss",
    "sql", "graphql",
    "markdown", "mdx",
    "diff", "text",
  ],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
}).then((h) => {
  _highlighter = h;
  return h;
});

export function getHighlighter(): Highlighter | null {
  return _highlighter;
}
