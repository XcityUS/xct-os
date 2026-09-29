import { describe, expect, it } from "vitest";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { AgentTurnError } from "../src/ai-invoke.js";
import {
  formatTokenHubThrottleMessage,
  parseTokenHubThrottle,
  redactTokenHubErrorText,
  translateXcityModelError,
} from "../src/xcity/tokenhub-errors.js";

const KEY = "ecb3e7d1a9f04c2b";

// The exact shape pi produces for a LiteLLM per-key rate limit ("<status>: <json body>").
const REAL_SAMPLE =
    `429: {"message":"Rate limit exceeded for api_key: ${KEY}…. Limit type: requests. ` +
    `Current limit: 5, Remaining: 0. Limit resets at: 2026-09-29 05:46:00 UTC",` +
    `"type":"throttling_error","param":null,"code":"429"}`;

const RESETS_AT = Date.UTC(2026, 8, 29, 5, 46, 0);

// Mirrors how runAgent builds it: status from the leading digits (see httpStatusFromError).
function turnError(message: string): AgentTurnError {
  let status = /^(\d{3})\b/.exec(message)?.[1];
  return new AgentTurnError(message, status ? Number(status) : undefined);
}

function xcityEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    XCITY_TOKENHUB_URL: "https://tokenhub.xcity.ai",
    XCITY_WALLET_URL: "https://wallet.xcity.ai",
    WALLET_SERVICE_TOKEN: "wallet-service-token",
    XCITY_HOME_URL: "https://xcity.ai/",
    ...overrides,
  } as Cloudflare.Env;
}

const xcityModel = {
  provider: "openai",
  model: "deepseek-v4",
  apiToken: "sk-user-virtual-key",
  apiUrl: "https://tokenhub.xcity.ai/v1",
  xcity: { tokenhubUrl: "https://tokenhub.xcity.ai", xcityUserId: "user-1", raw: {} },
} as AiModelConfig;

const plainModel: AiModelConfig = {
  provider: "openai",
  model: "gpt-5",
  apiToken: "sk-byok",
};

describe("parseTokenHubThrottle", () => {
  it("parses the real LiteLLM requests-limit sample", () => {
    let throttle = parseTokenHubThrottle(turnError(REAL_SAMPLE));
    expect(throttle).toMatchObject({ limitType: "requests", limit: 5, remaining: 0 });
    expect(throttle?.resetsAt?.getTime()).toBe(RESETS_AT);
    expect(throttle?.detail).not.toContain(KEY);
    expect(throttle?.detail).toContain("api_key: [redacted]. Limit type: requests");
  });

  it("parses a tokens-type limit with thousands separators and the error envelope", () => {
    let text = `429: {"error":{"message":"Rate limit exceeded for api_key: ${KEY}. ` +
        `Limit type: tokens. Current limit: 100,000, Remaining: 12. ` +
        `Limit resets at: 2026-09-29 05:46:30 UTC","type":"throttling_error","code":"429"}}`;
    let throttle = parseTokenHubThrottle(turnError(text));
    expect(throttle).toMatchObject({ limitType: "tokens", limit: 100000, remaining: 12 });
    expect(throttle?.resetsAt?.toISOString()).toBe("2026-09-29T05:46:30.000Z");
  });

  it("maps unknown limit types to other", () => {
    let text = `429: {"message":"Rate limit exceeded. Limit type: max_parallel_requests. ` +
        `Current limit: 2, Remaining: 0.","type":"throttling_error"}`;
    expect(parseTokenHubThrottle(turnError(text))).toMatchObject({ limitType: "other", limit: 2 });
  });

  it("still classifies a malformed 429 body as throttled, without details", () => {
    let throttle = parseTokenHubThrottle(turnError(`429: {"message": "Rate limit exc`));
    expect(throttle).not.toBeNull();
    expect(throttle?.limitType).toBeUndefined();
    expect(throttle?.limit).toBeUndefined();
    expect(throttle?.resetsAt).toBeUndefined();
  });

  it("parses details from an unparseable body via the raw text", () => {
    let text = `429 Rate limit exceeded for api_key: ${KEY}. Limit type: requests. ` +
        `Current limit: 5, Remaining: 0. Limit resets at: 2026-09-29 05:46:00 UTC`;
    let throttle = parseTokenHubThrottle(new Error(text));
    expect(throttle).toMatchObject({ limitType: "requests", limit: 5 });
    expect(throttle?.detail).not.toContain(KEY);
  });

  it("classifies by body type when the status is unknown", () => {
    let text = `Provider error: {"message":"slow down","type":"throttling_error"}`;
    expect(parseTokenHubThrottle(new AgentTurnError(text))).not.toBeNull();
  });

  it("ignores an invalid reset timestamp", () => {
    let text = `429: {"message":"Limit type: requests. Current limit: 5. ` +
        `Limit resets at: 2026-13-45 99:99:99 UTC","type":"throttling_error"}`;
    let throttle = parseTokenHubThrottle(turnError(text));
    expect(throttle).toMatchObject({ limitType: "requests", limit: 5 });
    expect(throttle?.resetsAt).toBeUndefined();
  });

  it("returns null for non-throttling errors", () => {
    expect(parseTokenHubThrottle(turnError(
        `400: {"message":"model not allowed","type":"invalid_request_error","code":"400"}`)))
        .toBeNull();
    expect(parseTokenHubThrottle(new AgentTurnError("500 Internal Server Error", 500))).toBeNull();
    expect(parseTokenHubThrottle(new Error("fetch failed"))).toBeNull();
  });

  it("never throws on odd inputs", () => {
    for (let input of [undefined, null, 42, {}, { message: 429 }, "", "{", "}{", Symbol("x")]) {
      expect(() => parseTokenHubThrottle(input)).not.toThrow();
    }
    expect(parseTokenHubThrottle("429: whatever")).not.toBeNull();
  });
});

describe("redactTokenHubErrorText", () => {
  it("redacts api keys, sk- keys and bearer tokens", () => {
    let out = redactTokenHubErrorText(
        `api_key: ${KEY}…. key=sk-abcdef123456 Authorization: Bearer abc.def-ghi`);
    expect(out).toBe(
        "api_key: [redacted]. key=sk-[redacted] Authorization: Bearer [redacted]");
  });
});

describe("formatTokenHubThrottleMessage", () => {
  let throttle = parseTokenHubThrottle(turnError(REAL_SAMPLE))!;

  it("formats the real sample with a reset countdown and upgrade pointer", () => {
    expect(formatTokenHubThrottleMessage(throttle, RESETS_AT - 42_000, "https://xcity.ai"))
        .toBe("TokenHub rate limit reached: your plan allows 5 requests per minute. " +
            "Limit resets in 42s. Upgrade your plan at https://xcity.ai");
  });

  it("omits the upgrade pointer without a home URL and formats longer waits", () => {
    expect(formatTokenHubThrottleMessage(throttle, RESETS_AT - 125_000))
        .toBe("TokenHub rate limit reached: your plan allows 5 requests per minute. " +
            "Limit resets in 2m 5s.");
    expect(formatTokenHubThrottleMessage(throttle, RESETS_AT - 3_900_000))
        .toBe("TokenHub rate limit reached: your plan allows 5 requests per minute. " +
            "Limit resets in 1h 5m.");
  });

  it("handles a reset time already passed", () => {
    expect(formatTokenHubThrottleMessage(throttle, RESETS_AT + 5_000))
        .toBe("TokenHub rate limit reached: your plan allows 5 requests per minute. " +
            "Limit resets in a moment.");
  });

  it("falls back when details are missing", () => {
    expect(formatTokenHubThrottleMessage({ detail: "" }, 0))
        .toBe("TokenHub rate limit reached. Try again in about a minute.");
    expect(formatTokenHubThrottleMessage(
        { detail: "", limitType: "tokens", limit: 1 }, 0, "https://xcity.ai"))
        .toBe("TokenHub rate limit reached: your plan allows 1 token per minute. " +
            "Try again in about a minute. Upgrade your plan at https://xcity.ai");
    expect(formatTokenHubThrottleMessage({ detail: "", limitType: "other", limit: 2 }, 0))
        .toBe("TokenHub rate limit reached. Try again in about a minute.");
  });
});

describe("translateXcityModelError", () => {
  it("rewrites a throttle for an Xcity model, keeping the status and hiding the key", () => {
    let original = turnError(REAL_SAMPLE);
    let translated = translateXcityModelError(xcityEnv(), xcityModel, original, RESETS_AT - 42_000);
    expect(translated).toBeInstanceOf(AgentTurnError);
    expect((translated as AgentTurnError).statusCode).toBe(429);
    expect((translated as AgentTurnError).message)
        .toBe("TokenHub rate limit reached: your plan allows 5 requests per minute. " +
            "Limit resets in 42s. Upgrade your plan at https://xcity.ai");
    expect((translated as AgentTurnError).message).not.toContain(KEY);
  });

  it("omits the upgrade pointer when XCITY_HOME_URL is unset", () => {
    let translated = translateXcityModelError(
        xcityEnv({ XCITY_HOME_URL: undefined }), xcityModel, turnError(REAL_SAMPLE),
        RESETS_AT - 42_000) as AgentTurnError;
    expect(translated.message).toBe(
        "TokenHub rate limit reached: your plan allows 5 requests per minute. Limit resets in 42s.");
  });

  it("returns the same error when the Xcity model plane is not configured", () => {
    let original = turnError(REAL_SAMPLE);
    expect(translateXcityModelError({} as Cloudflare.Env, xcityModel, original)).toBe(original);
  });

  it("returns the same error for a non-Xcity model", () => {
    let original = turnError(REAL_SAMPLE);
    expect(translateXcityModelError(xcityEnv(), plainModel, original)).toBe(original);
  });

  it("returns the same error for non-throttling failures", () => {
    let original = turnError(`400: {"message":"bad request","type":"invalid_request_error"}`);
    expect(translateXcityModelError(xcityEnv(), xcityModel, original)).toBe(original);
    let abort = new DOMException("aborted", "AbortError");
    expect(translateXcityModelError(xcityEnv(), xcityModel, abort)).toBe(abort);
  });
});
