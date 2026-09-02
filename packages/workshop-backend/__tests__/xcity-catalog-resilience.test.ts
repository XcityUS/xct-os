// Resilience of the Xcity model/agent/key fetch paths against transient upstream failures:
// one-shot retries, stale-while-revalidate serving, and stale-on-error fallbacks.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearXcityAgentCatalogCacheForTests,
  flushXcityAgentCatalogRefreshForTests,
  listXcityAgents,
} from "../src/xcity/agent-catalog.js";
import {
  clearXcityAgentPersonaCacheForTests,
  getXcityAgentPersona,
} from "../src/xcity/agent-persona.js";
import { fetchWithOneRetry } from "../src/xcity/fetch-retry.js";
import {
  XcityModelPlane,
  XCITY_DEFAULT_MODEL_ID,
  flushXcityCatalogRefreshesForTests,
  getXcityModelMetadata,
  parseTokenhubModelCatalog,
  type XcityModelPlaneCache,
  type XcityModelPlaneStorage,
} from "../src/xcity/model-plane.js";

const ENV = {
  XCITY_HOME_URL: "https://xcity.ai",
  XCITY_TOKENHUB_URL: "https://tokenhub.xcity.ai",
  XCITY_WALLET_URL: "https://wallet.xcity.ai",
  WALLET_SERVICE_TOKEN: "wallet-service-token",
} as unknown as Cloudflare.Env;

const CONFIG = {
  tokenhubUrl: "https://tokenhub.xcity.ai",
  walletUrl: "https://wallet.xcity.ai",
  walletServiceToken: "wallet-service-token",
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeStorage(initial: XcityModelPlaneCache = {}): XcityModelPlaneStorage {
  let value = initial;
  return {
    get: () => value,
    put: next => { value = next; },
    subscribe: () => {},
    unsubscribe: () => {},
  };
}

// Storage pre-populated with a minted key and a catalog fetched `catalogAgeMs` ago.
function seededStorage(
    userId: string,
    catalogAgeMs: number,
    rawModels: unknown[] = [{ id: "cached-model" }],
): XcityModelPlaneStorage {
  const mintedAt = 111;
  const models = parseTokenhubModelCatalog({ data: rawModels }, {
    tokenhubUrl: CONFIG.tokenhubUrl,
    apiKey: "sk-old",
    xcityUserId: userId,
  })!;
  return makeStorage({
    key: {
      userId,
      walletUrl: CONFIG.walletUrl,
      key: "sk-old",
      mintedAt,
    },
    catalog: {
      tokenhubUrl: CONFIG.tokenhubUrl,
      keyMintedAt: mintedAt,
      fetchedAt: Date.now() - catalogAgeMs,
      models,
    },
  });
}

function agentEntry(slug: string) {
  return { id: `id-${slug}`, slug, displayName: slug };
}

function agentCatalogResponse(...slugs: string[]): Response {
  return jsonResponse({ degraded: false, data: slugs.map(agentEntry) });
}

afterEach(async () => {
  // Drain background refreshes before unstubbing fetch so nothing hits the real network.
  await flushXcityCatalogRefreshesForTests();
  await flushXcityAgentCatalogRefreshForTests();
  await clearXcityAgentCatalogCacheForTests();
  clearXcityAgentPersonaCacheForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchWithOneRetry", () => {
  it("retries once when the first attempt returns a 5xx", async () => {
    const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("boom", { status: 503 }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithOneRetry("https://upstream.example/x", () => ({}));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once when the first attempt times out", async () => {
    const fetchMock = vi.fn()
        .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithOneRetry("https://upstream.example/x", () => ({}));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a 4xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithOneRetry("https://upstream.example/x", () => ({}));
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands the caller the second failure as-is", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithOneRetry("https://upstream.example/x", () => ({}));
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("builds a fresh init per attempt", async () => {
    const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("boom", { status: 500 }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const makeInit = vi.fn(() => ({ signal: AbortSignal.timeout(10_000) }));

    await fetchWithOneRetry("https://upstream.example/x", makeInit);
    expect(makeInit).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect(first.signal).not.toBe(second.signal);
  });
});

describe("Xcity model catalog resilience", () => {
  it("serves a stale catalog immediately and revalidates in the background", async () => {
    const storage = seededStorage("user-swr", 11 * MINUTE_MS);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://tokenhub.xcity.ai/v1/models") {
        return jsonResponse({ data: [{ id: "fresh-model" }] });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-swr");
    // The stale catalog is served without waiting for tokenhub.
    expect(plane.getModelList().map(profile => profile.id)).toEqual(["cached-model"]);

    await flushXcityCatalogRefreshesForTests();
    expect(storage.get().catalog?.models.map(model => model.profile.id))
        .toEqual(["fresh-model"]);
    expect(plane.getModelList().map(profile => profile.id)).toEqual(["fresh-model"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the stale catalog when the background refresh fails", async () => {
    const storage = seededStorage("user-swr-fail", 11 * MINUTE_MS);
    const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-swr-fail");
    expect(plane.getModelList().map(profile => profile.id)).toEqual(["cached-model"]);

    await flushXcityCatalogRefreshesForTests();
    // The failed refresh (initial attempt + one retry) never discards the cached catalog.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.get().catalog?.models.map(model => model.profile.id))
        .toEqual(["cached-model"]);
    expect(plane.getModelList().map(profile => profile.id)).toEqual(["cached-model"]);
  });

  it("falls back to a very old catalog when an inline refresh fails", async () => {
    const storage = seededStorage("user-ancient", 25 * HOUR_MS);
    const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-ancient");
    // Past the stale ceiling the refresh is inline (key was cached, catalog + retry = 2 calls),
    // but its failure still surfaces the old catalog rather than an empty list.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(plane.getModelList().map(profile => profile.id)).toEqual(["cached-model"]);
  });

  it("retries the catalog fetch once through a transient 500", async () => {
    const storage = makeStorage();
    let modelCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        modelCalls++;
        if (modelCalls === 1) return new Response("cold start", { status: 500 });
        return jsonResponse({ data: [{ id: "warm-model" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-retry");
    expect(plane.getModelList().map(profile => profile.id)).toEqual(["warm-model"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx key mint and resolves with an empty list", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-4xx");
    expect(plane.getModelList()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("swallows total upstream failure (prewarm-safe)", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn(async () => { throw new TypeError("network down"); });
    vi.stubGlobal("fetch", fetchMock);

    // Both prewarm building blocks resolve instead of throwing when everything is down.
    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-down");
    expect(plane.getModelList()).toEqual([]);
    await expect(listXcityAgents(ENV)).resolves.toEqual([]);
  });
});

describe("Xcity agent catalog resilience", () => {
  it("serves a stale catalog and keeps it when revalidation fails", async () => {
    let now = 10_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const fetchMock = vi.fn(async () => ++calls === 1
        ? agentCatalogResponse("builder")
        : new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);

    now += 6 * MINUTE_MS;
    // Stale: served immediately, revalidated in the background (attempt + retry both 500).
    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
    await flushXcityAgentCatalogRefreshForTests();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
  });

  it("updates the cache from a successful background refresh", async () => {
    let now = 20_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const fetchMock = vi.fn(async () => ++calls === 1
        ? agentCatalogResponse("builder")
        : agentCatalogResponse("planner"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);

    now += 6 * MINUTE_MS;
    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
    await flushXcityAgentCatalogRefreshForTests();

    // The refreshed catalog is now fresh, so this is served from cache without a new fetch.
    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "planner" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a degraded refresh as a failure and keeps the stale catalog", async () => {
    let now = 30_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const fetchMock = vi.fn(async () => ++calls === 1
        ? agentCatalogResponse("builder")
        : jsonResponse({ degraded: true, data: [agentEntry("degraded-agent")] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);

    now += 6 * MINUTE_MS;
    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
    await flushXcityAgentCatalogRefreshForTests();
    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
  });

  it("serves a very old catalog when the inline refresh fails", async () => {
    let now = 40_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const fetchMock = vi.fn(async () => ++calls === 1
        ? agentCatalogResponse("builder")
        : new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);

    now += 25 * HOUR_MS;
    // Past the stale ceiling the refresh is inline; its failure still serves the old catalog.
    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("warms a fresh isolate from the Workers edge cache without hitting xct-home", async () => {
    const edgeCache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    expect(edgeCache).toBeDefined();
    await edgeCache!.put("https://xcity.ai/api/catalog/agents", new Response(
        JSON.stringify({ fetchedAt: Date.now(), agents: [agentEntry("builder")] }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" },
        }));

    const fetchMock = vi.fn(async () => { throw new TypeError("network down"); });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Xcity agent persona resilience", () => {
  it("retries the persona fetch once through a transient 500", async () => {
    const storage = makeStorage();
    let personaCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-user" });
      }
      if (url.startsWith("https://tokenhub.xcity.ai/v1/xct-skills?")) {
        return jsonResponse({
          data: [{ skill_id: "uuid-builder", xct_metadata: { xct_agent_slug: "builder" } }],
          has_more: false,
        });
      }
      if (url === "https://tokenhub.xcity.ai/v1/xct-skills/uuid-builder") {
        personaCalls++;
        if (personaCalls === 1) return new Response("cold start", { status: 500 });
        return jsonResponse({ system_prompt_template: "Build with care." });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getXcityAgentPersona(
        ENV, CONFIG, storage, { userId: "user-123", email: "user@example.com" }, "builder"))
        .resolves.toBe("Build with care.");
    // Key mint + skill index + persona (500) + persona retry.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("Xcity default model fallback", () => {
  it("serves the hard-coded default when the catalog comes back empty", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") return jsonResponse({ data: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-empty-catalog");
    expect(plane.getModelList().map(profile => profile.id)).toEqual([XCITY_DEFAULT_MODEL_ID]);

    // It is chattable: resolvable, quick-model-picked, and carrying the user's minted key.
    const quick = plane.getQuickModelConfig();
    expect(quick?.model).toBe(XCITY_DEFAULT_MODEL_ID);
    expect(quick?.apiToken).toBe("sk-user");
    expect(plane.resolveModel(XCITY_DEFAULT_MODEL_ID)?.config.apiUrl)
        .toBe("https://tokenhub.xcity.ai/v1");

    // Diagnostics keep describing what the gateway actually returned, not what was synthesized.
    expect(plane.getDiagnostics().catalog).toEqual({ status: 200, modelCount: 0 });
    // The fallback is served, never stored, so it cannot shadow a later real catalog entry.
    expect(storage.get().catalog?.models).toEqual([]);
  });

  it("replaces the synthesized default with the real catalog entry", async () => {
    const storage = seededStorage("user-default-swr", 11 * MINUTE_MS, []);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://tokenhub.xcity.ai/v1/models") {
        return jsonResponse({
          data: [{ id: XCITY_DEFAULT_MODEL_ID, input_cost_per_token: 0.01 }],
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-default-swr");
    // The stale catalog is empty, so the fallback stands in while it revalidates.
    expect(plane.getModelList().map(profile => profile.id)).toEqual([XCITY_DEFAULT_MODEL_ID]);
    expect(getXcityModelMetadata(plane.resolveModel(XCITY_DEFAULT_MODEL_ID)!.config))
        .toMatchObject({ synthesizedFallback: true });

    await flushXcityCatalogRefreshesForTests();
    // Exactly one entry for the id — the real one, with the catalog's own metadata.
    expect(plane.getModelList().map(profile => profile.id)).toEqual([XCITY_DEFAULT_MODEL_ID]);
    const metadata = getXcityModelMetadata(plane.resolveModel(XCITY_DEFAULT_MODEL_ID)!.config);
    expect(metadata?.synthesizedFallback).toBeUndefined();
    expect(metadata?.inputCostPerToken).toBe(0.01);
    expect(storage.get().catalog?.models.map(model => model.profile.id))
        .toEqual([XCITY_DEFAULT_MODEL_ID]);
  });
});

// The wallet repairs a key whose model grant was never expanded (a literal `*`) inside
// POST /v1/keys/for-user. Only a forced re-mint calls it, so a sentinel-only catalog has to
// force one, or the cached key stays broken forever and no amount of re-logging-in helps.
describe("Xcity grant self-heal", () => {
  it("re-mints through the wallet and re-fetches when the catalog holds only sentinels",
      async () => {
    const storage = makeStorage();
    let mintCalls = 0;
    let modelCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: `sk-${++mintCalls}` });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return ++modelCalls === 1
            ? jsonResponse({ data: [{ id: "*" }] })
            : jsonResponse({ data: [{ id: "real-model" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-heal");
    expect(plane.getModelList().map(profile => profile.id)).toEqual(["real-model"]);
    // Initial mint plus the repair mint that actually runs the wallet-side reconciler.
    expect(mintCalls).toBe(2);
    expect(modelCalls).toBe(2);
    // The re-minted key replaces the cached one and is what the served models authenticate with.
    expect(storage.get().key?.key).toBe("sk-2");
    expect(plane.resolveModel("real-model")?.config.apiToken).toBe("sk-2");
    // Diagnostics describe the final attempt: no lingering sentinel state.
    expect(plane.getDiagnostics().catalog).toEqual({ status: 200, modelCount: 1 });
    expect(storage.get().catalog?.grantNotExpanded).toBeUndefined();
  });

  it("retries once and settles into grantNotExpanded when the key is still broken", async () => {
    const storage = makeStorage();
    let mintCalls = 0;
    let modelCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: `sk-${++mintCalls}` });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        modelCalls++;
        return jsonResponse({ data: [{ id: "*" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-still-broken");
    // Exactly one repair attempt: no loop.
    expect(mintCalls).toBe(2);
    expect(modelCalls).toBe(2);
    expect(plane.getDiagnostics().catalog).toEqual({
      status: 200, modelCount: 0, grantNotExpanded: true,
    });
    expect(storage.get().catalog).toMatchObject({ models: [], grantNotExpanded: true });
    // ...and the user is still left with the hard-coded default to chat with.
    expect(plane.getModelList().map(profile => profile.id)).toEqual([XCITY_DEFAULT_MODEL_ID]);
  });

  it("forces the repair mint even though the cached key would have been reused", async () => {
    const mintedAt = 111;
    const storage = makeStorage({
      key: {
        userId: "user-cached-sentinel",
        walletUrl: CONFIG.walletUrl,
        key: "sk-broken",
        mintedAt,
      },
      catalog: {
        tokenhubUrl: CONFIG.tokenhubUrl,
        keyMintedAt: mintedAt,
        fetchedAt: Date.now(),
        models: [],
        grantNotExpanded: true,
      },
    });
    let mintCalls = 0;
    let modelCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        mintCalls++;
        return jsonResponse({ key: "sk-repaired" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return ++modelCalls === 1
            ? jsonResponse({ data: [{ id: "*" }] })
            : jsonResponse({ data: [{ id: "real-model" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-cached-sentinel");
    // The cached key served the first fetch (no mint), the sentinel result forced the second.
    expect(mintCalls).toBe(1);
    expect(modelCalls).toBe(2);
    expect(storage.get().key?.key).toBe("sk-repaired");
    expect(plane.getModelList().map(profile => profile.id)).toEqual(["real-model"]);
  });

  it("keeps reporting the sentinel catalog when the repair mint fails", async () => {
    const storage = makeStorage();
    let mintCalls = 0;
    let modelCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return ++mintCalls === 1
            ? jsonResponse({ key: "sk-user" })
            : new Response("nope", { status: 403 });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        modelCalls++;
        return jsonResponse({ data: [{ id: "*" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-mint-fails");
    // No second catalog attempt happened, so the first one's outcome stays the final word.
    expect(modelCalls).toBe(1);
    expect(plane.getDiagnostics().catalog).toEqual({
      status: 200, modelCount: 0, grantNotExpanded: true,
    });
    expect(plane.getDiagnostics().keyMint).toMatchObject({ attempted: true, status: 403 });
    expect(storage.get().catalog).toMatchObject({ models: [], grantNotExpanded: true });
  });

  it("reports the retry's own failure when the re-fetch fails", async () => {
    const storage = makeStorage();
    let modelCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return ++modelCalls === 1
            ? jsonResponse({ data: [{ id: "*" }] })
            : new Response("down", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const plane = await XcityModelPlane.forUser(ENV, CONFIG, storage, "user-retry-fails");
    // Sentinel fetch, then the retry's 500 plus its one transient retry.
    expect(modelCalls).toBe(3);
    // Same as the 401 path: the final attempt's failure is what gets reported.
    expect(plane.getDiagnostics().catalog).toEqual({ status: 500 });
    // Nothing was persisted, and the default still stands in for the empty list.
    expect(storage.get().catalog).toBeUndefined();
    expect(plane.getModelList().map(profile => profile.id)).toEqual([XCITY_DEFAULT_MODEL_ID]);
  });
});
