import { describe, it, expect } from "vitest";
import { fileEmbedMarkdown } from "./fileMarkdown";

describe("fileEmbedMarkdown", () => {
  it("images use inline media syntax with the filename as alt", () => {
    expect(fileEmbedMarkdown({ id: "f1", name: "photo.png", mime_type: "image/png" }))
      .toBe("![photo.png](/api/files/f1/content)");
  });

  it("audio uses inline media syntax (alt extension drives audio detection)", () => {
    expect(fileEmbedMarkdown({ id: "f2", name: "song.mp3", mime_type: "audio/mpeg" }))
      .toBe("![song.mp3](/api/files/f2/content)");
  });

  it("drawings use the excalidraw fence", () => {
    expect(fileEmbedMarkdown({ id: "f3", name: "sketch.excalidraw", mime_type: "application/json" }))
      .toBe("```excalidraw\nf3\n```");
  });

  it("other kinds use the file (download card) fence", () => {
    expect(fileEmbedMarkdown({ id: "f4", name: "report.pdf", mime_type: "application/pdf" }))
      .toBe("```file\nf4\n```");
    expect(fileEmbedMarkdown({ id: "f5", name: "bundle.zip", mime_type: "application/zip" }))
      .toBe("```file\nf5\n```");
    expect(fileEmbedMarkdown({ id: "f6", name: "clip.mp4", mime_type: "video/mp4" }))
      .toBe("```file\nf6\n```");
    expect(fileEmbedMarkdown({ id: "f7", name: "mystery.bin", mime_type: null }))
      .toBe("```file\nf7\n```");
  });
});
