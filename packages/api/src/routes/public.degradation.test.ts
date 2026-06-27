import { describe, it, expect, vi } from "vitest";

// Force the presign helper to throw for one file so we can assert
// enrichFilesWithStreamUrls degrades THAT file to content_stream_url: null
// instead of rejecting the whole list - a rejection would 500 the entire
// published page (nav + docs + files), not just the offending video. Mocked in
// its own file so the real-signature assertions in public.test.ts stay intact.
vi.mock("../lib/r2Presign", () => ({
  PRESIGN_URL_TTL_SECONDS: 10800,
  presignR2GetUrl: vi.fn(),
}));

import { enrichFilesWithStreamUrls } from "./public";
import { presignR2GetUrl } from "../lib/r2Presign";
import type { Env } from "../index";

const ENV = {} as unknown as Env;

function vid(id: string) {
  return { id, name: `${id}.mp4`, mime_type: "video/mp4", size: 1, folder_id: null };
}

describe("enrichFilesWithStreamUrls - presign failure degradation", () => {
  it("nulls out only the failing file and never rejects the whole list", async () => {
    (presignR2GetUrl as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("https://r2.example/signed-a")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("https://r2.example/signed-c");

    const rows = await enrichFilesWithStreamUrls(ENV, [vid("a"), vid("b"), vid("c")]);

    expect(rows.map(r => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].content_stream_url).toBe("https://r2.example/signed-a");
    expect(rows[1].content_stream_url).toBeNull(); // degraded, not thrown
    expect(rows[2].content_stream_url).toBe("https://r2.example/signed-c");
  });
});
