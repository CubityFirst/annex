import { describe, it, expect } from "vitest";
import { sanitizeHref } from "./link";
import { LinkWidget } from "../../widgets/LinkWidget";
import { stateFor, widgetsForDoc, entriesFor } from "../testSupport";

describe("sanitizeHref - blocked schemes", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(document.cookie)",
    "JAVASCRIPT:void(0)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "vbscript:msgbox(1)",
    "VBScript:msgbox(1)",
    "file:///etc/passwd",
  ])("blocks %s", (url) => {
    expect(sanitizeHref(url)).toBeNull();
  });

  it("blocks whitespace-padded dangerous schemes", () => {
    expect(sanitizeHref("   javascript:alert(1)   ")).toBeNull();
    expect(sanitizeHref("\n\tjavascript:alert(1)")).toBeNull();
  });

  it("blocks schemes smuggled past with embedded tab/newline (URL strips them)", () => {
    expect(sanitizeHref("java\tscript:alert(1)")).toBeNull();
    expect(sanitizeHref("java\nscript:alert(1)")).toBeNull();
  });

  it("percent-encoded scheme delimiters never resolve to a dangerous scheme", () => {
    // `%3A` is not a valid scheme delimiter, so the string parses as a
    // RELATIVE url - allowed, but resolving it against a real document base
    // must stay on the page's own scheme (browsers do not decode `%3A` into
    // a scheme separator either).
    const out = sanitizeHref("javascript%3Aalert(1)");
    if (out !== null) {
      expect(new URL(out, "https://app.example/docs/x").protocol).toBe("https:");
    }
  });

  it("blocks empty and whitespace-only", () => {
    expect(sanitizeHref("")).toBeNull();
    expect(sanitizeHref("   ")).toBeNull();
  });
});

describe("sanitizeHref - allowed forms", () => {
  it.each([
    "https://example.com/a?b=c#d",
    "http://example.com",
    "mailto:user@example.com",
    "tel:+15551234567",
    "MAILTO:user@example.com",
    "/projects/p/docs/d",
    "./sibling",
    "../up",
    "#heading-anchor",
    "relative/path.png",
  ])("allows %s", (url) => {
    expect(sanitizeHref(url)).toBe(url);
  });

  it("trims surrounding whitespace on allowed urls", () => {
    expect(sanitizeHref("  https://example.com  ")).toBe("https://example.com");
  });
});

describe("visitLink - nested markup in link text (D11)", () => {
  it("strips bold markers from the widget text", () => {
    const widgets = widgetsForDoc("[**bold** link](https://x.com)");
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link).toBeDefined();
    expect(link.eq(new LinkWidget({ text: "bold link", href: "https://x.com" }))).toBe(true);
  });

  it("strips italic + code + strike markers", () => {
    const widgets = widgetsForDoc("[*i* `c` ~~s~~](https://x.com)");
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link.eq(new LinkWidget({ text: "i c s", href: "https://x.com" }))).toBe(true);
  });

  it("a nested image contributes its alt text", () => {
    const widgets = widgetsForDoc("[![alt text](img.png)](https://y.com)");
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link).toBeDefined();
    expect(link.eq(new LinkWidget({ text: "alt text", href: "https://y.com" }))).toBe(true);
  });

  it("escapes lose their backslash", () => {
    const widgets = widgetsForDoc("[a\\*b](https://x.com)");
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link.eq(new LinkWidget({ text: "a*b", href: "https://x.com" }))).toBe(true);
  });

  it("plain link text is unchanged", () => {
    const widgets = widgetsForDoc("[plain](https://x.com)");
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link.eq(new LinkWidget({ text: "plain", href: "https://x.com" }))).toBe(true);
  });

  it("an unsafe href leaves the raw markdown visible (no widget)", () => {
    const widgets = widgetsForDoc("[click](javascript:alert(1))");
    expect(widgets.some((w) => w instanceof LinkWidget)).toBe(false);
  });
});

describe("visitUrl / visitAutolink - bare autolinks (D9)", () => {
  it("a bare https url renders a LinkWidget", () => {
    const widgets = widgetsForDoc("visit https://example.com now");
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link).toBeDefined();
    expect(link.eq(new LinkWidget({ text: "https://example.com", href: "https://example.com" }))).toBe(true);
  });

  it("a bare www url gets an https:// scheme", () => {
    const widgets = widgetsForDoc("go to www.example.com now");
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link).toBeDefined();
    expect(link.eq(new LinkWidget({ text: "www.example.com", href: "https://www.example.com" }))).toBe(true);
  });

  it("an angle-bracketed autolink replaces the whole <...> range", () => {
    const doc = "<https://auto.example>";
    const state = stateFor(doc);
    const entry = entriesFor(state).find((e) => e.deco.spec.widget instanceof LinkWidget);
    expect(entry).toBeDefined();
    expect(entry!.from).toBe(0);
    expect(entry!.to).toBe(doc.length);
  });

  it("an email autolink links via mailto:", () => {
    const widgets = widgetsForDoc("<user@host.example>");
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link).toBeDefined();
    expect(link.eq(new LinkWidget({ text: "user@host.example", href: "mailto:user@host.example" }))).toBe(true);
  });

  it("the URL inside a markdown link is not double-rendered", () => {
    const widgets = widgetsForDoc("[t](https://x.com)");
    expect(widgets.filter((w) => w instanceof LinkWidget)).toHaveLength(1);
  });

  it("cursor on a bare url reveals the raw source in editing mode", () => {
    const widgets = widgetsForDoc("see https://example.com", {
      ctx: { revealOnCursor: true },
      cursor: 8,
    });
    expect(widgets.some((w) => w instanceof LinkWidget)).toBe(false);
  });
});
