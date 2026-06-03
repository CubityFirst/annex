import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { CodeFenceWidget } from "../../widgets/CodeFenceWidget";
import { MermaidWidget } from "../../widgets/MermaidWidget";

export const visitCodeFence: Visitor = ({ node, state, sel, reveal, decos }) => {
  const startLine = state.doc.lineAt(node.from);
  const endLine = state.doc.lineAt(Math.min(node.to, state.doc.length));
  const cursorIn = reveal && cursorTouches(sel, node.from, node.to);

  if (cursorIn) {
    // Cursor inside — show raw lines so the user can edit. Each line gets
    // monospace + tinted bg so it reads as code while editing.
    for (let n = startLine.number; n <= endLine.number; n++) {
      const line = state.doc.line(n);
      const classes = [
        "cm-code-line",
        n === startLine.number ? "cm-code-line--first" : "",
        n === endLine.number ? "cm-code-line--last" : "",
      ].filter(Boolean).join(" ");
      decos.push(Decoration.line({ class: classes }).range(line.from));
    }
    return;
  }

  // Cursor outside — render Shiki-highlighted widget for the whole block.
  let lang = "text";
  let codeFrom: number | null = null;
  let codeTo: number | null = null;
  let cur = node.node.firstChild;
  while (cur) {
    if (cur.name === "CodeInfo") {
      lang = state.doc.sliceString(cur.from, cur.to).trim() || "text";
    } else if (cur.name === "CodeText") {
      codeFrom = cur.from;
      codeTo = cur.to;
    }
    cur = cur.nextSibling;
  }
  const code = codeFrom !== null && codeTo !== null
    ? state.doc.sliceString(codeFrom, codeTo)
    : "";

  // Mermaid renders an async SVG diagram (React); everything else is static
  // highlighted HTML and uses the lightweight plain-DOM widget.
  const widget = lang === "mermaid" ? new MermaidWidget(code) : new CodeFenceWidget(lang, code);

  decos.push(
    Decoration.replace({
      widget,
      block: true,
    }).range(startLine.from, endLine.to),
  );
};
