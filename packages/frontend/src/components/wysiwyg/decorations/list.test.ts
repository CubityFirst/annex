import { describe, it, expect } from "vitest";
import { TaskCheckboxWidget } from "../widgets/TaskCheckboxWidget";
import { stateFor, widgetsForDoc, lineClassesFor } from "./testSupport";

function checkboxes(doc: string): TaskCheckboxWidget[] {
  return widgetsForDoc(doc).filter((w): w is TaskCheckboxWidget => w instanceof TaskCheckboxWidget);
}

describe("visitListItem - task detection via the syntax tree", () => {
  it("bullet tasks render checkboxes with the right checked state", () => {
    const [a, b, c] = checkboxes("- [x] done\n- [ ] todo\n- [X] caps");
    expect(a).toBeDefined();
    expect(a!.eq(new TaskCheckboxWidget(true))).toBe(true);
    expect(b!.eq(new TaskCheckboxWidget(false))).toBe(true);
    expect(c!.eq(new TaskCheckboxWidget(true))).toBe(true);
  });

  it("ordered-list tasks render checkboxes too (D8)", () => {
    const boxes = checkboxes("1. [x] first\n2. [ ] second");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.eq(new TaskCheckboxWidget(true))).toBe(true);
    expect(boxes[1]!.eq(new TaskCheckboxWidget(false))).toBe(true);
  });

  it("a `[x]` on the NEXT line is not a task (D7 regression)", () => {
    // The old regex lookahead used `\s+` and matched across the newline,
    // emitting an inline replace that spanned a line break.
    expect(checkboxes("- \n  [x] hi")).toHaveLength(0);
  });

  it("a mid-text [x] is not a task", () => {
    expect(checkboxes("- foo [x] bar")).toHaveLength(0);
  });
});

describe("visitListItem - line classes (D21)", () => {
  it("a task item line gets only the task class", () => {
    const classes = lineClassesFor(stateFor("- plain\n- [x] task"));
    expect(classes.get(1)).toContain("cm-list-bullet-item");
    expect(classes.get(2)).toContain("cm-list-task-item");
    expect(classes.get(2)).not.toContain("cm-list-bullet-item");
  });

  it("a nested task's line is not double-stamped by the outer bullet item", () => {
    const classes = lineClassesFor(stateFor("- outer\n  - [x] inner"));
    expect(classes.get(1)).toEqual(["cm-list-bullet-item"]);
    expect(classes.get(2)).toContain("cm-list-task-item");
    expect(classes.get(2)).not.toContain("cm-list-bullet-item");
  });

  it("ordered items get the ordered class", () => {
    const classes = lineClassesFor(stateFor("1. one\n2. two"));
    expect(classes.get(1)).toEqual(["cm-list-ordered-item"]);
    expect(classes.get(2)).toEqual(["cm-list-ordered-item"]);
  });
});

describe("visitListItem - cursor reveal", () => {
  it("cursor inside the item keeps the raw marker (no checkbox)", () => {
    const widgets = widgetsForDoc("- [x] task", { ctx: { revealOnCursor: true }, cursor: 3 });
    expect(widgets.some((w) => w instanceof TaskCheckboxWidget)).toBe(false);
  });
});
