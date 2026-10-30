import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AcknowledgementsPage } from "./AcknowledgementsPage";
import { ACKNOWLEDGEMENTS } from "@/lib/acknowledgements";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/acknowledgements"]}>
      <Routes>
        <Route path="/acknowledgements" element={<AcknowledgementsPage />} />
        <Route path="/login" element={<div>LOGIN</div>} />
        <Route path="/register" element={<div>REGISTER</div>} />
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("AcknowledgementsPage", () => {

  it("renders every entry from the ACKNOWLEDGEMENTS data list", () => {
    renderPage();
    for (const ack of ACKNOWLEDGEMENTS) {
      const link = screen.getByRole("link", { name: ack.name });
      expect(link).toHaveAttribute("href", ack.url);
      expect(link).toHaveAttribute("target", "_blank");
    }
  });

  it("shows the license next to a known library", () => {
    renderPage();
    // Scope to React's own row and assert ITS license, so a mis-paired
    // or hardcoded license can't be masked by the 31 other MIT entries.
    const reactRow = screen.getByRole("link", { name: "React" }).closest("li");
    expect(reactRow).not.toBeNull();
    const reactLicense = reactRow!.querySelector(".l-ack-license");
    expect(reactLicense?.textContent).toBe("MIT");

    // A non-MIT row proves per-entry license binding (not a hardcoded "MIT").
    const cvaRow = screen.getByRole("link", { name: "class-variance-authority" }).closest("li");
    expect(cvaRow).not.toBeNull();
    expect(cvaRow!.querySelector(".l-ack-license")?.textContent).toBe("Apache-2.0");

    const lucideRow = screen.getByRole("link", { name: "lucide-react" }).closest("li");
    expect(lucideRow).not.toBeNull();
    expect(lucideRow!.querySelector(".l-ack-license")?.textContent).toBe("ISC");
  });

  it("renders the shared site footer (links back to Acknowledgements)", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms" })).toBeInTheDocument();
  });
});
