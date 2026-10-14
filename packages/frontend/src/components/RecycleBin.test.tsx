import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/apiFetch", () => ({ apiFetchJson: vi.fn() }));
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

import { apiFetchJson } from "@/lib/apiFetch";
import { RecycleBin } from "./RecycleBin";
import type { TrashEntry, TrashListing } from "@/lib/trash";

const entry = (over: Partial<TrashEntry> = {}): TrashEntry => ({
  id: "t1",
  item_type: "folder",
  item_id: "fold1",
  name: "Old notes",
  folder_id: "parent",
  folder_path: "Archive",
  doc_count: 2,
  file_count: 1,
  folder_count: 0,
  size: 2048,
  deleted_by: "u1",
  deleted_by_name: "Alice",
  deleted_at: new Date().toISOString(),
  ...over,
});

function listing(over: Partial<TrashListing> = {}): TrashListing {
  return { entries: [entry()], retentionDays: 30, canPurge: false, ...over };
}

function renderBin() {
  render(
    <MemoryRouter>
      <RecycleBin projectId="p1" />
    </MemoryRouter>,
  );
}

const fetchMock = vi.mocked(apiFetchJson);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RecycleBin", () => {
  it("lists binned entries with their origin, contents and deleter", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, data: listing() } as never);
    renderBin();
    expect(await screen.findByText("Old notes")).toBeInTheDocument();
    expect(screen.getByText(/from Archive · 2 docs, 1 file · 2\.0 KB · deleted just now by Alice/)).toBeInTheDocument();
    expect(screen.getByText("30d left")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/trash");
  });

  it("hides delete-forever and Empty bin from a non-admin", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, data: listing({ canPurge: false }) } as never);
    renderBin();
    await screen.findByText("Old notes");
    expect(screen.queryByRole("button", { name: /delete old notes forever/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /empty bin/i })).not.toBeInTheDocument();
    expect(screen.getByText(/only admins can delete items forever/i)).toBeInTheDocument();
  });

  it("restores an entry, drops it from the list and explains a root fallback", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, data: listing() } as never)
      .mockResolvedValueOnce({ ok: true, data: { type: "folder", itemId: "fold1", folderId: null } } as never);
    renderBin();
    await userEvent.click(await screen.findByRole("button", { name: /restore old notes/i }));

    expect(fetchMock).toHaveBeenLastCalledWith("/api/projects/p1/trash/t1/restore", { method: "POST" });
    await waitFor(() => expect(screen.queryByText("Old notes")).not.toBeInTheDocument());
    expect(screen.getByText(/recycle bin is empty/i)).toBeInTheDocument();
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Restored "Old notes"',
      description: expect.stringMatching(/original folder no longer exists/),
      action: expect.objectContaining({ label: "Open" }),
    }));
  });

  it("lets an admin delete an entry forever after confirming", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, data: listing({ canPurge: true }) } as never)
      .mockResolvedValueOnce({ ok: true, data: { deleted: true } } as never);
    renderBin();
    await userEvent.click(await screen.findByRole("button", { name: /delete old notes forever/i }));
    // The confirmation spells out the folder's contents.
    expect(screen.getByText(/everything in it \(2 docs, 1 file\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete forever" }));

    expect(fetchMock).toHaveBeenLastCalledWith("/api/projects/p1/trash/t1", { method: "DELETE" });
    await waitFor(() => expect(screen.queryByText("Old notes")).not.toBeInTheDocument());
  });

});
