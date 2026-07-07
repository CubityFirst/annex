import type { MarkdownConfig } from "@lezer/markdown";

const PERCENT = 37; // %
const BACKSLASH = 92; // \
const NEWLINE = 10; // \n

// Obsidian-style `%%comment%%` inline comments. Unlike the wikilink brackets,
// the `%%` delimiter is symmetric, so the FIRST `%%` always opens (Obsidian
// treats `%%% x %%` as a comment with content `% x`) - no innermost-wins
// deferral here.
export const Comment: MarkdownConfig = {
  defineNodes: ["MdComment", "MdCommentMark"],
  parseInline: [
    {
      name: "MdComment",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== PERCENT) return -1;
        if (cx.char(pos + 1) !== PERCENT) return -1;
        let end = pos + 2;
        while (end < cx.end - 1) {
          const ch = cx.char(end);
          if (ch === NEWLINE) return -1; // single-line only
          if (ch === BACKSLASH) {
            // Backslash-escaped char (e.g. `\%`) is content, never part of a
            // closer. A backslash can't escape the newline - keep the
            // single-line bail intact.
            if (cx.char(end + 1) === NEWLINE) return -1;
            end += 2;
            continue;
          }
          if (ch === PERCENT && cx.char(end + 1) === PERCENT) {
            const open = cx.elt("MdCommentMark", pos, pos + 2);
            const close = cx.elt("MdCommentMark", end, end + 2);
            return cx.addElement(cx.elt("MdComment", pos, end + 2, [open, close]));
          }
          end++;
        }
        return -1;
      },
    },
  ],
};
