/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { stripDefaultMeta } from "./index";

// Vitest runs with the package root as cwd.
const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

describe("stripDefaultMeta", () => {
  it("index.html carries default OG meta inside the markers", () => {
    expect(indexHtml).toContain("<!-- default-meta");
    expect(indexHtml).toContain("<!-- /default-meta -->");
    expect(indexHtml).toMatch(/<!-- default-meta[\s\S]*og:image[\s\S]*<!-- \/default-meta -->/);
  });

  it("removes every default description / og / twitter tag from the real index.html", () => {
    const stripped = stripDefaultMeta(indexHtml);
    expect(stripped).not.toContain("default-meta");
    expect(stripped).not.toMatch(/property="og:/);
    expect(stripped).not.toMatch(/name="twitter:/);
    expect(stripped).not.toMatch(/name="description"/);
  });

  it("leaves the rest of the document intact", () => {
    const stripped = stripDefaultMeta(indexHtml);
    expect(stripped).toContain("<title>");
    expect(stripped).toContain('<div id="app"></div>');
    expect(stripped).toContain("</head>");
  });

  it("is a no-op when the markers are absent", () => {
    const html = "<html><head><title>x</title></head></html>";
    expect(stripDefaultMeta(html)).toBe(html);
  });
});
