// The /providers-page description of the user's default Xcity TokenHub provider: gated on
// configuration + identity, and never throwing — partial info beats an error page.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getXcityProviderInfoForUser } from "../src/xcity/provider-info.js";
import {
  XCITY_DEFAULT_MODEL_ID,
  flushXcityCatalogRefreshesForTests,
  type XcityModelPlaneCache,
  type XcityModelPlaneStorage,
} from "../src/xcity/model-plane.js";

const ENV = {
  XCITY_TOKENHUB_URL: "https://tokenhub.xcity.ai",
  XCITY_WALLET_URL: "https://wallet.xcity.ai",
  WALLET_SERVICE_TOKEN: "wallet-service-token",
} as unknown as Cloudflare.Env;

const IDENTITY = {
  userId: "01823f64-8ac8-715e-bf17-0f92801f2af3",
  email: "user@example.com",
};

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

afterEach(async () => {
  await flushXcityCatalogRefreshesForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getXcityProviderInfoForUser", () => {
  it("returns identity, the minted virtual key, and the tokenhub model ids", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return jsonResponse({ data: [{ id: "gpt-5.5-xhigh" }, { id: "cheap-model" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info).toEqual({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      email: "user@example.com",
      apiKey: "sk-tokenhub-user",
      modelIds: ["gpt-5.5-xhigh", "cheap-model"],
      catalog: [
        { id: "gpt-5.5-xhigh", name: "gpt-5.5-xhigh", hidden: false },
        { id: "cheap-model", name: "cheap-model", hidden: false },
      ],
      diagnostics: {
        identity: true,
        keyPresent: true,
        keyMint: { attempted: true, status: 200 },
        catalog: { status: 200, modelCount: 2 },
      },
    });
  });

  it("omits email when the identity has none", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return jsonResponse({ data: [{ id: "only-model" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(
        ENV, makeStorage(), { userId: IDENTITY.userId }, "fallback-login-id");
    expect(info).toEqual({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      apiKey: "sk-tokenhub-user",
      modelIds: ["only-model"],
      catalog: [{ id: "only-model", name: "only-model", hidden: false }],
      diagnostics: {
        identity: true,
        keyPresent: true,
        keyMint: { attempted: true, status: 200 },
        catalog: { status: 200, modelCount: 1 },
      },
    });
  });

  it("returns null when the Xcity model plane is not configured", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(
        {} as unknown as Cloudflare.Env, makeStorage(), IDENTITY);
    expect(info).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports identity:false (not null) when the user has no Xcity identity", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), null);
    expect(info).toEqual({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      modelIds: [],
      catalog: [],
      diagnostics: { identity: false, keyPresent: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still returns the minted key, with the default model, when the catalog fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return new Response("down", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info).toEqual({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      email: "user@example.com",
      apiKey: "sk-tokenhub-user",
      // The hard-coded default is synthesized so the user is not left with nothing to chat
      // with; the diagnostics below still report the catalog hop as it actually went.
      modelIds: [XCITY_DEFAULT_MODEL_ID],
      catalog: [{ id: XCITY_DEFAULT_MODEL_ID, name: XCITY_DEFAULT_MODEL_ID, hidden: false }],
      diagnostics: {
        identity: true,
        keyPresent: true,
        keyMint: { attempted: true, status: 200 },
        catalog: { status: 500 },
      },
    });
  });

  it("never throws even when every upstream is down", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("network down"); });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info).toEqual({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      email: "user@example.com",
      modelIds: [],
      catalog: [],
      diagnostics: {
        identity: true,
        keyPresent: false,
        keyMint: { attempted: true, error: "network-error" },
      },
    });
  });

  it("does not surface a stale key minted for a different user or wallet", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const storage = makeStorage({
      key: {
        userId: "someone-else",
        walletUrl: "https://wallet.xcity.ai",
        key: "sk-other-user",
        mintedAt: 111,
      },
    });
    const info = await getXcityProviderInfoForUser(ENV, storage, IDENTITY);
    expect(info).toEqual({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      email: "user@example.com",
      modelIds: [],
      catalog: [],
      diagnostics: {
        identity: true,
        keyPresent: false,
        keyMint: { attempted: true, status: 403 },
      },
    });
  });
});

// One diagnostics assertion per production failure mode behind "the /providers page shows zero
// models", so the page can name the hop that broke instead of showing a silent empty list.
describe("getXcityProviderInfoForUser diagnostics", () => {
  it("reports the mint status when the wallet rejects the service token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return new Response("unauthorized", { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: false,
      keyMint: { attempted: true, status: 401 },
    });
    expect(info?.apiKey).toBeUndefined();
    expect(info?.modelIds).toEqual([]);
  });

  it("classifies a wallet timeout without leaking the raw error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: false,
      keyMint: { attempted: true, error: "timeout" },
    });
  });

  it("reports a non-200 catalog status with the key already minted", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      return new Response("boom", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      keyMint: { attempted: true, status: 200 },
      catalog: { status: 500 },
    });
  });

  it("distinguishes a 200-but-empty catalog (the plan grants no models)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      keyMint: { attempted: true, status: 200 },
      catalog: { status: 200, modelCount: 0 },
    });
    // modelCount stays 0 — it describes the gateway — while the synthesized default is served.
    expect(info?.modelIds).toEqual([XCITY_DEFAULT_MODEL_ID]);
  });

  it("distinguishes a wildcard-only catalog (the key's grant was never expanded)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        // What litellm returns for a key minted with models: ["*"] — the sentinel verbatim.
        return jsonResponse({ data: [{ id: "*" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      keyMint: { attempted: true, status: 200 },
      catalog: { status: 200, modelCount: 0, grantNotExpanded: true },
    });
    // The sentinel is never offered as a selectable model; the hard-coded default is.
    expect(info?.modelIds).toEqual([XCITY_DEFAULT_MODEL_ID]);
    expect(info?.catalog.map(model => model.id)).toEqual([XCITY_DEFAULT_MODEL_ID]);
  });

  it("does not flag grantNotExpanded when a real model came back alongside a sentinel", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return jsonResponse({ data: [{ id: "all-proxy-models" }, { id: "gpt-5.5-xhigh" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      keyMint: { attempted: true, status: 200 },
      catalog: { status: 200, modelCount: 1 },
    });
    expect(info?.modelIds).toEqual(["gpt-5.5-xhigh"]);
  });

  it("revalidates a cached wildcard-only catalog instead of honouring its TTL", async () => {
    // The wallet repairs the key's grant in place — the key token never changes — so a cached
    // sentinel-only catalog must not be served for the rest of its TTL after the fix landed.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return jsonResponse({ data: [{ id: "deepseek-v3.2" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const storage = makeStorage({
      key: {
        userId: IDENTITY.userId,
        walletUrl: "https://wallet.xcity.ai",
        key: "sk-cached",
        mintedAt: 111,
      },
      catalog: {
        tokenhubUrl: "https://tokenhub.xcity.ai",
        keyMintedAt: 111,
        fetchedAt: Date.now(),
        models: [],
        grantNotExpanded: true,
      },
    });
    const info = await getXcityProviderInfoForUser(ENV, storage, IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      catalog: { status: 200, modelCount: 1 },
    });
    expect(info?.modelIds).toEqual(["deepseek-v3.2"]);
  });

  it("keeps reporting grantNotExpanded when revalidating the cached empty catalog fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return new Response("nope", { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const storage = makeStorage({
      key: {
        userId: IDENTITY.userId,
        walletUrl: "https://wallet.xcity.ai",
        key: "sk-cached",
        mintedAt: 111,
      },
      catalog: {
        tokenhubUrl: "https://tokenhub.xcity.ai",
        keyMintedAt: 111,
        fetchedAt: Date.now(),
        models: [],
        grantNotExpanded: true,
      },
    });
    const info = await getXcityProviderInfoForUser(ENV, storage, IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      catalog: { status: 503, modelCount: 0, grantNotExpanded: true },
    });
    expect(info?.modelIds).toEqual([XCITY_DEFAULT_MODEL_ID]);
  });

  it("flags a malformed catalog body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      return jsonResponse({ nope: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      keyMint: { attempted: true, status: 200 },
      catalog: { status: 200, error: "malformed-response" },
    });
  });

  it("says a cached key needed no mint on the all-good path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return jsonResponse({ data: [{ id: "gpt-5.5-xhigh" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const storage = makeStorage({
      key: {
        userId: IDENTITY.userId,
        walletUrl: "https://wallet.xcity.ai",
        key: "sk-cached",
        mintedAt: 111,
      },
    });
    const info = await getXcityProviderInfoForUser(ENV, storage, IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      catalog: { status: 200, modelCount: 1 },
    });
    expect(info?.modelIds).toEqual(["gpt-5.5-xhigh"]);
  });

  it("marks a served-stale catalog and keeps the inline refresh failure", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokenhub.xcity.ai/v1/models") {
        return new Response("down", { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // A catalog older than the 24h stale ceiling: the refresh runs inline, fails, and the
    // cached models are served anyway.
    const storage = makeStorage({
      key: {
        userId: IDENTITY.userId,
        walletUrl: "https://wallet.xcity.ai",
        key: "sk-cached",
        mintedAt: 111,
      },
      catalog: {
        tokenhubUrl: "https://tokenhub.xcity.ai",
        keyMintedAt: 111,
        fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
        models: [{
          profile: { type: "agent", id: "stale-model", name: "stale-model" },
          config: { provider: "ollama", model: "stale-model" },
        }],
      },
    });
    const info = await getXcityProviderInfoForUser(ENV, storage, IDENTITY);
    expect(info?.diagnostics).toEqual({
      identity: true,
      keyPresent: true,
      catalog: { status: 503, modelCount: 1, servedStale: true },
    });
    expect(info?.modelIds).toEqual(["stale-model"]);
  });
});
