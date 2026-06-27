import { describe, it, expect } from "vitest";
import { isAudioUrl, looksLikeAudio, parseAudioSize } from "./audioUrl";

describe("isAudioUrl", () => {
  it("returns true for common audio extensions", () => {
    expect(isAudioUrl("track.mp3")).toBe(true);
    expect(isAudioUrl("track.wav")).toBe(true);
    expect(isAudioUrl("track.flac")).toBe(true);
    expect(isAudioUrl("track.ogg")).toBe(true);
    expect(isAudioUrl("track.oga")).toBe(true);
    expect(isAudioUrl("track.m4a")).toBe(true);
    expect(isAudioUrl("track.aac")).toBe(true);
    expect(isAudioUrl("track.opus")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAudioUrl("Track.MP3")).toBe(true);
    expect(isAudioUrl("song.FLAC")).toBe(true);
  });

  it("returns false for images and other types", () => {
    expect(isAudioUrl("photo.png")).toBe(false);
    expect(isAudioUrl("doc.pdf")).toBe(false);
    expect(isAudioUrl("clip.mp4")).toBe(false);
    expect(isAudioUrl("notes.txt")).toBe(false);
  });

  it("returns false for empty/missing inputs", () => {
    expect(isAudioUrl("")).toBe(false);
    expect(isAudioUrl(undefined)).toBe(false);
    expect(isAudioUrl(null)).toBe(false);
  });

  it("ignores query strings and fragments", () => {
    expect(isAudioUrl("track.mp3?v=2")).toBe(true);
    expect(isAudioUrl("track.flac#t=10")).toBe(true);
    expect(isAudioUrl("/api/files/abc.mp3?projectId=x")).toBe(true);
  });

  it("handles full URLs", () => {
    expect(isAudioUrl("https://example.com/path/song.mp3")).toBe(true);
    expect(isAudioUrl("https://example.com/song")).toBe(false);
  });
});

describe("looksLikeAudio", () => {
  it("returns true when the URL itself has an audio extension", () => {
    expect(looksLikeAudio("https://x.com/song.mp3")).toBe(true);
  });

  it("falls back to the alt text when the URL has no extension", () => {
    // Copy-markdown emits ![filename.mp3](/api/files/UUID/content) - the URL
    // path has no extension because /content is the route suffix.
    expect(looksLikeAudio("/api/files/abc/content", "track.mp3")).toBe(true);
  });

  it("returns false when neither URL nor alt looks like audio", () => {
    expect(looksLikeAudio("/api/files/abc/content", "screenshot.png")).toBe(false);
    expect(looksLikeAudio("/api/files/abc/content")).toBe(false);
  });

  it("does not promote an image URL to audio because of an audio-named alt", () => {
    // The URL has an unambiguous image extension - trust it over the alt.
    expect(looksLikeAudio("photo.png", "song.mp3")).toBe(false);
    expect(looksLikeAudio("photo.png", "caption")).toBe(false);
  });
});

describe("parseAudioSize", () => {
  it("returns 'small' for 'small'", () => {
    expect(parseAudioSize("small")).toBe("small");
  });

  it("defaults to 'full' for anything else", () => {
    expect(parseAudioSize("full")).toBe("full");
    expect(parseAudioSize(undefined)).toBe("full");
    expect(parseAudioSize(null)).toBe("full");
    expect(parseAudioSize("")).toBe("full");
    expect(parseAudioSize("jumbo")).toBe("full");
  });
});
