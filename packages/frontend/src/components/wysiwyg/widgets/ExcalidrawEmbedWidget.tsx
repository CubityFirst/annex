import { lazy, Suspense, createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { useRendererCtx } from "../context/RendererContext";
import { isSafeFileId } from "./fileId";
import { useDocumentTheme } from "./useDocumentTheme";
import { apiFetch } from "@/lib/apiFetch";
import { Spinner } from "@/components/ui/spinner";

// A ```excalidraw fenced block whose body is a drawing file id renders that
// drawing inline as a live, read-only canvas - the same ExcalidrawCanvas used by
// FilePage/PublicDocPage, just embedded in the document flow. Heavy chunk, so
// (like those call sites) it's lazily code-split and never lands in the main
// bundle.
const ExcalidrawCanvas = lazy(() => import("@/components/ExcalidrawCanvas"));

function ExcalidrawEmbedInner({ fileId }: { fileId: string }): ReactElement {
  const ctx = useRendererCtx();
  // The widget mounts in a detached React root that only carries
  // RendererReactContext (not the app's ThemeProvider), so read the theme off
  // the document element - subscribed, so theme toggles restyle mounted embeds.
  const theme = useDocumentTheme();

  // Fence bodies are author-controlled text; only an id-shaped body may be
  // interpolated into an API path (encodeURIComponent is belt-and-braces).
  if (!isSafeFileId(fileId)) {
    return (
      <div className="cm-excalidraw-embed">
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Drawing unavailable.
        </div>
      </div>
    );
  }
  const encodedId = encodeURIComponent(fileId);

  // Same content-URL + fetcher split the existing mounts use (FilePage.tsx,
  // PublicDocPage.tsx): authed apiFetch in the app, plain fetch for published
  // content (which needs no auth header).
  const contentUrl = ctx.isPublic
    ? `/api/public/files/${encodedId}/content?projectId=${encodeURIComponent(ctx.projectId ?? "")}`
    : `/api/files/${encodedId}/content`;
  const fetcher = ctx.isPublic
    ? (u: string, init?: RequestInit) => fetch(u, init)
    : (u: string, init?: RequestInit) => apiFetch(u, init);

  return (
    <div className="cm-excalidraw-embed">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading drawing…
          </div>
        }
      >
        <ExcalidrawCanvas
          contentUrl={contentUrl}
          fetcher={fetcher}
          readOnly
          name="Embedded drawing"
          theme={theme}
        />
      </Suspense>
    </div>
  );
}

export class ExcalidrawEmbedWidget extends ReactWidget {
  protected tag: "div" = "div";

  constructor(private readonly fileId: string) {
    super();
  }

  protected rootClass(): string {
    return "cm-codefence-widget-root";
  }

  protected render(): ReactElement {
    return createElement(ExcalidrawEmbedInner, { fileId: this.fileId });
  }

  // Deliberately NOT revealOnClick: the canvas is interactive, so we let
  // Excalidraw own all pointer events (pan/zoom) rather than have the base
  // widget preventDefault and move the cursor. The author edits/removes the
  // block by arrowing the cursor into its range (keyboard reveal still fires in
  // codeFence.ts) - matching the dice/wikilink interactive-widget convention.

  // styles.css pins .cm-excalidraw-embed to height: 480px (+ 1px borders).
  get estimatedHeight(): number {
    return 482;
  }

  eq(other: WidgetType): boolean {
    return other instanceof ExcalidrawEmbedWidget && other.fileId === this.fileId;
  }
}
