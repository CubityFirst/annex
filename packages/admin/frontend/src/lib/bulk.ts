import { RateLimitedError } from "@/lib/api";

export interface BulkResult {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface BulkOptions {
  onProgress?: (done: number, total: number) => void;
  // Injectable for tests.
  sleep?: (ms: number) => Promise<void>;
  // The admin worker allows 60 requests/min per IP, so a 429 clears within
  // a minute; four 15s waits cover that without hanging forever.
  retryDelayMs?: number;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Runs `action` for each id one at a time (never in parallel - each call can
// be heavy server-side, and parallel calls would burn the rate limit). A
// rate-limited call waits and retries; any other failure is recorded and the
// run moves on to the next id.
export async function runBulk(
  ids: string[],
  action: (id: string) => Promise<void>,
  { onProgress, sleep = defaultSleep, retryDelayMs = 15_000, maxRetries = 4 }: BulkOptions = {},
): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] };
  for (const [i, id] of ids.entries()) {
    for (let attempt = 0; ; attempt++) {
      try {
        await action(id);
        result.succeeded.push(id);
        break;
      } catch (e) {
        if (e instanceof RateLimitedError && attempt < maxRetries) {
          await sleep(retryDelayMs);
          continue;
        }
        result.failed.push({ id, error: e instanceof Error ? e.message : String(e) });
        break;
      }
    }
    onProgress?.(i + 1, ids.length);
  }
  return result;
}
