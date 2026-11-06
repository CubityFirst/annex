import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { TermsPage } from "./TermsPage";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/terms"]}>
      <Routes>
        <Route path="/terms" element={<TermsPage />} />
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

describe("TermsPage", () => {

  it("shows the logged-out nav when no token is present", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /get started/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to dashboard/i })).not.toBeInTheDocument();
  });

  it("shows the dashboard CTA when a token is present", () => {
    window.localStorage.setItem("token", "jwt-abc");
    renderPage();
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toBeInTheDocument();
  });

  it("renders the shared site footer with the standard link set", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Acknowledgements" })).toBeInTheDocument();
  });

  it("lists every section in the 'On this page' rail, linked to its heading", () => {
    renderPage();
    const toc = screen.getByRole("navigation", { name: /on this page/i });
    const links = within(toc).getAllByRole("link");
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(links).toHaveLength(headings.length);
    // The rail repeats the number visually (aria-hidden), so the accessible
    // name is the bare title; each link targets its heading's id.
    const payments = within(toc).getByRole("link", { name: "Payments, subscriptions and refunds" });
    const target = document.getElementById(payments.getAttribute("href")!.slice(1));
    expect(target?.textContent).toMatch(/^7\. Payments/);
    const num = payments.querySelector("[aria-hidden='true']");
    expect(num?.textContent).toBe("7");
  });

  it("exposes a contact mailto link", () => {
    renderPage();
    const mail = screen.getByRole("link", { name: /cubity@cubityfir\.st/i });
    expect(mail).toHaveAttribute("href", expect.stringContaining("mailto:cubity@cubityfir.st"));
  });
});
