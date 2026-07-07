import { Decoration, WidgetType } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { eachDirectLine, type MarkRange } from "../helpers";
import { TaskCheckboxWidget } from "../../widgets/TaskCheckboxWidget";

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-list-bullet-marker";
    span.textContent = "•";
    return span;
  }
  eq(other: WidgetType): boolean {
    return other instanceof BulletWidget;
  }
  ignoreEvent(event: Event): boolean {
    if (event.type === "mousedown" || event.type === "click") return false;
    return true;
  }
}

export const visitListItem: Visitor = ({ node, state, sel, reveal, decos }) => {
  const parent = node.node;
  let mark: MarkRange | null = null;
  let taskMarker: MarkRange | null = null;
  for (let cur = parent.firstChild; cur; cur = cur.nextSibling) {
    if (cur.name === "ListMark" && !mark) {
      mark = { from: cur.from, to: cur.to };
    } else if (cur.name === "Task" && !taskMarker) {
      // GFM's parser emits Task/TaskMarker for BOTH bullet and ordered items
      // (`1. [x] done` is a task too) and only at a genuine item start - so
      // the tree replaces the old hand-rolled regex, which both excluded
      // ordered tasks and could match a `[x]` across a line break.
      const tm = cur.getChild("TaskMarker");
      if (tm) taskMarker = { from: tm.from, to: tm.to };
    }
  }
  if (!mark) return;

  const isOrdered = parent.parent?.name === "OrderedList";

  let task: { checked: boolean; hideTo: number } | null = null;
  if (taskMarker) {
    const checked = state.doc.sliceString(taskMarker.from, taskMarker.to).toLowerCase() === "[x]";
    const trailing = state.doc.sliceString(taskMarker.to, taskMarker.to + 1);
    const hideTo = trailing === " " || trailing === "\t" ? taskMarker.to + 1 : taskMarker.to;
    task = { checked, hideTo };
  }

  const lineClass = task
    ? "cm-list-task-item"
    : isOrdered
      ? "cm-list-ordered-item"
      : "cm-list-bullet-item";

  // Stamp only the lines this item directly owns - lines of a nested list are
  // stamped by their own ListItem visitor (stops stacked, contradictory
  // classes like task-item + bullet-item on the same line).
  eachDirectLine(state, parent, ["BulletList", "OrderedList"], (line) => {
    decos.push(Decoration.line({ class: lineClass }).range(line.from));
  });

  const cursorInItem = reveal && cursorTouches(sel, node.from, node.to);
  if (cursorInItem) return;

  if (task) {
    // Replace "- [x] " / "1. [x] " with the checkbox widget
    decos.push(
      Decoration.replace({
        widget: new TaskCheckboxWidget(task.checked),
      }).range(mark.from, task.hideTo),
    );
  } else if (isOrdered) {
    decos.push(
      Decoration.mark({ class: "cm-list-ordered-marker" }).range(mark.from, mark.to),
    );
  } else {
    const after = state.doc.sliceString(mark.to, mark.to + 1);
    const hideTo = after === " " || after === "\t" ? mark.to + 1 : mark.to;
    decos.push(
      Decoration.replace({ widget: new BulletWidget() }).range(mark.from, hideTo),
    );
  }
};
