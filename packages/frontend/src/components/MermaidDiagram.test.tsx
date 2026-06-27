import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the heavy mermaid module - these tests cover the fence→diagram routing
// and the error fallback, not mermaid's own SVG layout (which jsdom can't do).
const renderMock = vi.fn();
const initializeMock = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}));

async function importCodeBlock() {
  // Reset modules so MermaidDiagram's module-level mermaid cache doesn't leak
  // between tests (one test's resolved/rejected load would poison the next).
  vi.resetModules();
  return (await import("./CodeBlock")).CodeBlock;
}

describe("CodeBlock mermaid routing", () => {
  beforeEach(() => {
    renderMock.mockReset();
    initializeMock.mockReset();
  });

  it("renders a mermaid fence as the diagram SVG", async () => {
    renderMock.mockResolvedValue({ svg: "<svg data-testid='diagram'></svg>" });
    const CodeBlock = await importCodeBlock();

    render(<CodeBlock lang="mermaid" code="graph TD; A-->B" />);

    expect(await screen.findByTestId("diagram")).toBeInTheDocument();
    expect(renderMock).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      "graph TD; A-->B",
    );
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark", securityLevel: "strict" }),
    );
    // Must not have fallen through to the Shiki code path.
    expect(document.querySelector("pre")).toBeNull();
  });

  it("falls back to an error block with the raw source when render throws", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    const CodeBlock = await importCodeBlock();

    render(<CodeBlock lang="mermaid" code="gra ph TD; ??" />);

    expect(
      await screen.findByText(/Mermaid diagram error: Parse error on line 2/),
    ).toBeInTheDocument();
    expect(screen.getByText("gra ph TD; ??")).toBeInTheDocument();
  });
});
