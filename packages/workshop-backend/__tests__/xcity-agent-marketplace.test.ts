import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAgentPersona } from "../src/agent.js";
import {
  clearXcityAgentCatalogCacheForTests,
  getXcityAgent,
  listXcityAgents,
} from "../src/xcity/agent-catalog.js";
import {
  clearXcityAgentPersonaCacheForTests,
  getXcityAgentPersona,
} from "../src/xcity/agent-persona.js";
import type { XcityModelPlaneCache, XcityModelPlaneStorage } from "../src/xcity/model-plane.js";

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

const IDENTITY = {
  userId: "user-123",
  email: "user@example.com",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeStorage(): XcityModelPlaneStorage {
  let value: XcityModelPlaneCache = {};
  return {
    get: () => value,
    put: next => { value = next; },
    subscribe: () => {},
    unsubscribe: () => {},
  };
}

afterEach(() => {
  clearXcityAgentCatalogCacheForTests();
  clearXcityAgentPersonaCacheForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Xcity agent catalog", () => {
  it("parses and caches the xct-home catalog", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = vi.fn(async () => jsonResponse({
      degraded: false,
      data: [{
        id: "agent-1",
        slug: "builder",
        displayName: "Builder",
        emoji: "B",
        description: "Builds apps",
        category: "Product",
        tags: ["apps"],
        skills: [{ id: "skill-1", name: "Scaffold", description: "Creates starts" }],
        available_plans: ["free"],
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{
      id: "agent-1",
      slug: "builder",
      displayName: "Builder",
      category: "Product",
      skills: [{ id: "skill-1", name: "Scaffold" }],
      availablePlans: ["free"],
    }]);
    await expect(listXcityAgents(ENV)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list for degraded catalogs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      degraded: true,
      data: [{ id: "agent-1", slug: "builder", displayName: "Builder" }],
    })));

    await expect(listXcityAgents(ENV)).resolves.toEqual([]);
  });

  it("rejects unsafe slugs without fetching the catalog", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getXcityAgent(ENV, "../builder")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Xcity agent persona", () => {
  it("resolves the slug through the skill index and caches the persona", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      let url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-user" });
      }
      // The gateway assigns skill ids, so the slug only exists in the row's metadata.
      if (url.startsWith("https://tokenhub.xcity.ai/v1/xct-skills?")) {
        return jsonResponse({
          data: [{ skill_id: "uuid-builder", xct_metadata: { xct_agent_slug: "builder" } }],
          has_more: false,
        });
      }
      if (url === "https://tokenhub.xcity.ai/v1/xct-skills/uuid-builder") {
        return jsonResponse({ system_prompt_template: "Build with care." });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getXcityAgentPersona(
        ENV, CONFIG, storage, IDENTITY, "builder")).resolves.toBe("Build with care.");
    await expect(getXcityAgentPersona(
        ENV, CONFIG, storage, IDENTITY, "builder")).resolves.toBe("Build with care.");
    // Key mint + index + persona, then everything served from cache.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("walks every index page before giving up on a slug", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      let url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-user" });
      }
      if (url.startsWith("https://tokenhub.xcity.ai/v1/xct-skills?")) {
        if (!url.includes("cursor=")) {
          return jsonResponse({
            data: [{ skill_id: "uuid-other", xct_metadata: { xct_agent_slug: "other" } }],
            has_more: true,
            next_cursor: "page-2",
          });
        }
        return jsonResponse({
          data: [{ skill_id: "uuid-builder", xct_metadata: { xct_agent_slug: "builder" } }],
          has_more: false,
        });
      }
      if (url === "https://tokenhub.xcity.ai/v1/xct-skills/uuid-builder") {
        return jsonResponse({ system_prompt_template: "Build with care." });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getXcityAgentPersona(
        ENV, CONFIG, storage, IDENTITY, "builder")).resolves.toBe("Build with care.");
  });

  it("falls back to the slug as the id when the index does not know it", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      let url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-user" });
      }
      if (url.startsWith("https://tokenhub.xcity.ai/v1/xct-skills?")) {
        return jsonResponse({ data: [], has_more: false });
      }
      // Keeps working unchanged if the gateway ever lets the importer choose the id.
      if (url === "https://tokenhub.xcity.ai/v1/xct-skills/builder") {
        return jsonResponse({ system_prompt_template: "Build with care." });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getXcityAgentPersona(
        ENV, CONFIG, storage, IDENTITY, "builder")).resolves.toBe("Build with care.");
  });

  it("returns null when tokenhub has no imported persona", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      let url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        return jsonResponse({ key: "sk-user" });
      }
      if (url.startsWith("https://tokenhub.xcity.ai/v1/xct-skills?")) {
        return jsonResponse({ data: [], has_more: false });
      }
      if (url === "https://tokenhub.xcity.ai/v1/xct-skills/missing") {
        return jsonResponse({ error: "not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getXcityAgentPersona(
        ENV, CONFIG, storage, IDENTITY, "missing")).resolves.toBeNull();
  });
});

describe("formatAgentPersona", () => {
  it("builds a clear XML-style system prompt block", () => {
    let persona = formatAgentPersona("Planner & Builder", "  Stay focused on the user's app.  ");

    expect(persona).toContain("<xcity-agent-persona>");
    expect(persona).toContain("<name>Planner &amp; Builder</name>");
    expect(persona).toContain("<instructions>\nStay focused on the user's app.\n</instructions>");

    let slot0 = ["BASE", persona].filter(Boolean).join("\n\n");
    expect(slot0).toBe(`BASE\n\n${persona}`);
  });
});
