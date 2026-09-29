import { describe, it, expect } from "vitest";
import {
  ANNEX_ACCENT,
  MAX_PAYLOAD_BYTES,
  actionRow,
  buildDocCard,
  buildInviteCard,
  buildLandingCard,
  componentEmbedScript,
  escapeMarkdown,
  linkButton,
  serializeComponentEmbed,
  text,
  validateComponentEmbed,
  type ComponentEmbedPayload,
  type DocCardInput,
} from "./componentEmbed";

const card = (...components: ComponentEmbedPayload["component"]["components"]): ComponentEmbedPayload => ({
  component: { type: 17, components },
});

const doc = (over: Partial<DocCardInput> = {}): DocCardInput => ({
  title: "Coffee brewing guide",
  description: "A sample doc.",
  url: "https://docs.cubityfir.st/s/demo/coffee",
  siteName: "Demo Site",
  siteUrl: "https://docs.cubityfir.st/s/demo",
  imageUrl: null,
  updatedAt: null,
  poweredByAnnex: true,
  ...over,
});

describe("validateComponentEmbed", () => {
  it("accepts a minimal container", () => {
    expect(validateComponentEmbed(card(text("# Hi")))).toEqual([]);
  });

  it("rejects a non-container root and an empty container", () => {
    expect(validateComponentEmbed({ component: { type: 10, content: "x" } } as never)).not.toEqual([]);
    expect(validateComponentEmbed(card())).not.toEqual([]);
  });

  it("rejects empty text and out-of-range accent colours", () => {
    expect(validateComponentEmbed(card(text("   ")))).not.toEqual([]);
    const payload = card(text("x"));
    payload.component.accent_color = 0x1000000;
    expect(validateComponentEmbed(payload)).not.toEqual([]);
  });

  it("only allows link buttons with whitelisted keys, a label, and an http(s)/discord url", () => {
    expect(validateComponentEmbed(card(actionRow(linkButton("Go", "https://a.b/"))))).toEqual([]);
    expect(validateComponentEmbed(card(actionRow(linkButton("Go", "discord://-/channels"))))).toEqual([]);
    expect(validateComponentEmbed(card(actionRow({ ...linkButton("Go", "https://a.b/"), custom_id: "x" } as never)))).not.toEqual([]);
    expect(validateComponentEmbed(card(actionRow({ type: 2, style: 5, url: "https://a.b/" })))).not.toEqual([]);
    expect(validateComponentEmbed(card(actionRow(linkButton("Go", "javascript:alert(1)"))))).not.toEqual([]);
    expect(validateComponentEmbed(card(actionRow(linkButton("x".repeat(81), "https://a.b/"))))).not.toEqual([]);
  });

  it("caps action rows at 5 buttons", () => {
    const six = Array.from({ length: 6 }, (_, i) => linkButton(`B${i}`, "https://a.b/"));
    expect(validateComponentEmbed(card(actionRow(...six)))).not.toEqual([]);
  });

  it("caps the embed at 40 components including the container", () => {
    const texts = (n: number) => Array.from({ length: n }, (_, i) => text(`${i}`));
    expect(validateComponentEmbed(card(...texts(39)))).toEqual([]);
    expect(validateComponentEmbed(card(...texts(40)))).not.toEqual([]);
  });

  it("caps gallery items at 10 across all galleries", () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ media: { url: "https://a.b/i.png" } }));
    expect(validateComponentEmbed(card({ type: 12, items: items(6) }, { type: 12, items: items(4) }))).toEqual([]);
    expect(validateComponentEmbed(card({ type: 12, items: items(6) }, { type: 12, items: items(5) }))).not.toEqual([]);
  });

  it("rejects non-http media", () => {
    expect(validateComponentEmbed(card({ type: 12, items: [{ media: { url: "data:image/png;base64,xx" } }] }))).not.toEqual([]);
  });

  it("enforces the 3000-byte limit on the serialized payload", () => {
    const errors = validateComponentEmbed(card(text("x".repeat(MAX_PAYLOAD_BYTES))));
    expect(errors.some((e) => e.includes("bytes"))).toBe(true);
  });
});

describe("serializeComponentEmbed / componentEmbedScript", () => {
  it("can never close the script tag or open a comment, whatever the text", () => {
    const script = componentEmbedScript(card(text("</script><script>alert(1)</script><!--")))!;
    const inner = script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>"));
    expect(inner).not.toContain("<");
    expect(JSON.parse(inner).component.components[0].content).toBe("</script><script>alert(1)</script><!--");
  });

  it("emits the id and type Discord looks for", () => {
    expect(componentEmbedScript(card(text("x")))).toMatch(/^<script id="discord:component-embed" type="application\/json">\{/);
  });

  it("returns null (plain OG preview) for an invalid card or no card", () => {
    expect(componentEmbedScript(card())).toBeNull();
    expect(componentEmbedScript(null)).toBeNull();
  });

  it("serializes without whitespace", () => {
    expect(serializeComponentEmbed(card(text("x")))).toBe('{"component":{"type":17,"components":[{"type":10,"content":"x"}]}}');
  });
});

describe("escapeMarkdown", () => {
  it("neutralises links, headings, mentions and timestamps", () => {
    expect(escapeMarkdown("[click](https://evil.test)")).toBe("\\[click\\]\\(https\\://evil.test\\)");
    expect(escapeMarkdown("# big")).toBe("\\# big");
    expect(escapeMarkdown("<@123> @everyone")).toBe("\\<\\@123\\> \\@everyone");
    expect(escapeMarkdown("<t:1:R>")).toBe("\\<t\\:1\\:R\\>");
  });

  it("collapses newlines so user text can't add lines to the card", () => {
    expect(escapeMarkdown("a\n\n# b")).toBe("a \\# b");
  });
});

describe("buildDocCard", () => {
  it("builds a valid card with a linked heading, meta line and Read/Browse buttons", () => {
    const payload = buildDocCard(doc());
    expect(validateComponentEmbed(payload)).toEqual([]);
    expect(payload.component.accent_color).toBe(ANNEX_ACCENT);
    const [heading, meta, row] = payload.component.components as [ReturnType<typeof text>, ReturnType<typeof text>, ReturnType<typeof actionRow>];
    expect(heading.content).toBe("## [Coffee brewing guide](https://docs.cubityfir.st/s/demo/coffee)\nA sample doc.");
    expect(meta.content).toBe("-# Demo Site · Published with Annex");
    expect(row.components.map((b) => [b.label, b.url])).toEqual([
      ["Read", "https://docs.cubityfir.st/s/demo/coffee"],
      ["Browse Demo Site", "https://docs.cubityfir.st/s/demo"],
    ]);
  });

  it("wraps the text in a Section with a thumbnail when there is an image", () => {
    const payload = buildDocCard(doc({ imageUrl: "https://x.test/cover.png" }));
    expect(validateComponentEmbed(payload)).toEqual([]);
    const section = payload.component.components[0];
    expect(section.type).toBe(9);
    expect(section.type === 9 && section.accessory).toEqual({ type: 11, media: { url: "https://x.test/cover.png" } });
  });

  it("renders the updated date as a Discord timestamp (D1 and ISO formats)", () => {
    const meta = (updatedAt: string) => (buildDocCard(doc({ updatedAt })).component.components[1] as { content: string }).content;
    expect(meta("2026-09-27 10:00:00")).toContain("Updated <t:1790503200:D>");
    expect(meta("2026-09-27T10:00:00.000Z")).toContain("Updated <t:1790503200:D>");
    expect(meta("not a date")).not.toContain("Updated");
  });

  it("drops Annex branding on custom domains", () => {
    const meta = buildDocCard(doc({ poweredByAnnex: false })).component.components[1] as { content: string };
    expect(meta.content).toBe("-# Demo Site");
  });

  it("omits the Browse button when the doc is the site root", () => {
    const payload = buildDocCard(doc({ url: "https://acme.test/", siteUrl: "https://acme.test/" }));
    const row = payload.component.components.at(-1) as ReturnType<typeof actionRow>;
    expect(row.components).toHaveLength(1);
  });

  it("escapes hostile titles and keeps the link target intact", () => {
    const payload = buildDocCard(doc({ title: "](https://evil.test) [x", url: "https://docs.cubityfir.st/s/demo/a(b)" }));
    const heading = (payload.component.components[0] as { content: string }).content;
    expect(heading.startsWith("## [\\]\\(https\\://evil.test\\) \\[x](https://docs.cubityfir.st/s/demo/a%28b%29)")).toBe(true);
  });

  it("stays under the byte limit with maximal user text", () => {
    const payload = buildDocCard(doc({
      title: "<".repeat(5000),
      description: "<".repeat(5000),
      siteName: "<".repeat(500),
      imageUrl: "https://x.test/" + "a".repeat(400),
      updatedAt: "2026-09-27 10:00:00",
    }));
    expect(validateComponentEmbed(payload)).toEqual([]);
  });
});

describe("buildInviteCard", () => {
  it("builds a valid card with an Accept button", () => {
    const payload = buildInviteCard({
      pageTitle: "Join Acme Docs on Annex",
      description: "Jo invited you to collaborate on Acme Docs as an editor.",
      inviteUrl: "https://docs.cubityfir.st/invite/tok",
      origin: "https://docs.cubityfir.st",
    });
    expect(validateComponentEmbed(payload)).toEqual([]);
    const row = payload.component.components.at(-1) as ReturnType<typeof actionRow>;
    expect(row.components[0]).toEqual(linkButton("Accept invite", "https://docs.cubityfir.st/invite/tok"));
  });
});

describe("buildLandingCard", () => {
  it("is valid and points at the given origin", () => {
    const payload = buildLandingCard("https://docs.cubityfir.st");
    expect(validateComponentEmbed(payload)).toEqual([]);
    const json = serializeComponentEmbed(payload);
    expect(json).toContain("https://docs.cubityfir.st/og-image.png");
    expect(json).toContain("https://docs.cubityfir.st/demo");
  });
});
