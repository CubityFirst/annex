import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("renders the terms title and key sections", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: /terms of service/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /acceptable use/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /fair use/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /payments, subscriptions, and refunds/i })).toBeInTheDocument();
  });

  it("shows the logged-out nav when no token is present", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /login/i })).toBeInTheDocument();
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

  it("exposes a contact mailto link", () => {
    renderPage();
    const mail = screen.getByRole("link", { name: /cubity@cubityfir\.st/i });
    expect(mail).toHaveAttribute("href", expect.stringContaining("mailto:cubity@cubityfir.st"));
  });
});
