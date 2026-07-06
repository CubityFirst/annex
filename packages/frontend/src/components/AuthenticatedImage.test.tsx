import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthenticatedImage } from "./AuthenticatedImage";
import { HELP_MISSING_IMAGES_URL } from "@/lib/helpLinks";
import { apiFetch } from "@/lib/apiFetch";

vi.mock("@/lib/apiFetch", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

// jsdom's Blob has no arrayBuffer(); polyfill it via FileReader (which jsdom
// does implement) so the component's byte-handling paths run.
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(this);
    });
  };
}

// A minimal Response stand-in for the two fields the component reads.
function blobResponse(blob: Blob): Response {
  return { ok: true, blob: () => Promise.resolve(blob) } as unknown as Response;
}

// jsdom has no createObjectURL; stub it and capture the blobs it was handed.
const createdBlobs: Blob[] = [];

beforeEach(() => {
  apiFetchMock.mockReset();
  createdBlobs.length = 0;
  URL.createObjectURL = vi.fn((b: Blob) => {
    createdBlobs.push(b);
    return `blob:mock-${createdBlobs.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
});

// NOTE: the component dedups fetches in a module-level cache keyed by src, so
// every test uses a distinct file id to stay isolated.

describe("AuthenticatedImage", () => {
  it("serves SVG bytes through a data: URL, never a same-origin blob: URL", async () => {
    // The server deliberately ships SVG as octet-stream; a same-origin blob URL
    // re-typed to image/svg+xml would be navigable and execute scripted SVG in
    // the app origin. data: URLs carry no origin and can't be navigated to.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
    apiFetchMock.mockResolvedValue(blobResponse(new Blob([svg], { type: "application/octet-stream" })));

    render(<AuthenticatedImage src="/api/files/svg-1/content" alt="pic.svg" mimeType="image/svg+xml" />);

    const img = await screen.findByRole("img");
    const src = img.getAttribute("src")!;
    expect(src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(atob(src.slice("data:image/svg+xml;base64,".length))).toBe(svg);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("re-types non-SVG bytes onto a blob: URL with the declared MIME", async () => {
    apiFetchMock.mockResolvedValue(blobResponse(new Blob(["png-bytes"], { type: "application/octet-stream" })));

    render(<AuthenticatedImage src="/api/files/png-1/content" alt="pic.png" mimeType="image/png" />);

    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]!.type).toBe("image/png");
  });

  it("renders the unavailable badge with the configurable help link on fetch failure", async () => {
    apiFetchMock.mockResolvedValue({ ok: false } as Response);

    render(<AuthenticatedImage src="/api/files/missing-1/content" alt="gone.png" />);

    expect(await screen.findByText(/Image unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /image unavailable/i }))
      .toHaveAttribute("href", HELP_MISSING_IMAGES_URL);
  });

  it("public mode rewrites /api/files/ to /api/public/files/ with projectId, no authed fetch", async () => {
    render(<AuthenticatedImage src="/api/files/pub-1/content" alt="p.png" isPublic projectId="proj9" />);

    const img = await screen.findByRole("img");
    expect(img).toHaveAttribute("src", "/api/public/files/pub-1/content?projectId=proj9");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
