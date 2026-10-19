import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeletePreviewUser } from "@/lib/api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  previewUserDeletion: vi.fn(),
  scheduleUserDeletion: vi.fn(async () => ({ execute_after: 0 })),
}));

import { previewUserDeletion, scheduleUserDeletion } from "@/lib/api";
import { BulkDeleteUsersDialog, planDeletion } from "./BulkDeleteUsersDialog";

function user(id: string, overrides: Partial<DeletePreviewUser> = {}): DeletePreviewUser {
  return {
    id,
    email: `${id}@x.com`,
    name: id,
    blocked: null,
    owned_sites: [],
    owned_orgs: [],
    has_stripe_customer: false,
    has_subscription: false,
    ...overrides,
  };
}

// Matches a <p> by its full text (summary sentences are split across spans).
const para = (re: RegExp) => screen.getByText((_, el) => el?.tagName === "P" && re.test(el.textContent ?? ""));

const SITE = { id: "p-1", name: "Big Site", docs: 40, other_members: 3, published: true };

describe("planDeletion", () => {
  it("skips blocked accounts and site owners who weren't explicitly confirmed", () => {
    const preview = [
      user("plain"),
      user("owner", { owned_sites: [SITE] }),
      user("me", { blocked: "self" }),
    ];
    const plan = planDeletion(preview, {});
    expect(plan.deletable.map(u => u.id)).toEqual(["plain"]);
    expect(plan.skipped.map(u => u.id)).toEqual(["owner", "me"]);
    expect(plan.sites).toEqual([]);
  });

  it("includes a site owner (and their sites) only once confirmed", () => {
    const plan = planDeletion([user("owner", { owned_sites: [SITE] })], { owner: true });
    expect(plan.deletable.map(u => u.id)).toEqual(["owner"]);
    expect(plan.sites).toEqual([SITE]);
  });

  it("never deletes a blocked account even if its box was ticked", () => {
    const plan = planDeletion([user("admin", { blocked: "admin", owned_sites: [SITE] })], { admin: true });
    expect(plan.deletable).toEqual([]);
  });
});

describe("BulkDeleteUsersDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags owned sites, skips their owner by default, and sends site ids only after the box is ticked", async () => {
    vi.mocked(previewUserDeletion).mockResolvedValue([
      user("plain"),
      user("owner", { owned_sites: [SITE] }),
    ]);
    const onScheduled = vi.fn();
    const ue = userEvent.setup();
    render(<BulkDeleteUsersDialog open onOpenChange={() => {}} userIds={["plain", "owner"]} onScheduled={onScheduled} />);

    // The site is flagged with its details before anything happens.
    expect(await screen.findByText("Big Site")).toBeInTheDocument();
    expect(para(/^1 account will be disabled now and deleted in 7 days; 1 skipped.$/)).toBeInTheDocument();
    expect(screen.queryByText(/will be permanently deleted with all docs/)).not.toBeInTheDocument();

    // Delete stays disabled until the confirm word is typed.
    const deleteButton = screen.getByRole("button", { name: "Schedule deletion (1 account)" });
    expect(deleteButton).toBeDisabled();

    // Opt in to deleting the owner's site: the warning appears and the count grows.
    await ue.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/1 site will be permanently deleted with all docs and files when the deletion runs: Big Site/)).toBeInTheDocument();

    await ue.type(screen.getByLabelText(/Type DELETE to confirm/), "DELETE");
    await ue.click(screen.getByRole("button", { name: "Schedule deletion (2 accounts)" }));

    await waitFor(() => expect(onScheduled).toHaveBeenCalledWith(["plain", "owner"]));
    expect(scheduleUserDeletion).toHaveBeenCalledWith("plain", { siteIds: [], orgIds: [] });
    expect(scheduleUserDeletion).toHaveBeenCalledWith("owner", { siteIds: ["p-1"], orgIds: [] });
  });

  it("after a failed delete, re-previews the remaining accounts and requires fresh consent", async () => {
    vi.mocked(previewUserDeletion)
      .mockResolvedValueOnce([user("owner", { owned_sites: [SITE] })])
      // The account no longer owns the site; the re-preview reflects that.
      .mockResolvedValueOnce([user("owner")]);
    vi.mocked(scheduleUserDeletion).mockRejectedValueOnce(new Error("a@x.com no longer owns the confirmed site(s) - review again"));
    const ue = userEvent.setup();
    render(<BulkDeleteUsersDialog open onOpenChange={() => {}} userIds={["owner"]} onScheduled={() => {}} />);

    await screen.findByText("Big Site");
    await ue.click(screen.getByRole("checkbox"));
    await ue.type(screen.getByLabelText(/Type DELETE to confirm/), "DELETE");
    await ue.click(screen.getByRole("button", { name: "Schedule deletion (1 account)" }));

    expect(await screen.findByText(/no longer owns the confirmed site/)).toBeInTheDocument();
    await waitFor(() => expect(previewUserDeletion).toHaveBeenCalledTimes(2));
    expect(previewUserDeletion).toHaveBeenLastCalledWith(["owner"]);
    await waitFor(() => expect(screen.queryByText("Big Site")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/Type DELETE to confirm/)).toHaveValue("");
  });

  it("does not delete a site owner when the box is left unticked", async () => {
    vi.mocked(previewUserDeletion).mockResolvedValue([user("plain"), user("owner", { owned_sites: [SITE] })]);
    const ue = userEvent.setup();
    render(<BulkDeleteUsersDialog open onOpenChange={() => {}} userIds={["plain", "owner"]} onScheduled={() => {}} />);

    await screen.findByText("Big Site");
    await ue.type(screen.getByLabelText(/Type DELETE to confirm/), "DELETE");
    await ue.click(screen.getByRole("button", { name: "Schedule deletion (1 account)" }));

    await waitFor(() => expect(scheduleUserDeletion).toHaveBeenCalledTimes(1));
    expect(scheduleUserDeletion).toHaveBeenCalledWith("plain", { siteIds: [], orgIds: [] });
  });
});
