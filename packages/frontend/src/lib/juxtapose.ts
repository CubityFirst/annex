// Parser for the `juxtapose` fenced-code block - a before/after image
// comparison slider (à la juxtapose.knightlab.com). The block body is a small
// `key: value` config:
//
//   ```juxtapose
//   before: /api/files/abc.jpg "2019"
//   after:  /api/files/def.jpg "2024"
//   orientation: horizontal
//   start: 50
//   ```
//
// `before`/`after` take a URL followed by an optional quoted label. `orientation`
// is horizontal (default) or vertical. `start` is the initial divider position
// (0–100, default 50). Both images are required; anything else returns null so
// the caller can fall back to rendering a plain code fence.

export type JuxtaposeHandle = "arrows" | "bar";

export interface JuxtaposeConfig {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  orientation: "horizontal" | "vertical";
  /** Initial divider position, 0–100. */
  startAt: number;
  /** Handle shape. Default "arrows" (circle + chevrons). */
  handle: JuxtaposeHandle;
  /**
   * Handle/divider colour. Absent → the original white look. The literal
   * "theme" → the site theme accent (--primary). A #rgb / #rrggbb → custom.
   */
  accent?: "theme" | string;
}

const LINE_RE = /^(before|after|orientation|start|handle|accent)\s*:\s*(.*)$/i;
// URL is the first whitespace-delimited token; an optional "quoted" label follows.
const URL_LABEL_RE = /^(\S+)(?:\s+"([^"]*)")?\s*$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function clamp(n: number): number {
  return Math.min(100, Math.max(0, n));
}

export function parseJuxtapose(src: string): JuxtaposeConfig | null {
  let before: string | undefined;
  let after: string | undefined;
  let beforeLabel: string | undefined;
  let afterLabel: string | undefined;
  let orientation: "horizontal" | "vertical" = "horizontal";
  let startAt = 50;
  let handle: JuxtaposeHandle = "arrows";
  let accent: string | undefined;

  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();

    if (key === "before" || key === "after") {
      const um = value.match(URL_LABEL_RE);
      if (!um) continue;
      const url = um[1]!;
      const label = um[2];
      if (key === "before") {
        before = url;
        beforeLabel = label || undefined;
      } else {
        after = url;
        afterLabel = label || undefined;
      }
    } else if (key === "orientation") {
      orientation = value.toLowerCase().startsWith("v") ? "vertical" : "horizontal";
    } else if (key === "start") {
      const n = parseFloat(value);
      if (!Number.isNaN(n)) startAt = clamp(n);
    } else if (key === "handle") {
      handle = value.toLowerCase() === "bar" ? "bar" : "arrows";
    } else if (key === "accent") {
      const v = value.toLowerCase();
      if (v === "theme" || v === "accent") accent = "theme";
      else if (HEX_RE.test(value)) accent = v;
    }
  }

  if (!before || !after) return null;
  return { before, after, beforeLabel, afterLabel, orientation, startAt, handle, accent };
}
