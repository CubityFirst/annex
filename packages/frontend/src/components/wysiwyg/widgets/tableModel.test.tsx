import { describe, it, expect } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { splitRow, parseTable, renderInline } from "./tableModel";

// --- helpers -----------------------------------------------------------------

function nodes(result: ReactNode): ReactNode[] {
  return Array.isArray(result) ? result : [result];
}

function elementsOfType(result: ReactNode, type: string): ReactElement[] {
  return nodes(result).filter(
    (n): n is ReactElement => isValidElement(n) && n.type === type,
  );
}

/** All React elements whose type is a component function (e.g. TableImage). */
function componentElements(result: ReactNode): ReactElement[] {
  return nodes(result).filter(
    (n): n is ReactElement => isValidElement(n) && typeof n.type === "function",
  );
}

function plainText(result: ReactNode): string {
  return nodes(result).filter((n): n is string => typeof n === "string").join("");
}

// --- splitRow / parseTable -----------------------------------------------------

describe("splitRow", () => {
  it("splits a plain row and trims cells", () => {
    expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("handles rows without leading/trailing pipes", () => {
    expect(splitRow("a | b")).toEqual(["a", "b"]);
  });

  it("treats \\| as a literal pipe inside a cell (W-L3)", () => {
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("multiple escaped pipes in one cell", () => {
    expect(splitRow("| x \\| y \\| z | last |")).toEqual(["x | y | z", "last"]);
  });

  it("an escaped pipe at the end of the row is not eaten as a trailing delimiter", () => {
    expect(splitRow("| a | b \\|")).toEqual(["a", "b |"]);
  });
});

describe("parseTable", () => {
  it("parses headers, alignment row and body rows", () => {
    const t = parseTable("| Name | Qty | Price |\n| :--- | :-: | ---: |\n| a | 1 | 2 |");
    expect(t.headers).toEqual(["Name", "Qty", "Price"]);
    expect(t.aligns).toEqual(["left", "center", "right"]);
    expect(t.rows).toEqual([["a", "1", "2"]]);
  });

  it("plain --- delimiter yields null alignment", () => {
    const t = parseTable("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(t.aligns).toEqual([null, null]);
  });

  it("fewer than two lines yields an empty table", () => {
    expect(parseTable("| only |")).toEqual({ headers: [], rows: [], aligns: [] });
  });

  it("escaped pipes survive through parseTable cells", () => {
    const t = parseTable("| h |\n| --- |\n| a \\| b |");
    expect(t.rows).toEqual([["a | b"]]);
  });
});

// --- renderInline: formatting -------------------------------------------------

describe("renderInline - inline constructs", () => {
  it("bold", () => {
    const [el] = elementsOfType(renderInline("**bold**"), "strong");
    expect(el).toBeDefined();
    expect(el!.props.children).toBe("bold");
  });

  it("italic (both spellings)", () => {
    expect(elementsOfType(renderInline("*it*"), "em")).toHaveLength(1);
    expect(elementsOfType(renderInline("_it_"), "em")).toHaveLength(1);
  });

  it("underline, strike, code", () => {
    expect(elementsOfType(renderInline("__u__"), "u")).toHaveLength(1);
    expect(elementsOfType(renderInline("~~s~~"), "s")).toHaveLength(1);
    expect(elementsOfType(renderInline("`c`"), "code")).toHaveLength(1);
  });

  it("mixed text and constructs keep surrounding plain text", () => {
    const out = renderInline("pre **b** post");
    expect(plainText(out)).toBe("pre  post");
    expect(elementsOfType(out, "strong")).toHaveLength(1);
  });
});

// --- renderInline: links + W-S1 regression ------------------------------------

describe("renderInline - links (W-S1)", () => {
  it("safe links render an <a> with the exact href", () => {
    const [a] = elementsOfType(renderInline("[click](https://example.com/x)"), "a");
    expect(a).toBeDefined();
    expect(a!.props.href).toBe("https://example.com/x");
    expect(a!.props.target).toBe("_blank");
    expect(a!.props.rel).toBe("noopener noreferrer");
  });

  it("javascript: link never reaches an href - renders as plain text", () => {
    const out = renderInline("[click](javascript:alert(document.cookie))");
    expect(elementsOfType(out, "a")).toHaveLength(0);
    expect(plainText(out)).toContain("[click](javascript:alert(document.cookie))");
    // Belt-and-braces: the rendered markup contains no javascript: URL at all.
    const html = renderToStaticMarkup(<div>{out}</div>);
    expect(html).not.toContain("href");
  });

  it("case/whitespace tricks are still blocked", () => {
    for (const url of ["JaVaScRiPt:alert(1)", " javascript:alert(1)", "vbscript:x", "data:text/html,<script>1</script>"]) {
      const out = renderInline(`[x](${url.replace(/ /g, "")})`);
      expect(elementsOfType(out, "a"), url).toHaveLength(0);
    }
  });

  it("relative and mailto links stay allowed", () => {
    expect(elementsOfType(renderInline("[d](/docs/abc)"), "a")).toHaveLength(1);
    expect(elementsOfType(renderInline("[m](mailto:x@y.z)"), "a")).toHaveLength(1);
  });
});

describe("renderInline - images (W-S1, image branch)", () => {
  it("safe image renders the image component with the exact src", () => {
    const out = renderInline("![alt](/api/files/f1/content)");
    const imgs = componentElements(out);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.props.src).toBe("/api/files/f1/content");
    expect(imgs[0]!.props.alt).toBe("alt");
  });

  it("javascript: image src never reaches the component - renders as plain text", () => {
    const out = renderInline("![x](javascript:alert(1))");
    expect(componentElements(out)).toHaveLength(0);
    expect(plainText(out)).toContain("![x](javascript:alert(1))");
  });

  it("data: image src is blocked", () => {
    const out = renderInline("![x](data:text/html,hi)");
    expect(componentElements(out)).toHaveLength(0);
  });
});
