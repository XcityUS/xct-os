import { describe, expect, it } from "vitest";
import {
  getXcityModelMetadata,
  isLiteLlmGrantSentinelModelId,
  LITELLM_GRANT_SENTINEL_MODEL_IDS,
  parseTokenhubModelCatalog,
  parseTokenhubModelCatalogEntries,
  pickQuickXcityModelConfig,
  synthesizeXcityDefaultModelRecord,
  XCITY_DEFAULT_MODEL_ID,
} from "../src/xcity/model-plane.js";

const CONTEXT = {
  tokenhubUrl: "https://tokenhub.xcity.ai",
  apiKey: "sk-tokenhub-user",
  xcityUserId: "01823f64-8ac8-715e-bf17-0f92801f2af3",
};

describe("parseTokenhubModelCatalog", () => {
  it("maps tokenhub model metadata into direct OpenAI-compatible configs", () => {
    const records = parseTokenhubModelCatalog({
      data: [{
        id: "gpt-5.5-xhigh",
        object: "model",
        provider: "openai",
        context_window: 1_000_000,
        max_output_tokens: 128_000,
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000004,
        capabilities: {
          vision: true,
          pdf_input: true,
          function_calling: true,
          structured_output: true,
          prompt_caching: true,
          web_search: false,
          audio_input: false,
          audio_output: false,
        },
      }],
    }, CONTEXT);

    expect(records).toHaveLength(1);
    const record = records![0];
    expect(record.profile).toEqual({
      type: "agent",
      id: "gpt-5.5-xhigh",
      name: "gpt-5.5-xhigh",
    });
    expect(record.config).toMatchObject({
      provider: "ollama",
      model: "gpt-5.5-xhigh",
      apiUrl: "https://tokenhub.xcity.ai/v1",
      apiToken: "sk-tokenhub-user",
    });

    const metadata = getXcityModelMetadata(record.config);
    expect(metadata).toMatchObject({
      tokenhubUrl: "https://tokenhub.xcity.ai",
      xcityUserId: "01823f64-8ac8-715e-bf17-0f92801f2af3",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000004,
      capabilities: {
        vision: true,
        pdfInput: true,
        functionCalling: true,
        structuredOutput: true,
        promptCaching: true,
        webSearch: false,
        audioInput: false,
        audioOutput: false,
      },
    });
    expect(metadata?.raw).toMatchObject({
      id: "gpt-5.5-xhigh",
      object: "model",
      provider: "openai",
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      capabilities: {
        vision: true,
        pdf_input: true,
        function_calling: true,
        structured_output: true,
        prompt_caching: true,
        web_search: false,
        audio_input: false,
        audio_output: false,
      },
    });
  });

  it("rejects malformed catalogs and skips entries without model ids", () => {
    expect(parseTokenhubModelCatalog({}, CONTEXT)).toBeUndefined();

    const records = parseTokenhubModelCatalog({
      data: [
        { object: "model" },
        { id: "" },
        { id: "usable-model" },
      ],
    }, CONTEXT);

    expect(records?.map(record => record.profile.id)).toEqual(["usable-model"]);
  });

  // LiteLLM answers /v1/models with the key's grant markers verbatim — notably it does NOT
  // expand a literal "*" — so a key minted with models:["*"] yields a catalog of one fake model
  // that is always "already added" and fails with 400 Invalid model name when chatted with.
  it("drops litellm grant sentinels, keeping only callable models", () => {
    const records = parseTokenhubModelCatalog({
      data: [
        { id: "*" },
        { id: "all-proxy-models" },
        { id: "all-team-models" },
        { id: "no-default-models" },
        { id: "gpt-5.5-xhigh" },
      ],
    }, CONTEXT);

    expect(records?.map(record => record.profile.id)).toEqual(["gpt-5.5-xhigh"]);
  });

  it("reports how many sentinels were dropped, and yields no models for a wildcard-only grant",
      () => {
    const wildcardOnly = parseTokenhubModelCatalogEntries({ data: [{ id: "*" }] }, CONTEXT);
    expect(wildcardOnly).toEqual({ models: [], sentinelCount: 1 });

    const mixed = parseTokenhubModelCatalogEntries({
      data: [{ id: "*" }, { id: "gpt-5.5-xhigh" }],
    }, CONTEXT);
    expect(mixed?.sentinelCount).toBe(1);
    expect(mixed?.models.map(record => record.profile.id)).toEqual(["gpt-5.5-xhigh"]);

    // A malformed body is still distinguishable from an all-sentinel one.
    expect(parseTokenhubModelCatalogEntries({}, CONTEXT)).toBeUndefined();
  });

  it("treats every documented litellm grant marker as a sentinel", () => {
    expect(LITELLM_GRANT_SENTINEL_MODEL_IDS).toEqual([
      "*", "all-proxy-models", "all-team-models", "no-default-models",
    ]);
    for (const id of LITELLM_GRANT_SENTINEL_MODEL_IDS) {
      expect(isLiteLlmGrantSentinelModelId(id)).toBe(true);
    }
    expect(isLiteLlmGrantSentinelModelId("gpt-5.5-xhigh")).toBe(false);
    expect(isLiteLlmGrantSentinelModelId("all-proxy-models-2")).toBe(false);
  });
});

describe("pickQuickXcityModelConfig", () => {
  const records = parseTokenhubModelCatalog({
    data: [
      {
        id: "expensive",
        input_cost_per_token: 0.02,
        output_cost_per_token: 0.03,
      },
      {
        id: "cheap",
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.002,
      },
    ],
  }, CONTEXT)!;

  it("uses XCITY_QUICK_MODEL when present in the catalog", () => {
    expect(pickQuickXcityModelConfig(records, "expensive")?.model).toBe("expensive");
  });

  it("otherwise picks the lowest-cost model", () => {
    expect(pickQuickXcityModelConfig(records)?.model).toBe("cheap");
  });

  it("does not synthesize a configured quick model outside the user's catalog", () => {
    expect(pickQuickXcityModelConfig(records, "missing")).toBeUndefined();
  });

  // The default is deliberately hard-coded, so its exact TokenHub spelling is part of the
  // contract: the gateway matches model names verbatim.
  const withDefault = parseTokenhubModelCatalog({
    data: [
      { id: "expensive", input_cost_per_token: 0.02, output_cost_per_token: 0.03 },
      { id: "cheap", input_cost_per_token: 0.001, output_cost_per_token: 0.002 },
      {
        id: XCITY_DEFAULT_MODEL_ID,
        input_cost_per_token: 0.01,
        output_cost_per_token: 0.01,
      },
    ],
  }, CONTEXT)!;

  it("spells the hard-coded default model id exactly as tokenhub does", () => {
    expect(XCITY_DEFAULT_MODEL_ID).toBe("Deepseek-V4-Pro-GA");
  });

  it("prefers the hard-coded default over the cheapest model", () => {
    expect(pickQuickXcityModelConfig(withDefault)?.model).toBe(XCITY_DEFAULT_MODEL_ID);
  });

  it("lets XCITY_QUICK_MODEL win over the hard-coded default", () => {
    expect(pickQuickXcityModelConfig(withDefault, "cheap")?.model).toBe("cheap");
  });

  it("falls back to the cost heuristic when the catalog lacks the hard-coded default", () => {
    expect(records.some(record => record.profile.id === XCITY_DEFAULT_MODEL_ID)).toBe(false);
    expect(pickQuickXcityModelConfig(records)?.model).toBe("cheap");
  });
});

describe("synthesizeXcityDefaultModelRecord", () => {
  it("shapes the fallback exactly like a catalog-derived record, but marked as synthesized",
      () => {
    const real = parseTokenhubModelCatalog(
        { data: [{ id: XCITY_DEFAULT_MODEL_ID }] }, CONTEXT)![0];
    const synthesized = synthesizeXcityDefaultModelRecord(CONTEXT);

    expect(synthesized.profile).toEqual(real.profile);
    expect(synthesized.config).toMatchObject({
      provider: real.config.provider,
      model: XCITY_DEFAULT_MODEL_ID,
      apiUrl: real.config.apiUrl,
      apiToken: "sk-tokenhub-user",
    });
    expect(getXcityModelMetadata(synthesized.config)).toMatchObject({
      tokenhubUrl: CONTEXT.tokenhubUrl,
      xcityUserId: CONTEXT.xcityUserId,
      synthesizedFallback: true,
    });
    // A real catalog entry is never mistaken for the fallback.
    expect(getXcityModelMetadata(real.config)?.synthesizedFallback).toBeUndefined();
  });

  it("is picked as the quick model once it is in the list", () => {
    expect(pickQuickXcityModelConfig([synthesizeXcityDefaultModelRecord(CONTEXT)])?.model)
        .toBe(XCITY_DEFAULT_MODEL_ID);
  });
});
