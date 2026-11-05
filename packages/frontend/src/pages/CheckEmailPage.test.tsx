import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
vi.mock("@/components/DotGrid", () => ({ DotGrid: () => null }));

import { CheckEmailPage } from "./CheckEmailPage";

function renderWith(state: { email?: string } | null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/check-email", state }]}>
      <Routes>
        <Route path="/check-email" element={<CheckEmailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CheckEmailPage", () => {
  it("renders the heading and the address it sent to", () => {
    renderWith({ email: "user@example.com" });
    expect(screen.getByRole("heading", { name: /check your email/i })).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
  });

  it("shows a generic message and no resend button when no email is provided", () => {
    renderWith(null);
    expect(screen.getByText(/we sent you a verification link/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resend/i })).not.toBeInTheDocument();
  });

  it("resends the verification email and confirms it was sent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    renderWith({ email: "user@example.com" });

    await userEvent.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByText(/verification email resent/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/verify-email/resend",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "user@example.com" }) }),
    );
    // After a successful resend the button is cooled down.
    expect(screen.getByRole("button", { name: /email sent/i })).toBeDisabled();
  });

  it("shows an error when the resend request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    renderWith({ email: "user@example.com" });

    await userEvent.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByText(/failed to resend email/i)).toBeInTheDocument();
  });

  it("links back to sign in", () => {
    renderWith({ email: "user@example.com" });
    expect(screen.getByRole("link", { name: /back to sign in/i })).toHaveAttribute("href", "/login");
  });
});
