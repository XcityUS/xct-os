import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAgentPersona } from "../src/xcity/agent-persona.js";
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

afterEach(async () => {
  await clearXcityAgentCatalogCacheForTests();
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

  it("serves a degraded catalog when nothing is cached, without caching it", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      degraded: true,
      data: [{ id: "agent-1", slug: "builder", displayName: "Builder" }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
    // The degraded snapshot is not cached: the next call goes back upstream for a full catalog.
    await expect(listXcityAgents(ENV)).resolves.toMatchObject([{ slug: "builder" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("Xcity skill index failures", () => {
  const INDEX_PREFIX = "https://tokenhub.xcity.ai/v1/xct-skills?";
  const PERSONA_PREFIX = "https://tokenhub.xcity.ai/v1/xct-skills/";

  // Wallet mints `sk-<user_id>`, so each identity gets its own tokenhub key. `index` decides the
  // listing's answer per bearer; persona reads always succeed.
  function skillGateway(index: (bearer: string) => Response | Promise<Response>) {
    const indexBearers: string[] = [];
    const personaUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = String(input);
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") {
        let body = JSON.parse(String(init?.body)) as { user_id: string };
        return jsonResponse({ key: `sk-${body.user_id}` });
      }
      let bearer = new Headers(init?.headers).get("Authorization") ?? "";
      if (url.startsWith(INDEX_PREFIX)) {
        indexBearers.push(bearer);
        return index(bearer);
      }
      if (url.startsWith(PERSONA_PREFIX)) {
        personaUrls.push(url);
        let id = decodeURIComponent(url.slice(PERSONA_PREFIX.length));
        return jsonResponse({ system_prompt_template: `Persona ${id}` });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, indexBearers, personaUrls };
  }

  function lookup(storage: XcityModelPlaneStorage, slug: string, userId = IDENTITY.userId) {
    return getXcityAgentPersona(ENV, CONFIG, storage, { userId, email: IDENTITY.email }, slug);
  }

  function indexOf(...slugs: string[]): Response {
    return jsonResponse({
      data: slugs.map(slug => ({ skill_id: `uuid-${slug}`, xct_metadata: { xct_agent_slug: slug } })),
      has_more: false,
    });
  }

  it("remembers a 401 index and serves later lookups without a fetch", async () => {
    const storage = makeStorage();
    const gateway = skillGateway(() => jsonResponse({ error: "unauthorized" }, 401));

    await expect(lookup(storage, "builder")).resolves.toBeNull();
    let callsAfterFirst = gateway.fetchMock.mock.calls.length;
    await expect(lookup(storage, "builder")).resolves.toBeNull();
    await expect(lookup(storage, "planner")).resolves.toBeNull();

    expect(gateway.indexBearers).toHaveLength(1);
    expect(gateway.personaUrls).toHaveLength(0);
    expect(gateway.fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("shares one index fetch across concurrent lookups for different slugs", async () => {
    const storage = makeStorage();
    let release!: () => void;
    let held = new Promise<void>(resolve => { release = resolve; });
    const gateway = skillGateway(async () => {
      await held;
      return jsonResponse({ error: "unauthorized" }, 401);
    });

    let lookups = Array.from({ length: 20 }, (_, i) => lookup(storage, `agent-${i}`));
    // Let every lookup get past key minting and queue on the index before it answers.
    await vi.waitFor(() => expect(gateway.indexBearers.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 10));
    release();

    expect(await Promise.all(lookups)).toEqual(Array(20).fill(null));
    // A 4xx is never retried by fetchWithOneRetry, so the whole sweep costs one request.
    expect(gateway.indexBearers).toEqual(["Bearer sk-user-123"]);
    expect(gateway.personaUrls).toHaveLength(0);
  });

  it("counts the transient retry once and then remembers a 5xx index for a minute", async () => {
    const storage = makeStorage();
    const gateway = skillGateway(() => new Response("bad gateway", { status: 502 }));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    let lookups = Array.from({ length: 20 }, (_, i) => lookup(storage, `agent-${i}`));
    expect(await Promise.all(lookups)).toEqual(Array(20).fill(null));
    // First attempt + the single fetchWithOneRetry retry.
    expect(gateway.indexBearers).toHaveLength(2);

    now += 59_000;
    await expect(lookup(storage, "agent-0")).resolves.toBeNull();
    expect(gateway.indexBearers).toHaveLength(2);

    now += 2_000;
    await expect(lookup(storage, "agent-0")).resolves.toBeNull();
    expect(gateway.indexBearers).toHaveLength(4);
  });

  it("retries a 401 index once its longer window has passed", async () => {
    const storage = makeStorage();
    let rejected = true;
    const gateway = skillGateway(() => rejected
      ? jsonResponse({ error: "unauthorized" }, 401)
      : indexOf("builder"));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await expect(lookup(storage, "builder")).resolves.toBeNull();
    rejected = false;

    now += 4 * 60_000;
    await expect(lookup(storage, "builder")).resolves.toBeNull();
    expect(gateway.indexBearers).toHaveLength(1);

    now += 60_000 + 1;
    await expect(lookup(storage, "builder")).resolves.toBe("Persona uuid-builder");
    expect(gateway.indexBearers).toHaveLength(2);
    expect(gateway.personaUrls).toEqual([`${PERSONA_PREFIX}uuid-builder`]);
  });

  it("keeps one key's failure from affecting another key", async () => {
    const gateway = skillGateway(bearer => bearer === "Bearer sk-user-bad"
      ? jsonResponse({ error: "unauthorized" }, 401)
      : indexOf("builder"));

    await expect(lookup(makeStorage(), "builder", "user-bad")).resolves.toBeNull();
    await expect(lookup(makeStorage(), "builder", "user-good")).resolves.toBe("Persona uuid-builder");

    expect(gateway.indexBearers).toEqual(["Bearer sk-user-bad", "Bearer sk-user-good"]);
  });

  it("still fetches the index once and each persona on success", async () => {
    const storage = makeStorage();
    const gateway = skillGateway(() => indexOf("builder", "planner", "writer"));

    await expect(lookup(storage, "builder")).resolves.toBe("Persona uuid-builder");
    await expect(Promise.all([lookup(storage, "planner"), lookup(storage, "writer")]))
        .resolves.toEqual(["Persona uuid-planner", "Persona uuid-writer"]);
    await expect(lookup(storage, "builder")).resolves.toBe("Persona uuid-builder");

    expect(gateway.indexBearers).toHaveLength(1);
    expect(gateway.personaUrls).toEqual([
      `${PERSONA_PREFIX}uuid-builder`,
      `${PERSONA_PREFIX}uuid-planner`,
      `${PERSONA_PREFIX}uuid-writer`,
    ]);
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
