import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryBanner } from "./HistoryBanner";

const BASE = {
  editorName: "Alice",
  createdAt: "2026-06-30T10:00:00Z",
  onBack: () => {},
};

describe("HistoryBanner", () => {
  it("mentions the revision's title when it differed at the time", () => {
    const { unmount } = render(<HistoryBanner {...BASE} title="Old name" />);
    expect(screen.getByText("Old name")).toBeInTheDocument();
    expect(screen.getByText(/at the time/)).toBeInTheDocument();
    unmount();
    render(<HistoryBanner {...BASE} />);
    expect(screen.queryByText(/at the time/)).not.toBeInTheDocument();
  });

  it("toggles between changes and document views", async () => {
    const onToggleDiff = vi.fn();
    const { rerender } = render(<HistoryBanner {...BASE} onToggleDiff={onToggleDiff} showingDiff={false} />);
    await userEvent.click(screen.getByRole("button", { name: "View changes" }));
    expect(onToggleDiff).toHaveBeenCalledTimes(1);
    rerender(<HistoryBanner {...BASE} onToggleDiff={onToggleDiff} showingDiff />);
    expect(screen.getByRole("button", { name: "View document" })).toBeInTheDocument();
  });

  it("confirms before reverting", async () => {
    const onRevert = vi.fn();
    render(<HistoryBanner {...BASE} onRevert={onRevert} />);
    await userEvent.click(screen.getByRole("button", { name: "Revert to this version" }));
    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.getByText(/restore the document's content and title/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(onRevert).toHaveBeenCalledTimes(1);
  });
});
