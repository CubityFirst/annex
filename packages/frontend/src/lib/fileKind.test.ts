import { describe, it, expect } from "vitest";
import { fileKind, guessLanguage } from "./fileKind";

describe("fileKind", () => {
  it("classifies images, audio, video, pdf by MIME", () => {
    expect(fileKind("image/png", "a.png")).toBe("image");
    expect(fileKind("audio/mpeg", "a.mp3")).toBe("audio");
    expect(fileKind("video/mp4", "a.mp4")).toBe("video");
    expect(fileKind("application/pdf", "a.pdf")).toBe("pdf");
  });

  it("treats SVG as an image (rendered via <img>), not text", () => {
    expect(fileKind("image/svg+xml", "logo.svg")).toBe("image");
  });

  it("classifies text/code by MIME", () => {
    expect(fileKind("text/plain", "a.txt")).toBe("text");
    expect(fileKind("application/json", "a.json")).toBe("text");
    expect(fileKind("text/markdown", "a.md")).toBe("text");
  });

  it("uses the file name when the browser MIME is misleading", () => {
    // .ts source commonly uploads as video/mp2t - must not render as a video.
    expect(fileKind("video/mp2t", "module.ts")).toBe("text");
    // config/source files often arrive as octet-stream.
    expect(fileKind("application/octet-stream", "config.yaml")).toBe("text");
    expect(fileKind("application/octet-stream", "main.py")).toBe("text");
    expect(fileKind("", "Cargo.toml")).toBe("text");
  });

  it("recognises common extensionless text filenames", () => {
    expect(fileKind("application/octet-stream", "Dockerfile")).toBe("text");
    expect(fileKind("application/octet-stream", "LICENSE")).toBe("text");
    expect(fileKind("application/octet-stream", ".gitignore")).toBe("text");
  });

  it("classifies archives by MIME or extension", () => {
    expect(fileKind("application/zip", "a.zip")).toBe("archive");
    expect(fileKind("application/octet-stream", "bundle.tar.gz")).toBe("archive");
    expect(fileKind("application/x-7z-compressed", "a.7z")).toBe("archive");
  });

  it("classifies .excalidraw drawings by extension, never as text", () => {
    // Browsers hand .excalidraw up as JSON or octet-stream - neither must win
    // over the drawing classification (else it'd render as a JSON code block).
    expect(fileKind("application/json", "diagram.excalidraw")).toBe("drawing");
    expect(fileKind("application/octet-stream", "diagram.excalidraw")).toBe("drawing");
    expect(fileKind("", "diagram.excalidraw")).toBe("drawing");
    expect(fileKind("application/vnd.excalidraw+json", "diagram.excalidraw")).toBe("drawing");
    expect(fileKind("application/json", "diagram.excalidraw")).not.toBe("text");
  });

  it("falls back to 'other' for unknown binary", () => {
    expect(fileKind("application/octet-stream", "data.bin")).toBe("other");
    expect(fileKind("", "")).toBe("other");
  });

  it("ignores MIME parameters and case", () => {
    expect(fileKind("TEXT/PLAIN; charset=utf-8", "a.txt")).toBe("text");
    expect(fileKind("Image/PNG", "a.png")).toBe("image");
  });
});

describe("guessLanguage", () => {
  it("maps known extensions to Shiki grammars", () => {
    expect(guessLanguage("module.ts")).toBe("typescript");
    expect(guessLanguage("component.tsx")).toBe("tsx");
    expect(guessLanguage("main.py")).toBe("python");
    expect(guessLanguage("lib.rs")).toBe("rust");
    expect(guessLanguage("config.yaml")).toBe("yaml");
    expect(guessLanguage("Cargo.toml")).toBe("toml");
    expect(guessLanguage("query.sql")).toBe("sql");
  });

  it("defaults to plain text for unknown or extensionless names", () => {
    expect(guessLanguage("data.bin")).toBe("text");
    expect(guessLanguage("notes.csv")).toBe("text");
    expect(guessLanguage("Dockerfile")).toBe("text");
  });
});
