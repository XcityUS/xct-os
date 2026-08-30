import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearXcityAgentPersonaCacheForTests,
  getXcityAgentPersona,
  getXcityAgentPersonaDetails,
} from "../src/xcity/agent-persona.js";
import {
  debitXcitySkillUse,
  debitXcitySkillUseForTurn,
} from "../src/xcity/skill-billing.js";
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
  userId: "3f7f2f9e-2c8a-4f37-9d9f-000000000001",
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

// Serves key mint + skill index + one persona document; collects wallet debit calls.
function stubTokenhubAndWallet(personaBody: unknown, options: {
  debitStatus?: number;
  debitError?: Error;
} = {}) {
  const debits: Array<{ init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = String(input);
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
      return jsonResponse(personaBody);
    }
    if (url === "https://wallet.xcity.ai/v1/wallet/debit") {
      debits.push({ init: init!, body: JSON.parse(String(init!.body)) });
      if (options.debitError) throw options.debitError;
      let status = options.debitStatus ?? 200;
      return jsonResponse({ ok: status === 200 }, status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, debits };
}

afterEach(() => {
  clearXcityAgentPersonaCacheForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("persona pricing parse", () => {
  it("captures pricing.kwh_per_use alongside the persona", async () => {
    const storage = makeStorage();
    stubTokenhubAndWallet({
      data: {
        system_prompt_template: "Build with care.",
        pricing: { kwh_per_use: 0.25 },
      },
    });

    await expect(getXcityAgentPersonaDetails(
        ENV, CONFIG, storage, IDENTITY, "builder")).resolves.toEqual({
      persona: "Build with care.",
      kwhPerUse: 0.25,
    });
    // The plain persona accessor keeps working through the same cache.
    await expect(getXcityAgentPersona(
        ENV, CONFIG, storage, IDENTITY, "builder")).resolves.toBe("Build with care.");
  });

  it.each([
    ["missing", { system_prompt_template: "P" }],
    ["zero", { system_prompt_template: "P", pricing: { kwh_per_use: 0 } }],
    ["negative", { system_prompt_template: "P", pricing: { kwh_per_use: -1 } }],
    ["non-numeric", { system_prompt_template: "P", pricing: { kwh_per_use: "0.5" } }],
    ["non-finite", { system_prompt_template: "P", pricing: { kwh_per_use: Infinity } }],
  ])("leaves kwhPerUse undefined when pricing is %s", async (_label, body) => {
    const storage = makeStorage();
    stubTokenhubAndWallet({ data: body });

    await expect(getXcityAgentPersonaDetails(
        ENV, CONFIG, storage, IDENTITY, "builder")).resolves.toEqual({ persona: "P" });
  });
});

describe("debitXcitySkillUse", () => {
  it("posts a well-formed debit with integer credits", async () => {
    const { fetchMock, debits } = stubTokenhubAndWallet(null);

    await debitXcitySkillUse(CONFIG, IDENTITY, {
      agentSlug: "builder",
      kwhPerUse: 0.25,
      requestId: "xct-skill:do-1:7:42",
      chatId: "do-1:7",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
        "https://wallet.xcity.ai/v1/wallet/debit",
        expect.objectContaining({ method: "POST" }));
    expect(debits[0].init.headers).toMatchObject({
      Authorization: "Bearer wallet-service-token",
      "Content-Type": "application/json",
    });
    expect(debits[0].body).toEqual({
      user_id: IDENTITY.userId,
      request_id: "xct-skill:do-1:7:42",
      amount_credits: 25,
      product: "workshop",
      meter: "skill_use",
      agent_id: "builder",
      metadata: { chat_id: "do-1:7" },
    });
  });

  it.each([0, -0.5, NaN])("does not call the wallet for kwh_per_use = %s", async kwhPerUse => {
    const { fetchMock } = stubTokenhubAndWallet(null);

    await debitXcitySkillUse(CONFIG, IDENTITY, {
      agentSlug: "builder", kwhPerUse, requestId: "r-1",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails open on network errors", async () => {
    stubTokenhubAndWallet(null, { debitError: new Error("connection reset") });

    await expect(debitXcitySkillUse(CONFIG, IDENTITY, {
      agentSlug: "builder", kwhPerUse: 0.25, requestId: "r-1",
    })).resolves.toBeUndefined();
  });

  it.each([402, 500])("never throws on a %s response", async status => {
    stubTokenhubAndWallet(null, { debitStatus: status });

    await expect(debitXcitySkillUse(CONFIG, IDENTITY, {
      agentSlug: "builder", kwhPerUse: 0.25, requestId: "r-1",
    })).resolves.toBeUndefined();
  });
});

describe("debitXcitySkillUseForTurn", () => {
  const PRICED_PERSONA = {
    data: {
      system_prompt_template: "Build with care.",
      pricing: { kwh_per_use: 0.5 },
    },
  };

  it("debits a priced skill with the caller's idempotency key", async () => {
    const storage = makeStorage();
    const { debits } = stubTokenhubAndWallet(PRICED_PERSONA);

    await debitXcitySkillUseForTurn(
        ENV, storage, IDENTITY, "builder", "xct-skill:do-1:3:0", "do-1:3");

    expect(debits).toHaveLength(1);
    expect(debits[0].body).toMatchObject({
      request_id: "xct-skill:do-1:3:0",
      amount_credits: 50,
      agent_id: "builder",
      metadata: { chat_id: "do-1:3" },
    });
  });

  it("reuses the same request_id for a retried delivery of the same turn", async () => {
    const storage = makeStorage();
    const { debits } = stubTokenhubAndWallet(PRICED_PERSONA);

    await debitXcitySkillUseForTurn(ENV, storage, IDENTITY, "builder", "xct-skill:do-1:3:0");
    await debitXcitySkillUseForTurn(ENV, storage, IDENTITY, "builder", "xct-skill:do-1:3:0");

    expect(debits).toHaveLength(2);
    expect(debits[0].body.request_id).toBe("xct-skill:do-1:3:0");
    expect(debits[1].body.request_id).toBe("xct-skill:do-1:3:0");
  });

  it("does not debit an unpriced skill", async () => {
    const storage = makeStorage();
    const { debits } = stubTokenhubAndWallet({
      data: { system_prompt_template: "Build with care." },
    });

    await debitXcitySkillUseForTurn(ENV, storage, IDENTITY, "builder", "r-1");

    expect(debits).toHaveLength(0);
  });

  it("does nothing when the Xcity marketplace is unconfigured", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await debitXcitySkillUseForTurn(
        {} as unknown as Cloudflare.Env, storage, IDENTITY, "builder", "r-1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing without an Xcity identity", async () => {
    const storage = makeStorage();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await debitXcitySkillUseForTurn(ENV, storage, null, "builder", "r-1");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
