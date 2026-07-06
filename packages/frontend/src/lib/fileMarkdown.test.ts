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

  it("substitutes markdown-breaking characters in the filename alt", () => {
    // "]" would close the alt early ("x](http://evil)" breaks out of the
    // embed); "[" opens a nested link; a trailing "\" would swallow the
    // closing bracket. Substituted (brackets → parens, backslash → _) rather
    // than backslash-escaped: the wysiwyg IMG_RE matches alt with [^\]]* and
    // can never render an escaped "]".
    expect(fileEmbedMarkdown({ id: "f8", name: "shot ](evil).png", mime_type: "image/png" }))
      .toBe("![shot )(evil).png](/api/files/f8/content)");
    expect(fileEmbedMarkdown({ id: "f9", name: "a[b].png", mime_type: "image/png" }))
      .toBe("![a(b).png](/api/files/f9/content)");
    expect(fileEmbedMarkdown({ id: "f10", name: "back\\slash.png", mime_type: "image/png" }))
      .toBe("![back_slash.png](/api/files/f10/content)");
    // The produced alt can never break out of its slot or defeat [^\]]*.
    for (const name of ["shot ](evil).png", "a[b].png", "back\\slash.png", "x]](http://e).png"]) {
      const md = fileEmbedMarkdown({ id: "fx", name, mime_type: "image/png" });
      expect(md).toMatch(/^!\[[^\]]*\]\(\/api\/files\/fx\/content\)$/);
    }
  });

  it("substitution leaves the trailing extension intact for audio disambiguation", () => {
    // looksLikeAudio() reads the alt's extension because the URL has none;
    // the substitutions sit before the final ".mp3" so detection still works.
    expect(fileEmbedMarkdown({ id: "f11", name: "so[ng].mp3", mime_type: "audio/mpeg" }))
      .toBe("![so(ng).mp3](/api/files/f11/content)");
  });

  it("audio without an audio extension falls back to the download-card fence", () => {
    // The URL carries no extension, so only the alt (filename) extension can
    // flag audio; an extensionless name would render as a broken image, so
    // emit the file card instead.
    expect(fileEmbedMarkdown({ id: "f12", name: "voicenote", mime_type: "audio/mpeg" }))
      .toBe("```file\nf12\n```");
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
