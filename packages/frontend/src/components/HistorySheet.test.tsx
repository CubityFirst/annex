import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistorySheet, type RevisionMeta } from "./HistorySheet";

const REVS: RevisionMeta[] = [
  { id: "r2", editor_id: "u1", editor_name: "Alice", created_at: "2026-06-30T10:00:00Z", changelog: "Second pass", contributors: null, title: "Renamed title" },
  { id: "r1", editor_id: "u2", editor_name: "Bob", created_at: "2026-06-29T10:00:00Z", changelog: null, contributors: null, title: "Live title" },
];

function renderSheet(overrides: Partial<Parameters<typeof HistorySheet>[0]> = {}) {
  const onSelect = vi.fn();
  const onSelectCurrent = vi.fn();
  const onLoadMore = vi.fn();
  const utils = render(
    <HistorySheet
      open
      onOpenChange={() => {}}
      revisions={REVS}
      onSelect={onSelect}
      currentTitle="Live title"
      onSelectCurrent={onSelectCurrent}
      onLoadMore={onLoadMore}
      {...overrides}
    />,
  );
  return { ...utils, onSelect, onSelectCurrent, onLoadMore };
}

describe("HistorySheet", () => {
  it("shows skeleton rows while loading, and the empty state", () => {
    const { unmount } = renderSheet({ revisions: null });
    expect(screen.getByTestId("history-loading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Current version/ })).not.toBeInTheDocument();
    unmount();
    renderSheet({ revisions: [] });
    expect(screen.getByText(/No history yet/)).toBeInTheDocument();
  });

  it("pins a Current version entry that returns to the live doc", async () => {
    const { onSelectCurrent } = renderSheet();
    const current = screen.getByRole("button", { name: /Current version/ });
    expect(current).toHaveTextContent("Live title");
    // Nothing selected -> the current entry is the one marked as viewing.
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toHaveTextContent("Viewing");
    await userEvent.click(current);
    expect(onSelectCurrent).toHaveBeenCalledTimes(1);
  });

  it("marks the selected revision instead of the current entry when viewing one", () => {
    renderSheet({ selectedId: "r2" });
    const current = screen.getByRole("button", { name: /Current version/ });
    expect(current).not.toHaveAttribute("aria-current");
    const selected = screen.getByRole("button", { name: /Alice/ });
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(selected).toHaveTextContent("Viewing");
  });

  it("shows a revision's title only when it differs from the current doc title", () => {
    renderSheet();
    // r2 was saved under a different title - shown, quoted.
    expect(screen.getByText("“Renamed title”")).toBeInTheDocument();
    // r1's title matches the live title - no quoted title row.
    expect(screen.queryByText("“Live title”")).not.toBeInTheDocument();
  });

  it("selects a revision on click", async () => {
    const { onSelect } = renderSheet();
    await userEvent.click(screen.getByRole("button", { name: /Alice/ }));
    expect(onSelect).toHaveBeenCalledWith("r2");
  });

  it("shows Load more only when a full page was returned, and forwards clicks", async () => {
    const { onLoadMore, unmount } = renderSheet({ hasMore: true });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    unmount();

    renderSheet({ hasMore: false });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("disables Load more while a page is loading", () => {
    renderSheet({ hasMore: true, loadingMore: true });
    const btn = screen.getByRole("button", { name: "Loading…" });
    expect(btn).toBeDisabled();
  });

  it("groups revisions under Today / Yesterday / month headers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00"));
    try {
      renderSheet({
        revisions: [
          { id: "a", editor_id: "u1", editor_name: "Alice", created_at: "2026-07-01T09:00:00", changelog: null, contributors: null, title: null },
          { id: "b", editor_id: "u1", editor_name: "Alice", created_at: "2026-06-30T18:00:00", changelog: null, contributors: null, title: null },
          { id: "c", editor_id: "u1", editor_name: "Alice", created_at: "2026-06-30T09:00:00", changelog: null, contributors: null, title: null },
          { id: "d", editor_id: "u1", editor_name: "Alice", created_at: "2026-06-02T09:00:00", changelog: null, contributors: null, title: null },
        ],
      });
      expect(screen.getByText("Today")).toBeInTheDocument();
      // Two same-day revisions share one header.
      expect(screen.getAllByText("Yesterday")).toHaveLength(1);
      expect(screen.getByText("June 2026")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stacks contributor avatars with a +N chip on multi-editor revisions", () => {
    renderSheet({
      revisions: [{
        id: "collab",
        editor_id: "u1",
        editor_name: "Alice",
        created_at: "2026-06-30T10:00:00Z",
        changelog: null,
        contributors: JSON.stringify([
          { id: "u1", name: "Alice" }, { id: "u2", name: "Bob" },
          { id: "u3", name: "Cara" }, { id: "u4", name: "Dan" }, { id: "u5", name: "Eve" },
        ]),
        title: null,
      }],
    });
    // All contributors are credited in the name line...
    expect(screen.getByText("Alice, Bob, Cara, Dan, Eve")).toBeInTheDocument();
    // ...and the avatar stack shows three faces plus the overflow chip.
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("shows the revision count in the header, marked open-ended when more pages exist", () => {
    const { unmount } = renderSheet({ hasMore: true });
    expect(screen.getByText("· 2+")).toBeInTheDocument();
    unmount();
    renderSheet();
    expect(screen.getByText("· 2")).toBeInTheDocument();
  });
});
