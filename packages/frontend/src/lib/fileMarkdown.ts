import { fileKind } from "./fileKind";
import { isAudioUrl } from "./audioUrl";

// Markdown snippet that embeds a stored file in a document - what the "Copy
// markdown" actions in FilePage and FileManager put on the clipboard.
//
//   • image/audio - inline media syntax. The alt text MUST be the filename:
//     internal file URLs carry no extension, so looksLikeAudio() falls back to
//     the alt's extension to tell audio from images. Audio whose filename has
//     no audio extension can't be disambiguated that way (it would render as a
//     broken image), so it falls through to the download-card fence instead.
//   • drawing     - ```excalidraw fence (live read-only canvas embed).
//   • everything else - ```file fence, rendered as a download card by
//     FileEmbedWidget.

// The filename lands in the alt slot of `![alt](url)`. Substitute (not
// backslash-escape) the characters that would end or restructure the link -
// "]" closes the alt early (`x](http://evil)` escapes the embed), "[" opens a
// nested link, and a trailing "\" would swallow our own closing bracket.
// Substitution over escaping because the editor's own renderers (IMG_RE in
// wysiwyg decorations, TableWidget) match the alt with `[^\]]*`, which can
// never contain even an escaped "]" - an escaped name would fall back to raw
// markdown text. Brackets become parens (safe in the alt slot - only the URL
// slot cares, and ours is fixed); the extension follows the substitutions
// untouched, so looksLikeAudio()'s alt-extension fallback still sees it.
function escapeAlt(name: string): string {
  return name.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\\/g, "_");
}

export function fileEmbedMarkdown(file: { id: string; name: string; mime_type: string | null }): string {
  const kind = fileKind(file.mime_type, file.name);
  if (kind === "image" || (kind === "audio" && isAudioUrl(file.name))) {
    return `![${escapeAlt(file.name)}](/api/files/${file.id}/content)`;
  }
  if (kind === "drawing") {
    return "```excalidraw\n" + file.id + "\n```";
  }
  return "```file\n" + file.id + "\n```";
}
