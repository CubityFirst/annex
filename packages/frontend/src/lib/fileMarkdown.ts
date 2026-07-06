import { fileKind } from "./fileKind";

// Markdown snippet that embeds a stored file in a document - what the "Copy
// markdown" actions in FilePage and FileManager put on the clipboard.
//
//   • image/audio - inline media syntax. The alt text MUST be the filename:
//     internal file URLs carry no extension, so looksLikeAudio() falls back to
//     the alt's extension to tell audio from images.
//   • drawing     - ```excalidraw fence (live read-only canvas embed).
//   • everything else - ```file fence, rendered as a download card by
//     FileEmbedWidget.
export function fileEmbedMarkdown(file: { id: string; name: string; mime_type: string | null }): string {
  const kind = fileKind(file.mime_type, file.name);
  if (kind === "image" || kind === "audio") {
    return `![${file.name}](/api/files/${file.id}/content)`;
  }
  if (kind === "drawing") {
    return "```excalidraw\n" + file.id + "\n```";
  }
  return "```file\n" + file.id + "\n```";
}
