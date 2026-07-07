import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FileEmbedInner } from "./FileEmbedWidget";
import { RendererReactContext, defaultRendererCtx } from "../context/RendererContext";
import { formatBytes } from "@/lib/fileManager";

vi.mock("@/lib/apiFetch", () => ({
  apiFetch: vi.fn(),
  apiFetchJson: vi.fn(),
}));

import { apiFetchJson } from "@/lib/apiFetch";
const apiFetchJsonMock = vi.mocked(apiFetchJson);

function renderEmbed(fileId: string) {
  return render(
    <RendererReactContext.Provider value={defaultRendererCtx}>
      <FileEmbedInner fileId={fileId} />
    </RendererReactContext.Provider>,
  );
}

beforeEach(() => {
  apiFetchJsonMock.mockReset();
});

describe("FileEmbedInner - id validation (W-S2)", () => {
  it("an unsafe fence body never issues a fetch and disables Download", () => {
    renderEmbed("../projects");
    expect(apiFetchJsonMock).not.toHaveBeenCalled();
    expect(screen.getByText("Attachment")).toBeInTheDocument();
    expect(screen.getByText("File")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download/i })).toBeDisabled();
  });

  it("a safe id fetches metadata from the encoded API path", async () => {
    apiFetchJsonMock.mockResolvedValue({
      ok: true,
      data: { name: "report.pdf", mime_type: "application/pdf", size: 2048 },
    } as Awaited<ReturnType<typeof apiFetchJson>>);
    renderEmbed("file-meta-ok");
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());
    expect(apiFetchJsonMock).toHaveBeenCalledWith("/api/files/file-meta-ok");
  });
});

describe("FileEmbedInner - metadata rendering and fallbacks", () => {
  it("shows the file name and formatBytes size on success", async () => {
    apiFetchJsonMock.mockResolvedValue({
      ok: true,
      data: { name: "notes.txt", mime_type: "text/plain", size: 5 * 1024 * 1024 },
    } as Awaited<ReturnType<typeof apiFetchJson>>);
    renderEmbed("file-size-fmt");
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());
    expect(screen.getByText(formatBytes(5 * 1024 * 1024))).toBeInTheDocument();
    expect(screen.getByText("5.0 MB")).toBeInTheDocument();
    // Metadata is decoration only - Download stays enabled.
    expect(screen.getByRole("button", { name: /download/i })).toBeEnabled();
  });

  it("falls back to a generic card when the metadata fetch fails", async () => {
    apiFetchJsonMock.mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof apiFetchJson>>);
    renderEmbed("file-meta-403");
    await waitFor(() => expect(screen.getByText("Attachment")).toBeInTheDocument());
    expect(screen.getByText("File")).toBeInTheDocument();
    // A viewer who can fetch bytes but not metadata still gets a working button.
    expect(screen.getByRole("button", { name: /download/i })).toBeEnabled();
  });

  it("falls back when the metadata fetch rejects", async () => {
    apiFetchJsonMock.mockRejectedValue(new Error("network"));
    renderEmbed("file-meta-neterr");
    await waitFor(() => expect(screen.getByText("Attachment")).toBeInTheDocument());
  });

  it("shows a loading label before metadata resolves", () => {
    apiFetchJsonMock.mockReturnValue(new Promise(() => {}) as ReturnType<typeof apiFetchJson>);
    renderEmbed("file-meta-pending");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("dedups concurrent metadata fetches for the same file (W-M5)", async () => {
    apiFetchJsonMock.mockResolvedValue({
      ok: true,
      data: { name: "shared.bin", mime_type: "application/octet-stream", size: 10 },
    } as Awaited<ReturnType<typeof apiFetchJson>>);
    render(
      <RendererReactContext.Provider value={defaultRendererCtx}>
        <FileEmbedInner fileId="file-dedup" />
        <FileEmbedInner fileId="file-dedup" />
      </RendererReactContext.Provider>,
    );
    await waitFor(() => expect(screen.getAllByText("shared.bin")).toHaveLength(2));
    expect(apiFetchJsonMock).toHaveBeenCalledTimes(1);
  });
});
