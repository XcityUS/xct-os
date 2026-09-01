// Per-user visibility of tokenhub catalog models: the toggle that backs setXcityModelHidden(),
// the list filter that backs listModels() on Xcity deployments, and the catalog the /providers
// page renders. Hiding is a list-only concern — resolution never goes through these helpers.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import {
  filterVisibleXcityModels,
  toggleXcityHiddenModelId,
} from "../src/xcity/model-visibility.js";
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

const CATALOG_IDS = new Set(["gpt-5.5-xhigh", "cheap-model", "vision-model"]);

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

function profile(id: string): AiChatAuthorInfo {
  return { type: "agent", id, name: id };
}

afterEach(async () => {
  await flushXcityCatalogRefreshesForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("toggleXcityHiddenModelId", () => {
  it("hides a catalog model", () => {
    expect(toggleXcityHiddenModelId([], CATALOG_IDS, "cheap-model", true))
        .toEqual(["cheap-model"]);
  });

  it("is idempotent when hiding an already-hidden model", () => {
    expect(toggleXcityHiddenModelId(["cheap-model"], CATALOG_IDS, "cheap-model", true))
        .toEqual(["cheap-model"]);
  });

  it("shows a hidden model again, preserving other hidden entries", () => {
    expect(toggleXcityHiddenModelId(
        ["cheap-model", "vision-model"], CATALOG_IDS, "cheap-model", false))
        .toEqual(["vision-model"]);
  });

  it("is idempotent when showing an already-visible model", () => {
    expect(toggleXcityHiddenModelId(["vision-model"], CATALOG_IDS, "cheap-model", false))
        .toEqual(["vision-model"]);
  });

  it("ignores ids not in the tokenhub catalog", () => {
    expect(toggleXcityHiddenModelId(["cheap-model"], CATALOG_IDS, "no-such-model", true))
        .toEqual(["cheap-model"]);
    expect(toggleXcityHiddenModelId(["cheap-model"], CATALOG_IDS, "no-such-model", false))
        .toEqual(["cheap-model"]);
  });

  it("does not mutate the input list", () => {
    const input = ["cheap-model"];
    toggleXcityHiddenModelId(input, CATALOG_IDS, "vision-model", true);
    toggleXcityHiddenModelId(input, CATALOG_IDS, "cheap-model", false);
    expect(input).toEqual(["cheap-model"]);
  });
});

describe("filterVisibleXcityModels", () => {
  it("drops hidden models and keeps the rest in order", () => {
    const models = [profile("gpt-5.5-xhigh"), profile("cheap-model"), profile("vision-model")];
    expect(filterVisibleXcityModels(models, ["cheap-model"]))
        .toEqual([profile("gpt-5.5-xhigh"), profile("vision-model")]);
  });

  it("passes everything through when nothing is hidden", () => {
    const models = [profile("gpt-5.5-xhigh"), profile("cheap-model")];
    expect(filterVisibleXcityModels(models, [])).toEqual(models);
  });

  it("tolerates hidden ids that are no longer in the catalog", () => {
    const models = [profile("gpt-5.5-xhigh")];
    expect(filterVisibleXcityModels(models, ["retired-model"])).toEqual(models);
  });
});

describe("getXcityProviderInfoForUser catalog", () => {
  function stubTokenhub(): void {
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
  }

  it("returns the full catalog with per-model visibility and visible-only modelIds", async () => {
    stubTokenhub();

    const info = await getXcityProviderInfoForUser(
        ENV, makeStorage(), IDENTITY, undefined, ["cheap-model"]);
    expect(info).toEqual({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      email: "user@example.com",
      apiKey: "sk-tokenhub-user",
      modelIds: ["gpt-5.5-xhigh"],
      catalog: [
        { id: "gpt-5.5-xhigh", name: "gpt-5.5-xhigh", hidden: false },
        { id: "cheap-model", name: "cheap-model", hidden: true },
      ],
      diagnostics: {
        identity: true,
        keyPresent: true,
        keyMint: { attempted: true, status: 200 },
        catalog: { status: 200, modelCount: 2 },
      },
    });
  });

  it("marks nothing hidden by default", async () => {
    stubTokenhub();

    const info = await getXcityProviderInfoForUser(ENV, makeStorage(), IDENTITY);
    expect(info?.modelIds).toEqual(["gpt-5.5-xhigh", "cheap-model"]);
    expect(info?.catalog.every(model => !model.hidden)).toBe(true);
  });

  it("returns an empty catalog (not a throw) when the catalog fetch fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-tokenhub-user" });
      }
      return new Response("down", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await getXcityProviderInfoForUser(
        ENV, makeStorage(), IDENTITY, undefined, ["cheap-model"]);
    expect(info).toEqual({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      email: "user@example.com",
      apiKey: "sk-tokenhub-user",
      modelIds: [],
      catalog: [],
      diagnostics: {
        identity: true,
        keyPresent: true,
        keyMint: { attempted: true, status: 200 },
        catalog: { status: 500 },
      },
    });
  });
});
