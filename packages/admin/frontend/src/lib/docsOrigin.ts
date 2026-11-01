// The docs app origin, for deep-linking from the admin panel into the app
// (same DEV/prod split as lib/handoff.ts).
export const DOCS_APP_ORIGIN = import.meta.env.DEV
  ? "http://localhost:5173"
  : "https://docs.cubityfir.st";
