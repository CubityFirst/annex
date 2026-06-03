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

export const highlighterReady: Promise<Highlighter> = createHighlighter({
  themes: ["github-dark-dimmed"],
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
