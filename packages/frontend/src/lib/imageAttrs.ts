// Shared Pandoc-style image attribute parser:
//   ![alt](url){width=50% height=200px align=center}
//
// Supported attributes: width, height, align (quoted or unquoted values).
// align accepts left | center | mid | right ("mid" is an alias for center).

// Matches a Pandoc attribute block at the start of a string: {key=val …}.
// `[^}\n]` (not `[^}]`) so an unfinished `{…` on one line doesn't greedily
// gobble across newlines until it finds a `}` from a later line.
export const ATTR_BLOCK_RE = /^\{([^}\n]*)\}/;

// Matches an INCOMPLETE attribute block at the start: an opening `{` with
// no closing `}` before the end of the line. Used so the visitor can consume
// the partial text while the user is still typing - otherwise the rendered
// image and the unfinished `{…` show side-by-side. Multiline `m` so `$`
// matches end-of-line within the lookahead slice.
export const PARTIAL_ATTR_BLOCK_RE = /^\{[^}\n]*$/m;

// Matches a single key=value or key:value pair (both separators accepted so
// {size:small} reads naturally alongside Pandoc's existing {width=50%}).
const KV_RE = /(\w+)[=:](?:"([^"]*)"|'([^']*)'|(\S+))/g;

// Bare numeric value (integer or decimal) - defaults to px so `width=200`
// behaves the same as `width=200px`.
const UNITLESS_NUMERIC_RE = /^\d+(?:\.\d+)?$/;

export function parseImageAttrs(block: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  KV_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KV_RE.exec(block)) !== null) {
    const key = m[1]!;
    let val = m[2] ?? m[3] ?? m[4]!;
    if (UNITLESS_NUMERIC_RE.test(val)) val = `${val}px`;
    attrs[key] = val;
  }
  return attrs;
}

export function styleFromAttrs(attrs: Record<string, string>): string | undefined {
  const { width, height, align } = attrs;
  const parts: string[] = [];
  if (width) parts.push(`width: ${width}`);
  if (height) parts.push(`height: ${height}`);
  const alignCss = alignToCss(align);
  if (alignCss) parts.push(alignCss);
  return parts.length ? parts.join("; ") : undefined;
}

// Centering an <img> works the same in the main document frame and inside a
// table cell: make it a block and use auto margins. left/right anchor the
// margin on the opposite side so the image hugs that edge.
function alignToCss(align: string | undefined): string | undefined {
  if (!align) return undefined;
  switch (align.toLowerCase()) {
    case "left":
      return "display: block; margin-left: 0; margin-right: auto";
    case "right":
      return "display: block; margin-left: auto; margin-right: 0";
    case "center":
    case "mid":
      return "display: block; margin-left: auto; margin-right: auto";
    default:
      return undefined;
  }
}
