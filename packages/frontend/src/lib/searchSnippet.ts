// Turns a raw markdown search excerpt (as returned by the FTS snippet, with
// the matched words wrapped in <mark>…</mark>) into readable prose for the
// search palette: wikilinks become their labels, links their text, and task
// markers, list bullets, heading hashes and inline formatting delimiters are
// dropped. The <mark> tags are kept intact so highlighting survives.

// Private-use sentinels stand in for the <mark> tags while the markdown
// patterns run, so a match that splits a token (e.g. "[[<mark>Coffee</mark>
// guide]]") is still recognised.
const OPEN = "";
const CLOSE = "";
const M = `[${OPEN}${CLOSE}]*`;

export function cleanSearchSnippet(html: string): string {
  let s = html.replace(/<mark>/g, OPEN).replace(/<\/mark>/g, CLOSE);

  // [[target|label]] -> label, [[target]] -> target (closing may be cut off
  // by the excerpt window, so a dangling opener is handled below).
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]*)\]\]/g, "$1");
  // ![alt](src) and [text](url) -> alt / text
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Task markers and list bullets at a line/sentence boundary.
  s = s.replace(new RegExp(`(^|\\s)[-*+]?\\s*\\[[ xX]\\]\\s+`, "g"), "$1");
  s = s.replace(/(^|\s)[-*+]\s+/g, "$1");
  // Heading hashes and blockquote markers.
  s = s.replace(/(^|\s)#{1,6}\s+/g, "$1");
  s = s.replace(/(^|\s)>\s+/g, "$1");
  // Leftover wikilink brackets from a truncated excerpt.
  s = s.replace(/\[\[|\]\]/g, "");
  // Inline delimiters: bold/italic/strike/code (keep inner text).
  s = s.replace(new RegExp(`(\\*\\*|__|~~)(${M}[^*_~]+?${M})\\1`, "g"), "$2");
  s = s.replace(/(^|[\s(])[*_](?=\S)([^*_\n]+?)[*_](?=[\s.,;:!?)]|$)/g, "$1$2");
  s = s.replace(/`+/g, "");
  // Callout headers like "[!note]".
  s = s.replace(/\[![a-z]+\][+-]?/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  // A leading ellipsis hugs the first word ("…brackets", not "… brackets").
  s = s.replace(/^(…|\.\.\.)\s+/, "$1");

  return s.replace(new RegExp(OPEN, "g"), "<mark>").replace(new RegExp(CLOSE, "g"), "</mark>");
}
