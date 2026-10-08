// Xcity: runAgent's transient-failure retry (see agent-retry.test.ts) must not re-send a request
// that TokenHub throttled -- the plan's per-minute limit doesn't lift within the retry backoff,
// and each retry spends another request of it. Same harness as agent-retry.test.ts.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiModelConfig,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GadgetRecord } from "../src/storage-schema/overseer-storage.js";
import { runAgent, type AgentHooks } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

interface OverseerInternals extends AgentHooks {
  storage: {
    gadgets: { put(record: GadgetRecord): void };
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void };
  };
  nextChatSequence(chatId: number): number;
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;

// The shape pi produces for a LiteLLM per-key rate limit ("<status>: <json body>").
const THROTTLE =
    `429: {"message":"Rate limit exceeded for api_key: abc. Limit type: requests. ` +
    `Current limit: 5, Remaining: 0","type":"throttling_error","code":"429"}`;

const XCITY_MODEL = {
  provider: "openai",
  model: "faux-model",
  apiToken: "sk-user-virtual-key",
  xcity: { tokenhubUrl: "https://tokenhub.xcity.ai", xcityUserId: "user-1", raw: {} },
} as AiModelConfig;

const PLAIN_MODEL: AiModelConfig = { provider: "openai", model: "faux-model", apiToken: "" };

let doCounter = 0;

// Runs one turn whose first model request is throttled and whose second would answer; returns how
// many requests the model saw and what the turn threw.
async function throttledTurn(modelConfig: AiModelConfig): Promise<{
  requests: number; error: unknown;
}> {
  let result!: { requests: number; error: unknown };
  let stub = env.TEST_OVERSEER.getByName(`xcity-agent-retry-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: OverseerInternals }).impl;
    impl.storage.gadgets.put({
      type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
      bindings: {},
    });
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
      author: OWNER, type: "message", message: "Hi",
    });
    impl.emitChatStreamEvent = () => {};
    let faux = createFauxCore({ models: [{ id: "faux-model" }] });
    let requests = 0;
    faux.setResponses([
      () => { ++requests; return fauxAssistantMessage(fauxText(""),
          { stopReason: "error", errorMessage: THROTTLE }); },
      () => { ++requests; return fauxAssistantMessage(fauxText("Answered.")); },
    ]);
    try {
      await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
          { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
          modelConfig);
      result = { requests, error: undefined };
    } catch (error) {
      result = { requests, error };
    }
  });
  return result;
}

describe("Xcity TokenHub throttles", () => {
  it("are not retried for an Xcity model: the turn fails after one request", async () => {
    let { requests, error } = await throttledTurn(XCITY_MODEL);
    expect(String(error)).toContain("throttling_error");
    expect(requests).toBe(1);
  });

  it("are still retried as transient for any other model (upstream behaviour)", async () => {
    let { requests, error } = await throttledTurn(PLAIN_MODEL);
    expect(error).toBeUndefined();
    expect(requests).toBe(2);
  });
});
