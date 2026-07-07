import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { eachLine } from "../helpers";
import { CodeFenceWidget } from "../../widgets/CodeFenceWidget";
import { MermaidWidget } from "../../widgets/MermaidWidget";
import { ExcalidrawEmbedWidget } from "../../widgets/ExcalidrawEmbedWidget";
import { FileEmbedWidget } from "../../widgets/FileEmbedWidget";
import { JuxtaposeWidget } from "../../widgets/JuxtaposeWidget";
import { parseJuxtapose } from "@/lib/juxtapose";

export const visitCodeFence: Visitor = ({ node, state, sel, reveal, decos }) => {
  const startLine = state.doc.lineAt(node.from);
  const endLine = state.doc.lineAt(node.to);
  const cursorIn = reveal && cursorTouches(sel, node.from, node.to);

  if (cursorIn) {
    // Cursor inside - show raw lines so the user can edit. Each line gets
    // monospace + tinted bg so it reads as code while editing.
    eachLine(state, node, (line) => {
      const classes = [
        "cm-code-line",
        line.number === startLine.number ? "cm-code-line--first" : "",
        line.number === endLine.number ? "cm-code-line--last" : "",
      ].filter(Boolean).join(" ");
      decos.push(Decoration.line({ class: classes }).range(line.from));
    });
    return;
  }

  // Cursor outside - render Shiki-highlighted widget for the whole block.
  // The language is the FIRST word of the info string, lowercased - trailing
  // meta (```js title=x) must not break Shiki or the special-fence matches.
  let lang = "text";
  const codeParts: string[] = [];
  let cur = node.node.firstChild;
  while (cur) {
    if (cur.name === "CodeInfo") {
      const info = state.doc.sliceString(cur.from, cur.to).trim();
      lang = info.split(/\s+/)[0]!.toLowerCase() || "text";
    } else if (cur.name === "CodeText") {
      // A fence inside a blockquote/callout emits one CodeText node PER LINE
      // (each slice keeps its trailing newline; the quote markers sit between
      // them as QuoteMark siblings). Concatenating every slice reconstructs
      // the full code for both the quoted and the plain single-node case.
      codeParts.push(state.doc.sliceString(cur.from, cur.to));
    }
    cur = cur.nextSibling;
  }
  const code = codeParts.join("");

  // A `juxtapose` fence is a before/after image comparison slider, not code.
  // Reading mode (reveal === false) gets the interactive draggable widget;
  // editing mode gets a static preview that reveals the raw block on click.
  // An unparseable block falls through to normal code-fence rendering.
  if (lang === "juxtapose") {
    const cfg = parseJuxtapose(code);
    if (cfg) {
      decos.push(
        Decoration.replace({
          widget: new JuxtaposeWidget(cfg, !reveal),
          block: true,
        }).range(startLine.from, endLine.to),
      );
      return;
    }
  }

  // An `excalidraw` fence whose body is a drawing file id embeds that drawing as
  // a live read-only canvas. An empty/blank body falls through to normal
  // code-fence rendering so a half-typed block still reads as code.
  if (lang === "excalidraw") {
    const fileId = code.trim();
    if (fileId) {
      decos.push(
        Decoration.replace({
          widget: new ExcalidrawEmbedWidget(fileId),
          block: true,
        }).range(startLine.from, endLine.to),
      );
      return;
    }
  }

  // A `file` fence whose body is a stored file id embeds a download card for
  // that file (icon + name + size + Download button). Same fallthrough rule as
  // excalidraw: an empty/blank body still renders as a normal code block.
  if (lang === "file") {
    const fileId = code.trim();
    if (fileId) {
      decos.push(
        Decoration.replace({
          widget: new FileEmbedWidget(fileId),
          block: true,
        }).range(startLine.from, endLine.to),
      );
      return;
    }
  }

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
