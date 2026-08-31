// One-shot retry for Xcity upstream fetches.
//
// tokenhub / wallet / xct-home run on Railway, where cold starts and restarts make a single
// fetch attempt flaky. A single short retry absorbs most of those blips without meaningfully
// delaying genuine failures.

import { createWorkshopLogger } from "../observability.js";

const logger = createWorkshopLogger("workshop.xcity.fetch-retry");

/**
 * Pause before the single retry: long enough to ride out a proxy hiccup or an instance handoff,
 * short enough that a genuinely-down upstream still fails a blocking caller quickly.
 */
export const TRANSIENT_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch `url`, retrying exactly once on transient failure: a thrown fetch (network error or
 * timeout) or a >= 500 response. 4xx responses are returned immediately and never retried.
 *
 * `makeInit` is invoked once per attempt so each attempt carries its own fresh
 * `AbortSignal.timeout(...)`. The second attempt's outcome — success, error response, or throw —
 * is handed to the caller as-is.
 */
export async function fetchWithOneRetry(
    url: string | URL, makeInit: () => RequestInit): Promise<Response> {
  let firstFailure: { status: number } | { error: unknown };
  try {
    let response = await fetch(url, makeInit());
    if (response.status < 500) return response;
    response.body?.cancel();
    firstFailure = { status: response.status };
  } catch (error) {
    firstFailure = { error };
  }

  logger.info("retrying xcity upstream fetch after transient failure", {
    event: "xcity.fetch.retry",
    path: String(url),
    ...firstFailure,
  });
  await sleep(TRANSIENT_RETRY_DELAY_MS);
  return fetch(url, makeInit());
}
