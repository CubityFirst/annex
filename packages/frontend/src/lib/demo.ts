// Demo mode - a try-before-you-register sandbox entered via /demo (linked from
// the landing page's "See a demo"). While the sessionStorage flag is set,
// main.tsx installs the in-memory mock API (lib/demoServer.ts) before React
// mounts, and getToken() hands out a fake JWT so the authenticated app shell
// boots normally. Everything "saved" in demo mode lives in that mock's memory
// and evaporates on reload / tab close.
//
// Kept deliberately tiny: this module is imported by auth.ts and main.tsx on
// every boot, so it must not pull in the demo dataset (that's dynamically
// imported only when the flag is set).

const DEMO_FLAG = "annex-demo";

function getStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function isDemoMode(): boolean {
  return getStorage()?.getItem(DEMO_FLAG) === "1";
}

export function enterDemoMode(): void {
  getStorage()?.setItem(DEMO_FLAG, "1");
}

export function exitDemoMode(): void {
  getStorage()?.removeItem(DEMO_FLAG);
}

export const DEMO_USER_ID = "demo-user";
export const DEMO_USER_NAME = "Demo User";
export const DEMO_USER_EMAIL = "demo@annex.local";

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Unsigned JWT-shaped token. It never reaches a real server (the demo fetch
// patch answers every /api call), but code that base64-decodes the payload -
// e.g. parseToken in SiteSettingsPage - gets sensible values out of it.
export const DEMO_TOKEN = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
  JSON.stringify({ userId: DEMO_USER_ID, email: DEMO_USER_EMAIL }),
)}.demo`;
