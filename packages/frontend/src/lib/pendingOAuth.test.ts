import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { storePendingOAuthNext, consumePendingOAuthNext, clearPendingOAuthNext } from "./pendingOAuth";

const KEY = "pendingOAuthNext";
const AUTHORIZE_PATH = "/oauth/authorize?client_id=app1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&code_challenge=abc";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pendingOAuth", () => {
  it("round-trips an authorize path through store/consume", () => {
    storePendingOAuthNext(AUTHORIZE_PATH);
    expect(consumePendingOAuthNext()).toBe(AUTHORIZE_PATH);
  });

  it("consume is single-use", () => {
    storePendingOAuthNext(AUTHORIZE_PATH);
    consumePendingOAuthNext();
    expect(consumePendingOAuthNext()).toBeNull();
  });

  it("refuses to store anything but an /oauth/authorize path", () => {
    storePendingOAuthNext("/dashboard");
    storePendingOAuthNext("https://evil.example/oauth/authorize");
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(consumePendingOAuthNext()).toBeNull();
  });

  it("rejects a tampered stash pointing outside /oauth/authorize", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ next: "//evil.example/", expiresAt: Date.now() + 60_000 }));
    expect(consumePendingOAuthNext()).toBeNull();
  });

  it("expires after an hour", () => {
    vi.useFakeTimers();
    storePendingOAuthNext(AUTHORIZE_PATH);
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(consumePendingOAuthNext()).toBeNull();
  });

  it("tolerates garbage in the storage slot", () => {
    window.localStorage.setItem(KEY, "not json {");
    expect(consumePendingOAuthNext()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("clear removes the stash", () => {
    storePendingOAuthNext(AUTHORIZE_PATH);
    clearPendingOAuthNext();
    expect(consumePendingOAuthNext()).toBeNull();
  });
});
