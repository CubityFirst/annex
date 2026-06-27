// Drives the browser's native print engine to produce a real text PDF
// (selectable text, working hyperlinks, screen-reader accessible). The user
// goes through the browser's print dialog and picks "Save as PDF" as the
// destination. Page size is injected as a transient @page rule; margins and
// scale live in the browser's own dialog.

export type PdfPageSize = "A3" | "A4" | "A5";
export type PdfTheme = "light" | "dark";

export interface PdfExportOptions {
  pageSize: PdfPageSize;
  theme: PdfTheme;
  includeTitle: boolean;
  hideAiSummary: boolean;
  hideLastUpdated: boolean;
  documentName?: string;
}

const STYLE_ID = "pdf-export-page-rule";
const PRINT_CLASS = "pdf-printing";
const PRINT_ROOT_ID = "pdf-print-root";

export function runPdfExport(opts: PdfExportOptions): void {
  const target = document.querySelector<HTMLElement>("[data-pdf-print-target]");
  const app = document.getElementById("app");
  if (!target || !app) {
    console.error("PDF export: print target or app root not found");
    return;
  }

  // Clone the article into a standalone print container appended to <body>.
  // The clone is static DOM (no CodeMirror virtualization), and lives outside
  // the SPA tree so the body's height during print equals the clone's full
  // height - the print engine paginates that correctly. Inside the clone we
  // strip the live editor and force the static markdown mirror visible.
  const clone = target.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".pdf-print-hide").forEach(el => el.remove());
  clone.querySelectorAll<HTMLElement>(".pdf-print-mirror").forEach(el => {
    el.style.display = "block";
  });
  if (!opts.includeTitle) clone.querySelectorAll("[data-pdf-title]").forEach(el => el.remove());
  if (opts.hideAiSummary) clone.querySelectorAll("[data-pdf-ai-summary]").forEach(el => el.remove());
  if (opts.hideLastUpdated) clone.querySelectorAll("[data-pdf-last-updated]").forEach(el => el.remove());

  const printRoot = document.createElement("div");
  printRoot.id = PRINT_ROOT_ID;
  printRoot.appendChild(clone);
  document.body.appendChild(printRoot);

  // Inject a transient @page rule. Chromium honors size and pre-fills its
  // print dialog with it; the user can still tweak margins in that dialog.
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `@page { size: ${opts.pageSize}; }`;
  document.head.appendChild(style);

  const html = document.documentElement;
  const wasDark = html.classList.contains("dark");
  const wantDark = opts.theme === "dark";
  const flipped = wasDark !== wantDark;
  if (flipped) html.classList.toggle("dark", wantDark);

  document.body.classList.add(PRINT_CLASS);

  // Browsers use document.title as the default "Save as PDF" filename, so
  // override it with the document name for the duration of the print pass.
  const originalTitle = document.title;
  const desiredTitle = opts.documentName?.trim();
  const titleChanged = !!desiredTitle && desiredTitle !== originalTitle;
  if (titleChanged) document.title = desiredTitle;

  // Cleanup runs only on afterprint. We deliberately do NOT bind focus here:
  // Chromium's print preview steals/restores window focus while the user
  // adjusts settings, and a focus-based teardown would run partway through,
  // restoring the dark class while later pages are still being rasterized
  // (causing pages 2+ to render with the original theme). A safety timeout
  // recovers state if afterprint never fires (rare browser bug or navigation).
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    document.body.classList.remove(PRINT_CLASS);
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(PRINT_ROOT_ID)?.remove();
    if (flipped) html.classList.toggle("dark", wasDark);
    if (titleChanged) document.title = originalTitle;
    window.removeEventListener("afterprint", cleanup);
    clearTimeout(safetyTimer);
  };
  window.addEventListener("afterprint", cleanup);
  const safetyTimer = setTimeout(cleanup, 5 * 60 * 1000);

  // Defer to the next frame so the print container is laid out before the
  // print engine snapshots the document.
  requestAnimationFrame(() => {
    try {
      window.print();
    } catch {
      cleanup();
    }
  });
}
