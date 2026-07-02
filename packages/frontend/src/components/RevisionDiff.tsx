// Read-only unified diff between two versions of a document's markdown,
// powered by @codemirror/merge. This module is loaded via React.lazy from
// DocPage (same pattern as ExcalidrawCanvas) so the merge package stays out
// of the main bundle.

import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { unifiedMergeView } from "@codemirror/merge";

interface Props {
  /** The older text (deletions are shown relative to this). */
  original: string;
  /** The newer text (this is the document rendered in the view). */
  modified: string;
  className?: string;
}

function diffTheme(dark: boolean) {
  const inserted = dark ? "rgba(34, 197, 94, 0.13)" : "rgba(34, 197, 94, 0.11)";
  const insertedText = dark ? "rgba(34, 197, 94, 0.32)" : "rgba(34, 197, 94, 0.28)";
  const deleted = dark ? "rgba(239, 68, 68, 0.13)" : "rgba(239, 68, 68, 0.09)";
  const deletedText = dark ? "rgba(239, 68, 68, 0.35)" : "rgba(239, 68, 68, 0.26)";
  return EditorView.theme({
    "&": {
      backgroundColor: "transparent",
      fontSize: "0.8125rem",
      color: "var(--foreground)",
    },
    ".cm-content": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
      padding: "8px 0",
      caretColor: "transparent",
    },
    ".cm-line": { padding: "0 10px" },
    "&.cm-focused": { outline: "none" },
    ".cm-changedLine": { backgroundColor: inserted },
    ".cm-changedText": { background: insertedText },
    ".cm-deletedChunk": { backgroundColor: deleted, paddingLeft: "10px" },
    ".cm-deletedChunk .cm-deletedText": { background: deletedText },
    ".cm-collapsedLines": {
      color: "var(--muted-foreground)",
      background: "var(--muted)",
      padding: "4px 10px",
    },
    ".cm-changeGutter": { width: "4px" },
  }, { dark });
}

export default function RevisionDiff({ original, modified, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const identical = original === modified;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || identical) return;
    const dark = document.documentElement.classList.contains("dark");
    const view = new EditorView({
      state: EditorState.create({
        doc: modified,
        extensions: [
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          unifiedMergeView({
            original,
            mergeControls: false,
            gutter: true,
            collapseUnchanged: { margin: 3, minSize: 6 },
          }),
          diffTheme(dark),
        ],
      }),
      parent: host,
    });
    return () => view.destroy();
  }, [original, modified, identical]);

  if (identical) {
    return (
      <p className={`text-sm text-muted-foreground ${className ?? ""}`}>
        No differences - both versions have identical content.
      </p>
    );
  }

  return <div ref={hostRef} className={`overflow-hidden rounded-lg border border-border ${className ?? ""}`} />;
}
