import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NotFoundPage } from "./NotFoundPage";
import { NotFound404 } from "./NotFound404";

describe("NotFoundPage", () => {
  it("renders the 404 shell with the workspace copy and a home CTA", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /404 - page not found/i })).toBeInTheDocument();
    expect(screen.getByText(/does not exist in this workspace/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /report a broken link/i })).toHaveAttribute(
      "href",
      expect.stringContaining("mailto:"),
    );
    // Global catch-all wears the marketing chrome: nav home link + shared footer.
    expect(screen.getByRole("link", { name: /annex home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  });
});

describe("NotFound404", () => {
  it("renders an internal primary CTA as a router link", () => {
    render(
      <MemoryRouter>
        <NotFound404 subtitle="Nothing here." primaryLabel="Go back to Docs" primaryHref="/docs" />
      </MemoryRouter>,
    );
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go back to docs/i })).toHaveAttribute("href", "/docs");
    // Bare by default (custom domains / public readers): no Annex nav or footer.
    expect(screen.queryByRole("link", { name: /annex home/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });

  it("renders an external primary CTA as a new-tab anchor and honours a custom status", () => {
    render(
      <MemoryRouter>
        <NotFound404
          subtitle="Gone."
          primaryLabel="Visit site"
          primaryHref="https://example.com"
          status="410"
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /410 - page not found/i })).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /visit site/i });
    expect(cta).toHaveAttribute("href", "https://example.com");
    expect(cta).toHaveAttribute("target", "_blank");
    expect(cta).toHaveAttribute("rel", "noopener noreferrer");
  });
});
