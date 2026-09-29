// Discord "component embeds": a `<script id="discord:component-embed">` in the
// served <head> whose JSON replaces Discord's Open Graph link-preview card with
// a layout built from message components. Spec (still a draft, and Discord
// marks link previews "subject to change"):
// https://github.com/discord/discord-api-docs/pull/8606
// (developers/link-previews/component-embeds.mdx).
//
// Discord never reports a bad payload - it silently falls back to the OG card,
// and a payload over 40 components shows NO preview at all. So every card goes
// through `validateComponentEmbed` and `componentEmbedScript` returns null
// (= keep plain OG) rather than ever emitting something Discord would reject.
// Pure module: no Worker APIs, so it's shared by the worker (per-doc / invite
// cards) and vite.config.ts (the static landing card in index.html).

// ── Payload types (the component-embed subset of Discord components) ──────

export interface UnfurledMedia { url: string }

export interface LinkButton {
  type: 2;
  style: 5; // link - the only button style a component embed accepts
  url: string;
  label?: string;
  emoji?: { id?: string; name?: string; animated?: boolean };
  disabled?: boolean;
}
export interface ActionRow { type: 1; components: LinkButton[] }
export interface TextDisplay { type: 10; content: string }
export interface Thumbnail { type: 11; media: UnfurledMedia; description?: string; spoiler?: boolean }
export interface Section { type: 9; components: TextDisplay[]; accessory: Thumbnail | LinkButton }
export interface MediaGalleryItem { media: UnfurledMedia; description?: string; spoiler?: boolean }
export interface MediaGallery { type: 12; items: MediaGalleryItem[] }
export interface Separator { type: 14; divider?: boolean; spacing?: 1 | 2 }
export type ContainerChild = ActionRow | TextDisplay | Section | MediaGallery | Separator;
export interface Container { type: 17; accent_color?: number; spoiler?: boolean; components: ContainerChild[] }
export interface ComponentEmbedPayload { component: Container }

// ── Limits (from the spec + Discord's component reference) ────────────────

export const MAX_PAYLOAD_BYTES = 3000;
const MAX_COMPONENTS = 40; // including the root Container
const MAX_GALLERY_ITEMS = 10; // across the whole embed, not per gallery
const MAX_BUTTON_LABEL = 80;
const MAX_BUTTON_URL = 512;
const MAX_MEDIA_URL = 2048;
const MAX_MEDIA_DESCRIPTION = 1024;
const MAX_TEXT = 4000;

// Annex's warm off-white (landing --accent / #e8e4de) for the card's left bar.
export const ANNEX_ACCENT = 0xe8e4de;

// ── Tiny builders (keep call sites readable and the shapes exact) ─────────

export const text = (content: string): TextDisplay => ({ type: 10, content });
export const linkButton = (label: string, url: string): LinkButton => ({ type: 2, style: 5, url, label });
export const thumbnail = (url: string, description?: string): Thumbnail =>
  description ? { type: 11, media: { url }, description } : { type: 11, media: { url } };
export const actionRow = (...buttons: LinkButton[]): ActionRow => ({ type: 1, components: buttons });

// ── Validation ────────────────────────────────────────────────────────────

const isHttpUrl = (url: string) => /^https?:\/\/\S+$/i.test(url);
const isButtonUrl = (url: string) => /^(https?|discord):\/\/\S+$/i.test(url);

/** Returns a list of rule violations; empty means Discord should accept it. */
export function validateComponentEmbed(payload: ComponentEmbedPayload): string[] {
  const errors: string[] = [];
  let components = 0;
  let galleryItems = 0;

  const checkButton = (b: LinkButton, at: string) => {
    components++;
    if (b.type !== 2 || b.style !== 5) errors.push(`${at}: only link buttons (style 5) are allowed`);
    const allowed = new Set(["type", "style", "url", "label", "emoji", "disabled"]);
    for (const key of Object.keys(b)) if (!allowed.has(key)) errors.push(`${at}: key "${key}" invalidates the payload`);
    if (!b.label && !b.emoji) errors.push(`${at}: needs a label or an emoji`);
    if (b.label && b.label.length > MAX_BUTTON_LABEL) errors.push(`${at}: label over ${MAX_BUTTON_LABEL} chars`);
    if (!isButtonUrl(b.url) || b.url.length > MAX_BUTTON_URL) errors.push(`${at}: bad url`);
  };
  const checkMedia = (m: UnfurledMedia, description: string | undefined, at: string) => {
    if (!isHttpUrl(m.url) || m.url.length > MAX_MEDIA_URL) errors.push(`${at}: bad media url`);
    if (description && description.length > MAX_MEDIA_DESCRIPTION) errors.push(`${at}: description too long`);
  };
  const checkText = (t: TextDisplay, at: string) => {
    components++;
    if (t.type !== 10 || !t.content.trim()) errors.push(`${at}: text display must have content`);
    if (t.content.length > MAX_TEXT) errors.push(`${at}: text over ${MAX_TEXT} chars`);
  };

  const root = payload.component;
  if (!root || root.type !== 17) {
    return ["root must be a single Container (type 17)"];
  }
  components++;
  if (root.accent_color !== undefined && (!Number.isInteger(root.accent_color) || root.accent_color < 0 || root.accent_color > 0xffffff)) {
    errors.push("container: accent_color out of range");
  }
  if (root.components.length === 0) errors.push("container: needs at least one component");

  root.components.forEach((c, i) => {
    const at = `container.${i}`;
    switch (c.type) {
      case 10:
        checkText(c, at);
        break;
      case 9:
        components++;
        if (c.components.length < 1 || c.components.length > 3) errors.push(`${at}: section takes 1-3 text displays`);
        c.components.forEach((t, j) => checkText(t, `${at}.${j}`));
        if (c.accessory.type === 11) {
          components++;
          checkMedia(c.accessory.media, c.accessory.description, `${at}.accessory`);
        } else {
          checkButton(c.accessory, `${at}.accessory`);
        }
        break;
      case 12:
        components++;
        if (c.items.length < 1) errors.push(`${at}: gallery needs at least one item`);
        galleryItems += c.items.length;
        c.items.forEach((item, j) => checkMedia(item.media, item.description, `${at}.${j}`));
        break;
      case 1:
        components++;
        if (c.components.length < 1 || c.components.length > 5) errors.push(`${at}: action row takes 1-5 buttons`);
        c.components.forEach((b, j) => checkButton(b, `${at}.${j}`));
        break;
      case 14:
        components++;
        break;
      default:
        errors.push(`${at}: component type not allowed in a component embed`);
    }
  });

  if (components > MAX_COMPONENTS) errors.push(`${components} components (max ${MAX_COMPONENTS})`);
  if (galleryItems > MAX_GALLERY_ITEMS) errors.push(`${galleryItems} gallery items (max ${MAX_GALLERY_ITEMS})`);
  const bytes = new TextEncoder().encode(serializeComponentEmbed(payload)).length;
  if (bytes > MAX_PAYLOAD_BYTES) errors.push(`${bytes} bytes (max ${MAX_PAYLOAD_BYTES})`);
  return errors;
}

// JSON safe to drop inside a <script> element: escaping every `<` means user
// text can never close the tag (`</script>`) or open a comment. `<` is
// still `<` to any JSON parser. Discord counts the bytes as served, so this is
// also what the size limit is measured against.
export function serializeComponentEmbed(payload: ComponentEmbedPayload): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

/** The `<script>` tag for the page's <head>, or null if the card is invalid. */
export function componentEmbedScript(payload: ComponentEmbedPayload | null): string | null {
  if (!payload || validateComponentEmbed(payload).length > 0) return null;
  return `<script id="discord:component-embed" type="application/json">${serializeComponentEmbed(payload)}</script>`;
}

// ── Markdown helpers ──────────────────────────────────────────────────────

// Neutralise Discord markdown in user-controlled text (doc titles, site
// names, descriptions) so it renders literally: no fake links / headings /
// masked URLs, no `<@id>` mentions or `<t:...>` / `<:emoji:>` tags. Newlines
// collapse to spaces - callers own the card's line structure.
export function escapeMarkdown(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\*_~`|[\]()<>#@:-]/g, "\\$&");
}

// A URL safe to use as a markdown link target `[label](url)`.
// (encodeURIComponent leaves parentheses alone, so percent-encode by hand.)
const mdLinkTarget = (url: string) =>
  url.replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// D1 timestamps are "YYYY-MM-DD HH:MM:SS" (UTC, no zone); ISO strings pass through.
function unixSeconds(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// ── Cards ─────────────────────────────────────────────────────────────────

export interface DocCardInput {
  title: string;
  description: string | null;
  url: string; // canonical doc URL
  siteName: string;
  siteUrl: string; // the published site's root
  imageUrl: string | null; // doc frontmatter image (absolute), else the site's square logo
  updatedAt: string | null; // only pass when the doc shows "last updated"
  poweredByAnnex: boolean; // false on custom domains - the owner's brand, not ours
}

/**
 * Card for a published doc (share links + custom-domain pages). Escaping can
 * inflate user text up to ~8 bytes per character once serialized, so if the
 * card is over Discord's byte limit it is rebuilt with less text rather than
 * dropped.
 */
export function buildDocCard(d: DocCardInput): ComponentEmbedPayload {
  const attempts: Array<[titleMax: number, descMax: number]> = [[150, 300], [150, 120], [100, 0], [50, 0]];
  let payload = docCard(d, ...attempts[0]);
  for (const [titleMax, descMax] of attempts.slice(1)) {
    if (validateComponentEmbed(payload).length === 0) break;
    payload = docCard(d, titleMax, descMax);
  }
  return payload;
}

function docCard(d: DocCardInput, titleMax: number, descMax: number): ComponentEmbedPayload {
  const title = escapeMarkdown(truncate(d.title, titleMax)) || "Untitled";
  const desc = descMax > 0 && d.description ? escapeMarkdown(truncate(d.description, descMax)) : "";
  const heading = text(`## [${title}](${mdLinkTarget(d.url)})` + (desc ? `\n${desc}` : ""));
  const updated = unixSeconds(d.updatedAt);
  const metaParts = [escapeMarkdown(truncate(d.siteName, 80))];
  if (updated !== null) metaParts.push(`Updated <t:${updated}:D>`);
  if (d.poweredByAnnex) metaParts.push("Published with Annex");
  const meta = text(`-# ${metaParts.join(" · ")}`);

  const body: ContainerChild[] = d.imageUrl
    ? [{ type: 9, components: [heading, meta], accessory: thumbnail(d.imageUrl) }]
    : [heading, meta];
  const buttons = [linkButton("Read", d.url)];
  if (d.siteUrl !== d.url) buttons.push(linkButton(truncate(`Browse ${d.siteName}`, MAX_BUTTON_LABEL), d.siteUrl));

  return { component: { type: 17, accent_color: ANNEX_ACCENT, components: [...body, actionRow(...buttons)] } };
}

export interface InviteCardInput {
  pageTitle: string; // from buildInviteMeta
  description: string;
  inviteUrl: string;
  origin: string; // app origin, for the "What is Annex?" button
}

/** Card for an /invite/:token link. */
export function buildInviteCard(i: InviteCardInput): ComponentEmbedPayload {
  return {
    component: {
      type: 17,
      accent_color: ANNEX_ACCENT,
      components: [
        text(`## ${escapeMarkdown(truncate(i.pageTitle, 150))}\n${escapeMarkdown(truncate(i.description, 300))}`),
        text("-# Annex · a place to keep anything"),
        actionRow(linkButton("Accept invite", i.inviteUrl), linkButton("What is Annex?", `${i.origin}/`)),
      ],
    },
  };
}

/** The site-wide default card (landing page), baked into index.html at build. */
export function buildLandingCard(origin: string): ComponentEmbedPayload {
  return {
    component: {
      type: 17,
      accent_color: ANNEX_ACCENT,
      components: [
        {
          type: 9,
          components: [
            text(`## [Annex](${origin}/)\nA place to keep anything. Write in markdown, keep your files and drawings alongside, and publish any of it to the web when you're ready.`),
            text("-# Free to use · no card required"),
          ],
          accessory: thumbnail(`${origin}/icon-512.png`, "The Annex logo"),
        },
        { type: 12, items: [{ media: { url: `${origin}/og-image.png` }, description: "The Annex editor" }] },
        actionRow(
          linkButton("Create your Annex", `${origin}/register`),
          linkButton("See a demo", `${origin}/demo`),
          linkButton("Help docs", "https://docs.cubityfir.st/s/help/"),
        ),
      ],
    },
  };
}
