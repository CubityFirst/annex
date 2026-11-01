import { describe, it, expect } from "vitest";
import { ConfigError, DEFAULT_API_URL, keyLabel, loadConfig, parseApiUrl, parseKeys } from "./config.js";

const A = "annx_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "annx_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "annx_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

describe("parseKeys", () => {
  it("accepts commas, whitespace and newlines, with optional aliases", () => {
    expect(parseKeys(`${A}, handbook=${B}\n  wiki=${C}`)).toEqual([
      { alias: null, secret: A },
      { alias: "handbook", secret: B },
      { alias: "wiki", secret: C },
    ]);
  });

  it("dedupes the same key listed twice", () => {
    expect(parseKeys(`${A},${A}`)).toHaveLength(1);
  });

  it("rejects non-keys without echoing them", () => {
    try {
      parseKeys("eyJhbGciOi.secret.jwt");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain("eyJhbGciOi");
    }
    expect(() => parseKeys("annx_short")).toThrow(ConfigError);
  });

  it("rejects bad and duplicate aliases", () => {
    expect(() => parseKeys(`bad alias=${A}`)).toThrow(ConfigError); // space splits → "alias=..." ok, "bad" not a key
    expect(() => parseKeys(`no#hash=${A}`)).toThrow(/entry #1 has an invalid alias/);
    expect(() => parseKeys(`no#hash=${A}`)).not.toThrow(/no#hash/);
    expect(() => parseKeys(`x=${A},X=${B}`)).toThrow(/entry #2 repeats an alias/);
  });

  it("rejects a key pasted as an alias without echoing any of it", () => {
    for (const raw of [`${A}=${B}`, `ANNX_${A.slice(5)}=${B}`]) {
      try {
        parseKeys(raw);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const msg = (err as Error).message;
        expect(msg).toMatch(/entry #1 has an API key as its alias/);
        expect(msg).not.toContain(A.slice(5, 11)); // no part of the random body
        expect(msg).not.toContain(B.slice(5, 11));
      }
    }
  });
});

describe("parseApiUrl", () => {
  it("defaults to the hosted API and strips trailing slashes", () => {
    expect(parseApiUrl(undefined)).toBe(DEFAULT_API_URL);
    expect(parseApiUrl("https://docs.example.com/api///")).toBe("https://docs.example.com/api");
  });

  it("refuses cleartext http except on loopback", () => {
    expect(() => parseApiUrl("http://docs.example.com/api")).toThrow(/https/);
    expect(parseApiUrl("http://localhost:5173/api")).toBe("http://localhost:5173/api");
    expect(parseApiUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });

  it("rejects garbage, query strings and fragments", () => {
    expect(() => parseApiUrl("not a url")).toThrow(ConfigError);
    expect(() => parseApiUrl("https://x.example/api?k=1")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("merges ANNEX_API_KEY with ANNEX_API_KEYS", () => {
    const cfg = loadConfig({ ANNEX_API_KEY: A, ANNEX_API_KEYS: `b=${B}` });
    expect(cfg.keys.map(k => k.secret)).toEqual([A, B]);
    expect(cfg.readOnly).toBe(false);
  });

  it("requires at least one key", () => {
    expect(() => loadConfig({})).toThrow(/No API keys/);
  });

  it("parses the read-only switch", () => {
    expect(loadConfig({ ANNEX_API_KEY: A, ANNEX_MCP_READ_ONLY: "true" }).readOnly).toBe(true);
    expect(loadConfig({ ANNEX_API_KEY: A, ANNEX_MCP_READ_ONLY: "0" }).readOnly).toBe(false);
  });
});

describe("keyLabel", () => {
  it("shows only the display prefix", () => {
    expect(keyLabel(A)).toBe("annx_AAAAAA…");
    expect(keyLabel(A)).not.toContain(A.slice(12));
  });
});
