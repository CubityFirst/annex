import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { PrivacyPage } from "./PrivacyPage";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/privacy"]}>
      <Routes>
        <Route path="/privacy" element={<PrivacyPage />} />
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

describe("PrivacyPage", () => {

  it("shows the logged-out nav (login + get started) when no token is present", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /login/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /get started/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to dashboard/i })).not.toBeInTheDocument();
  });

  it("shows the dashboard CTA when a token is present", () => {
    window.localStorage.setItem("token", "jwt-abc");
    renderPage();
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^login$/i })).not.toBeInTheDocument();
  });

  it("renders the shared site footer with the standard link set", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Terms" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Acknowledgements" })).toBeInTheDocument();
  });

  it("links out to Stripe's privacy policy", () => {
    renderPage();
    const stripe = screen.getByRole("link", { name: /stripe\.com\/privacy/i });
    expect(stripe).toHaveAttribute("href", "https://stripe.com/privacy");
  });
});
