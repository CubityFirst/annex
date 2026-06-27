// Central file-type classifier shared by the file listing (FileManager), the
// file viewer (FilePage), and the public site (PublicDocPage). Two jobs:
//   • fileKind()     - coarse category that drives the icon and which inline
//                      preview (if any) a file gets.
//   • guessLanguage() - Shiki grammar id for the text/code preview.
//
// Detection leans on the file *name* before the MIME type, because browsers hand
// out unreliable MIME for source and config files: a `.ts` TypeScript file
// usually arrives as `video/mp2t` (which would otherwise render in the <video>
// player), and `.yaml`/`.toml`/`.csv`/`.py`/… commonly arrive as
// `application/octet-stream` (which would otherwise fall through to download-only).

export type FileKind = "image" | "audio" | "video" | "pdf" | "text" | "archive" | "drawing" | "other";

// ext → Shiki grammar. Only grammars actually loaded in lib/shiki.ts appear here;
// anything else resolves to "text" (plain, but still inside a styled code block).
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", pyi: "python",
  rs: "rust", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", psm1: "powershell",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml", toml: "toml",
  html: "html", htm: "html", css: "css", scss: "scss",
  sql: "sql", graphql: "graphql", gql: "graphql",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  diff: "diff", patch: "diff",
};

// Plain-text extensions that have no dedicated grammar but should still preview
// as text rather than download. (Deliberately excludes `svg` - that renders as
// an image.)
const PLAIN_TEXT_EXTENSIONS = new Set([
  "txt", "text", "log", "csv", "tsv", "xml",
  "env", "ini", "conf", "cfg", "properties",
  "gitignore", "gitattributes", "editorconfig", "npmrc", "nvmrc",
]);

// Extensionless filenames that are conventionally plain text.
const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "license", "readme", "changelog",
  "authors", "copying", "notice", "gemfile", "rakefile", "procfile",
]);

const ARCHIVE_EXTENSIONS = new Set([
  "zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "7z", "rar", "zst",
]);

// Excalidraw native scene files - edited in place by the drawing editor and
// rendered as a live canvas, never previewed as JSON text. Name-based only
// (browsers hand .excalidraw up as application/json or application/octet-stream).
const DRAWING_EXTENSIONS = new Set(["excalidraw"]);

const TEXT_EXTENSIONS = new Set<string>([
  ...Object.keys(EXT_TO_LANG),
  ...PLAIN_TEXT_EXTENSIONS,
]);

function baseName(name: string): string {
  return (name || "").toLowerCase().split(/[\\/]/).pop() ?? "";
}

function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";              // no extension
  if (dot === 0) return base.slice(1); // dotfile: ".gitignore" → "gitignore"
  return base.slice(dot + 1);
}

export function fileKind(mimeType: string | null | undefined, name = ""): FileKind {
  const mime = (mimeType ?? "").toLowerCase().split(";")[0]!.trim();
  const base = baseName(name);
  const ext = extensionOf(base);

  // Name-based detection wins over MIME (see file header). Drawings first, so a
  // .excalidraw (often application/json) never falls through to the text preview.
  if (DRAWING_EXTENSIONS.has(ext)) return "drawing";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(base)) return "text";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/javascript") return "text";
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("gzip") || mime.includes("archive")) return "archive";
  return "other";
}

// Shiki grammar id for a file name, for the text/code preview. Unknown or
// extensionless names fall back to "text" (CodeBlock also tolerates this).
export function guessLanguage(name: string): string {
  return EXT_TO_LANG[extensionOf(baseName(name))] ?? "text";
}
