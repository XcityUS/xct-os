// Turns an Xcity TokenHub (LiteLLM proxy) rate-limit failure into an actionable chat message.
//
// LiteLLM enforces per-key request/token limits set by the user's Xcity plan and answers with a
// 429 whose body names the (hashed) key, e.g.
//   429: {"message":"Rate limit exceeded for api_key: ecb3…. Limit type: requests. Current limit: 5,
//         Remaining: 0. Limit resets at: 2026-09-29 05:46:00 UTC","type":"throttling_error",...}
// (pi formats provider failures as "<status>: <json body>"; see ai-invoke.ts). Shown raw, users
// read it as "the model is broken" and switch models, which changes nothing. This module parses
// it, logs the structured detail (never the key), and hands the overseer a plain-text message.

import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { createLogger } from "@gadgets/observability/logger";
import { AgentTurnError } from "../ai-invoke.js";
import { getXcityConfig, getXcityHomeUrl } from "./config.js";
import { getXcityModelMetadata } from "./model-plane.js";

type TokenHubLogFields = {
  limitType: string;
  limit: number;
  remaining: number;
  resetsAt: string;
  modelId: string;
  detail: string;
};

const logger = createLogger<TokenHubLogFields>({ component: "workshop.xcity.tokenhub" });

// Bound on the redacted gateway text kept for logs.
const MAX_DETAIL_CHARS = 500;

/** Which LiteLLM limit tripped: requests per minute, tokens per minute, or anything else. */
export type TokenHubLimitType = "requests" | "tokens" | "other";

/** A parsed TokenHub throttling error. Every field but `detail` is optional: parsing is lenient. */
export interface TokenHubThrottle {
  limitType?: TokenHubLimitType;
  limit?: number;
  remaining?: number;
  resetsAt?: Date;
  /** The gateway's error text with the API key redacted. For logs only. */
  detail: string;
}

/** Redact API keys (LiteLLM's `api_key: <hash>`, `sk-…` keys, bearer tokens) from gateway text. */
export function redactTokenHubErrorText(text: string): string {
  return text
      .replace(/(api[_-]?key\s*[:=]\s*)[^\s"',]*[^\s"',.]/gi, "$1[redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, "sk-[redacted]")
      .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function errorStatus(error: unknown, text: string): number | undefined {
  if (error instanceof AgentTurnError && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  let match = /^\s*(\d{3})\b/.exec(text);
  return match ? Number(match[1]) : undefined;
}

// The JSON body pi appended after the status, unwrapped from LiteLLM's `{"error": {...}}` envelope
// when present. Undefined when there is no parseable object.
function parseBody(text: string): Record<string, unknown> | undefined {
  let start = text.indexOf("{");
  let end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    let parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    let record = parsed as Record<string, unknown>;
    let inner = record.error;
    return typeof inner === "object" && inner !== null && !Array.isArray(inner)
        ? inner as Record<string, unknown> : record;
  } catch {
    return undefined;
  }
}

function parseCount(text: string, label: RegExp): number | undefined {
  let match = label.exec(text);
  if (!match) return undefined;
  let value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

function parseResetsAt(text: string): Date | undefined {
  let match = /Limit resets at:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/i
      .exec(text);
  if (!match) return undefined;
  let date = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Classify `error` (as thrown for a TokenHub model request) as a LiteLLM throttling error: HTTP
 * 429, or a body with `type: "throttling_error"` / `code: "429"`. Returns null for anything else.
 * Missing or malformed limit details still classify as throttled, just without that detail.
 * Never throws.
 */
export function parseTokenHubThrottle(error: unknown): TokenHubThrottle | null {
  try {
    let text = errorText(error);
    let body = parseBody(text);
    let throttled = errorStatus(error, text) === 429 ||
        body?.type === "throttling_error" ||
        (body?.code !== undefined && String(body.code) === "429");
    if (!throttled) return null;

    // Prefer the body's message; fall back to the whole text for a body that didn't parse.
    let message = typeof body?.message === "string" ? body.message : text;
    let throttle: TokenHubThrottle = {
      detail: redactTokenHubErrorText(text).slice(0, MAX_DETAIL_CHARS),
    };
    let limitType = /Limit type:\s*([A-Za-z_]+)/i.exec(message)?.[1]?.toLowerCase();
    if (limitType) {
      throttle.limitType = limitType === "requests" || limitType === "tokens" ? limitType : "other";
    }
    let limit = parseCount(message, /Current limit:\s*([\d,]+)/i);
    if (limit !== undefined) throttle.limit = limit;
    let remaining = parseCount(message, /Remaining:\s*(-?[\d,]+)/i);
    if (remaining !== undefined) throttle.remaining = remaining;
    let resetsAt = parseResetsAt(message);
    if (resetsAt) throttle.resetsAt = resetsAt;
    return throttle;
  } catch {
    return null;
  }
}

/**
 * Whether `error`, from a request to `config`, is a TokenHub throttle on a model served by the
 * Xcity model plane. runAgent must not retry such a failure as transient: the plan's per-minute
 * limit doesn't lift in the seconds its backoff waits, and every retry spends another request of
 * it. False for every non-Xcity model, leaving upstream's retry behaviour unchanged. Never throws.
 */
export function isXcityModelThrottle(config: AiModelConfig, error: unknown): boolean {
  return getXcityModelMetadata(config) !== undefined && parseTokenHubThrottle(error) !== null;
}

function formatWait(ms: number): string {
  let seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  let minutes = Math.floor(seconds / 60);
  let restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  let hours = Math.floor(minutes / 60);
  let restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/**
 * The one-line, user-facing message for a throttle, e.g. "TokenHub rate limit reached: your plan
 * allows 5 requests per minute. Limit resets in 42s. Upgrade your plan at https://xcity.ai".
 * Contains nothing from the gateway text beyond the parsed numbers, so no key can leak through it.
 */
export function formatTokenHubThrottleMessage(
    throttle: TokenHubThrottle, now: number, homeUrl?: string): string {
  let unit = throttle.limitType === "requests" ? "request"
      : throttle.limitType === "tokens" ? "token" : undefined;
  let parts = [unit && throttle.limit !== undefined
      ? `TokenHub rate limit reached: your plan allows ${throttle.limit.toLocaleString("en-US")} ` +
          `${unit}${throttle.limit === 1 ? "" : "s"} per minute.`
      : "TokenHub rate limit reached."];
  if (throttle.resetsAt) {
    let wait = throttle.resetsAt.getTime() - now;
    parts.push(wait > 0 ? `Limit resets in ${formatWait(wait)}.` : "Limit resets in a moment.");
  } else {
    parts.push("Try again in about a minute.");
  }
  if (homeUrl) parts.push(`Upgrade your plan at ${homeUrl}`);
  return parts.join(" ");
}

/**
 * Chat-boundary hook: for a model served by the Xcity model plane, replace a TokenHub throttling
 * failure with an AgentTurnError carrying the actionable message (and the original status, so
 * error triage is unchanged). Returns `error` itself -- the same reference -- when the model plane
 * isn't configured, the model isn't an Xcity one, or the error isn't a throttle. Never throws.
 */
export function translateXcityModelError(
    env: Cloudflare.Env, config: AiModelConfig, error: unknown, now = Date.now()): unknown {
  try {
    if (!getXcityConfig(env) || !getXcityModelMetadata(config)) return error;
    let throttle = parseTokenHubThrottle(error);
    if (!throttle) return error;

    logger.info("xcity tokenhub rate limit reached", {
      event: "xcity.tokenhub.throttled",
      modelId: config.model,
      detail: throttle.detail,
      ...(throttle.limitType ? { limitType: throttle.limitType } : {}),
      ...(throttle.limit !== undefined ? { limit: throttle.limit } : {}),
      ...(throttle.remaining !== undefined ? { remaining: throttle.remaining } : {}),
      ...(throttle.resetsAt ? { resetsAt: throttle.resetsAt.toISOString() } : {}),
    });
    let status = error instanceof AgentTurnError ? error.statusCode ?? 429 : 429;
    return new AgentTurnError(
        formatTokenHubThrottleMessage(throttle, now, getXcityHomeUrl(env)), status);
  } catch {
    return error;
  }
}
