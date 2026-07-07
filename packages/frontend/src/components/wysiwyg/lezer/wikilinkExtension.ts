import type { MarkdownConfig } from "@lezer/markdown";

const OPEN = 91; // [
const BACKSLASH = 92; // \
const CLOSE = 93; // ]
const NEWLINE = 10; // \n

// Lezer extension that claims `[[…]]` before the standard inline-link parser
// sees `[`, so wikilinks parse as a single `Wikilink` node with a pair of
// `WikilinkMark` children for the brackets.
export const Wikilink: MarkdownConfig = {
  defineNodes: ["Wikilink", "WikilinkMark"],
  parseInline: [
    {
      name: "Wikilink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== OPEN) return -1;
        if (cx.char(pos + 1) !== OPEN) return -1;
        // `[[[…` - decline so the parser retries at pos + 1 and the INNERMOST
        // `[[…]]` wins: `[[[x]]]` parses as `[` + Wikilink(`[[x]]`) + `]`
        // instead of a mis-spanned `[[[x]]`.
        if (cx.char(pos + 2) === OPEN) return -1;
        let end = pos + 2;
        while (end < cx.end - 1) {
          const ch = cx.char(end);
          if (ch === NEWLINE) return -1; // single-line only
          if (ch === BACKSLASH) {
            // Backslash-escaped char (e.g. `\]`) is content, never part of a
            // closer. A backslash can't escape the newline - keep the
            // single-line bail intact.
            if (cx.char(end + 1) === NEWLINE) return -1;
            end += 2;
            continue;
          }
          if (ch === CLOSE && cx.char(end + 1) === CLOSE) {
            const open = cx.elt("WikilinkMark", pos, pos + 2);
            const close = cx.elt("WikilinkMark", end, end + 2);
            return cx.addElement(cx.elt("Wikilink", pos, end + 2, [open, close]));
          }
          end++;
        }
        return -1;
      },
    },
  ],
};
