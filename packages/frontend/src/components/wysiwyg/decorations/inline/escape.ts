import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";

// A backslash escape (`\*literal\*`) - hide the backslash so rendered text
// shows just the escaped character. Cursor on the escape reveals the source.
export const visitEscape: Visitor = ({ node, sel, reveal, decos }) => {
  if (reveal && cursorTouches(sel, node.from, node.to)) return;
  decos.push(Decoration.replace({}).range(node.from, node.from + 1));
};
