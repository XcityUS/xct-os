// The /providers-page description of the user's default Xcity TokenHub provider: gated on
// configuration + identity, and never throwing — partial info beats an error page.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getXcityProviderInfoForUser } from "../src/xcity/provider-info.js";
import {
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

  it("returns null when the user has no Xcity identity", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), null);
    expect(info).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still returns the minted key with an empty model list when the catalog fails", async () => {
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
      modelIds: [],
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
    });
  });
});
