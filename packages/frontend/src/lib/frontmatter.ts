// NOTE: kept byte-identical with packages/api/src/lib/frontmatter.ts (minus
// stripFrontmatter, which only the API uses). When adding a key, update both.
export interface Frontmatter {
  sidebar_position?: number;
  title?: string;
  hide_title?: boolean;
  tags?: string[];
  description?: string;
  image?: string;
  cover?: string;
}

const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(FM_REGEX);
  if (!match) return {};
  const result: Frontmatter = {};
  const lines = match[1].split(/\r?\n/);
  let collectingTags = false;
  const collectedTags: string[] = [];

  for (const line of lines) {
    if (collectingTags) {
      const tagItem = line.match(/^\s+-\s+(.+)/);
      if (tagItem) {
        const t = tagItem[1].trim().replace(/^['"]|['"]$/g, "").replace(/^#/, "");
        if (t) collectedTags.push(t);
        continue;
      }
      collectingTags = false;
      if (collectedTags.length > 0) result.tags = [...collectedTags];
    }

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();

    if (key === "sidebar_position") {
      const n = Number(val);
      if (!isNaN(n)) result.sidebar_position = n;
    } else if (key === "title") {
      result.title = val.replace(/^['"]|['"]$/g, "");
    } else if (key === "hide_title") {
      result.hide_title = val === "true";
    } else if (key === "tags") {
      if (val.startsWith("[") && val.endsWith("]")) {
        result.tags = val.slice(1, -1).split(",")
          .map(t => t.trim().replace(/^['"]|['"]$/g, "").replace(/^#/, ""))
          .filter(Boolean);
      } else if (val === "") {
        collectingTags = true;
      } else if (val) {
        result.tags = [val.replace(/^['"]|['"]$/g, "").replace(/^#/, "")];
      }
    } else if (key === "description") {
      const stripped = val.replace(/^['"]|['"]$/g, "");
      if (stripped) result.description = stripped;
    } else if (key === "image") {
      const stripped = val.replace(/^['"]|['"]$/g, "");
      if (stripped) result.image = stripped;
    } else if (key === "cover") {
      const stripped = val.replace(/^['"]|['"]$/g, "");
      if (stripped) result.cover = stripped;
    }
  }

  if (collectingTags && collectedTags.length > 0) result.tags = collectedTags;
  return result;
}

// Insert, replace, or (when value is null) remove a single scalar key in the
// content's YAML frontmatter block, returning the new content. Creates a
// frontmatter block if none exists and a value is given; drops the block
// entirely if removing its last key. Used by the header-image upload control to
// persist `cover:` without round-tripping through the editor. Only safe for
// simple scalar keys (no nested/list values) - which is all `cover` ever needs.
export function setFrontmatterKey(content: string, key: string, value: string | null): string {
  const match = content.match(FM_REGEX);
  const line = `${key}: ${value}`;
  if (!match) {
    return value === null ? content : `---\n${line}\n---\n\n${content}`;
  }
  const keyRe = new RegExp(`^\\s*${key}\\s*:`);
  const kept = match[1].split(/\r?\n/).filter(l => !keyRe.test(l));
  if (value !== null) kept.push(line);
  const body = content.slice(match[0].length);
  if (kept.length === 0) {
    // Removed the only key - drop the now-empty frontmatter block.
    return body.replace(/^\r?\n/, "");
  }
  return `---\n${kept.join("\n")}\n---\n${body}`;
}
