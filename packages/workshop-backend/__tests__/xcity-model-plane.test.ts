import { describe, expect, it } from "vitest";
import {
  getXcityModelMetadata,
  parseTokenhubModelCatalog,
  pickQuickXcityModelConfig,
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
});
