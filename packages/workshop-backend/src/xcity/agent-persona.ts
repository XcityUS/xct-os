import { createWorkshopLogger } from "../observability.js";
import type { XcityConfig } from "./config.js";
import { isSafeXcityAgentSlug } from "./agent-catalog.js";
import { fetchWithOneRetry } from "./fetch-retry.js";
import {
  XcityModelPlane,
  type XcityModelPlaneStorage,
  type XcityUserIdentity,
} from "./model-plane.js";

const logger = createWorkshopLogger("workshop.xcity.agent-persona");

const PERSONA_CACHE_MS = 30 * 60 * 1000;

// Page size for the skill listing; the gateway caps `limit` at 200.
const SKILL_INDEX_PAGE_SIZE = 200;
// Backstop against an unbounded cursor walk if the gateway ever stops advancing.
const SKILL_INDEX_MAX_PAGES = 25;
// How long a failed index fetch is remembered before the next caller may try again. One
// availability sweep resolves hundreds of slugs, and without this each would refetch the index.
const SKILL_INDEX_FAILURE_MS = 60 * 1000;
// A rejected key does not become valid by itself; a re-minted key is a new cache key anyway.
const SKILL_INDEX_AUTH_FAILURE_MS = 5 * 60 * 1000;

/**
 * What tokenhub knows about a marketplace persona: the system prompt text (null when the skill
 * exists but no prompt was imported) and, when the skill is priced, the per-use price in KWH.
 */
export type XcityAgentPersonaDetails = {
  persona: string | null;
  /** Per-use price in KWH (`pricing.kwh_per_use`); undefined when the skill is free or unpriced. */
  kwhPerUse?: number;
};

/**
 * Xcity marketplace persona selected when a chat was created, stored on its `AiChatAgentContext`.
 * `persona === null` records that the catalog selection was valid but tokenhub did not have the
 * persona prompt at creation time, so the chat intentionally behaves like an ordinary coding-agent
 * chat.
 */
export type XcityChatAgentSnapshot = {
  slug: string;
  displayName: string;
  persona: string | null;
};

type PersonaCacheEntry = {
  fetchedAt: number;
  details: XcityAgentPersonaDetails;
};

// slug -> skill_id for every persona the importer has published.
type SkillIndexEntry = {
  fetchedAt: number;
  bySlug: Map<string, string>;
};

type SkillIndexResult = { bySlug: Map<string, string> } | { retryAfterMs: number };

let personaCache = new Map<string, PersonaCacheEntry>();
let skillIndexCache = new Map<string, SkillIndexEntry>();
// Keyed by skillIndexAttemptKey (tokenhub + caller's key), never by tokenhub alone: one user's
// rejected key must not fail, or share a fetch with, another user's lookup.
let skillIndexFailedUntil = new Map<string, number>();
let skillIndexInFlight = new Map<string, Promise<Map<string, string> | null>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cacheKey(config: XcityConfig, slug: string): string {
  return `${config.tokenhubUrl}\n${slug}`;
}

function skillIndexAttemptKey(apiKey: string, config: XcityConfig): string {
  return `${config.tokenhubUrl}\n${apiKey}`;
}

function skillIndexFailure(status?: number): { retryAfterMs: number } {
  return {
    retryAfterMs: status === 401 || status === 403
      ? SKILL_INDEX_AUTH_FAILURE_MS
      : SKILL_INDEX_FAILURE_MS,
  };
}

function parsePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parsePersona(body: unknown): XcityAgentPersonaDetails {
  let record = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(record)) return { persona: null };

  let persona = optionalString(record.system_prompt_template)?.trim() ?? null;
  let pricing = isRecord(record.pricing) ? record.pricing : undefined;
  let kwhPerUse = parsePositiveNumber(pricing?.kwh_per_use);
  return {
    persona,
    ...(kwhPerUse !== undefined ? { kwhPerUse } : {}),
  };
}

// Build slug -> skill_id from the gateway's skill listing.
//
// The gateway assigns skill ids itself (the column defaults to a uuid; `POST /v1/xct-skills`
// takes no id), so the importer records the agent slug in `xct_metadata.xct_agent_slug` and this
// is the only way back from a slug to the row. The listing returns whole rows including the
// prompt text, but we keep just the ids: a user reads one persona per chat, and holding every
// persona in memory to serve one of them is the wrong trade.
async function fetchSkillIndex(apiKey: string, config: XcityConfig): Promise<SkillIndexResult> {
  let bySlug = new Map<string, string>();
  let cursor: string | undefined;

  for (let page = 0; page < SKILL_INDEX_MAX_PAGES; page++) {
    let url = new URL(`${config.tokenhubUrl}/v1/xct-skills`);
    url.searchParams.set("limit", String(SKILL_INDEX_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);

    let response: Response;
    try {
      response = await fetchWithOneRetry(url, () => ({
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      }));
    } catch (error) {
      logger.warn("xcity skill index request failed", {
        event: "xcity.agent.persona.index.failed", error,
      });
      return skillIndexFailure();
    }
    if (!response.ok) {
      response.body?.cancel();
      logger.warn("xcity skill index request failed", {
        event: "xcity.agent.persona.index.failed",
        status: response.status, statusText: response.statusText,
      });
      return skillIndexFailure(response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      logger.warn("xcity skill index response could not be read", {
        event: "xcity.agent.persona.index.malformed", error,
      });
      return skillIndexFailure();
    }
    if (!isRecord(body) || !Array.isArray(body.data)) return skillIndexFailure();

    for (let row of body.data) {
      if (!isRecord(row)) continue;
      let skillId = optionalString(row.skill_id);
      let metadata = isRecord(row.xct_metadata) ? row.xct_metadata : undefined;
      let slug = optionalString(metadata?.xct_agent_slug);
      // First row wins: a duplicate slug means the registry has drifted, and silently switching
      // between the copies from one refresh to the next would be worse than picking one.
      if (skillId && slug && !bySlug.has(slug)) bySlug.set(slug, skillId);
    }

    cursor = optionalString(body.next_cursor);
    if (body.has_more !== true || !cursor) return { bySlug };
  }

  logger.warn("xcity skill index pagination did not terminate", {
    event: "xcity.agent.persona.index.truncated",
  });
  return { bySlug };
}

// Fetch the index at most once per key at a time, and not at all while a recent failure for that
// key is remembered: concurrent callers share the pending fetch, later ones get null for free.
function loadSkillIndex(apiKey: string, config: XcityConfig): Promise<Map<string, string> | null> {
  let key = skillIndexAttemptKey(apiKey, config);
  let failedUntil = skillIndexFailedUntil.get(key);
  if (failedUntil !== undefined && Date.now() < failedUntil) return Promise.resolve(null);

  let pending = skillIndexInFlight.get(key);
  if (pending) return pending;
  pending = fetchSkillIndex(apiKey, config).then(result => {
    if ("bySlug" in result) return result.bySlug;
    let now = Date.now();
    for (let [other, until] of skillIndexFailedUntil) {
      if (until <= now) skillIndexFailedUntil.delete(other);
    }
    skillIndexFailedUntil.set(key, now + result.retryAfterMs);
    return null;
  }).finally(() => {
    skillIndexInFlight.delete(key);
  });
  skillIndexInFlight.set(key, pending);
  return pending;
}

async function resolveSkillId(apiKey: string, config: XcityConfig, slug: string): Promise<string | null> {
  let cached = skillIndexCache.get(config.tokenhubUrl);
  if (!cached || Date.now() - cached.fetchedAt >= PERSONA_CACHE_MS) {
    let bySlug = await loadSkillIndex(apiKey, config);
    if (!bySlug) return null;
    cached = { fetchedAt: Date.now(), bySlug };
    skillIndexCache.set(config.tokenhubUrl, cached);
  }
  // Falling back to the slug itself covers a gateway that lets the importer choose the id, so
  // this keeps working unchanged if that lands upstream.
  return cached.bySlug.get(slug) ?? slug;
}

async function fetchPersona(apiKey: string, config: XcityConfig, slug: string): Promise<{
  status: "ok";
  details: XcityAgentPersonaDetails;
} | {
  status: "unauthorized";
} | {
  status: "failed";
}> {
  let skillId = await resolveSkillId(apiKey, config, slug);
  if (!skillId) return { status: "failed" };

  let response: Response;
  try {
    response = await fetchWithOneRetry(
        `${config.tokenhubUrl}/v1/xct-skills/${encodeURIComponent(skillId)}`, () => ({
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        }));
  } catch (error) {
    logger.warn("xcity agent persona request failed", {
      event: "xcity.agent.persona.failed", agentSlug: slug, error,
    });
    return { status: "failed" };
  }

  if (response.status === 401) {
    response.body?.cancel();
    return { status: "unauthorized" };
  }
  if (response.status === 404) {
    logger.info("xcity agent persona is unavailable", {
      event: "xcity.agent.persona.unavailable", agentSlug: slug, status: response.status,
    });
    response.body?.cancel();
    return { status: "ok", details: { persona: null } };
  }
  if (!response.ok) {
    logger.warn("xcity agent persona request failed", {
      event: "xcity.agent.persona.failed",
      agentSlug: slug,
      status: response.status,
      statusText: response.statusText,
    });
    response.body?.cancel();
    return { status: "failed" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    logger.warn("xcity agent persona response could not be read", {
      event: "xcity.agent.persona.malformed", agentSlug: slug, error,
    });
    return { status: "failed" };
  }

  let details = parsePersona(body);
  if (!details.persona) {
    logger.info("xcity agent persona is unavailable", {
      event: "xcity.agent.persona.unavailable", agentSlug: slug,
    });
  }
  return { status: "ok", details };
}

/**
 * Fetch the marketplace persona for `slug` through the user's own tokenhub virtual key, along
 * with its per-use pricing. Cached in-isolate for 30 minutes. Returns null when the slug is
 * unsafe, no key could be minted, or tokenhub failed; `{ persona: null }` records a valid skill
 * without an imported prompt.
 */
export async function getXcityAgentPersonaDetails(
    env: Cloudflare.Env,
    config: XcityConfig,
    storage: XcityModelPlaneStorage,
    identity: XcityUserIdentity,
    slug: string,
    email?: string): Promise<XcityAgentPersonaDetails | null> {
  if (!isSafeXcityAgentSlug(slug)) return null;

  let key = cacheKey(config, slug);
  let cached = personaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PERSONA_CACHE_MS) {
    return cached.details;
  }

  let tokenhubKey = await XcityModelPlane.getUserTokenhubKey(
      env, config, storage, identity.userId, email ?? identity.email, false);
  if (!tokenhubKey) return null;

  let fetched = await fetchPersona(tokenhubKey.key, config, slug);
  if (fetched.status === "unauthorized") {
    tokenhubKey = await XcityModelPlane.getUserTokenhubKey(
        env, config, storage, identity.userId, email ?? identity.email, true);
    if (!tokenhubKey) return null;
    fetched = await fetchPersona(tokenhubKey.key, config, slug);
  }
  if (fetched.status !== "ok") return null;

  personaCache.set(key, {
    fetchedAt: Date.now(),
    details: fetched.details,
  });
  return fetched.details;
}

/**
 * Fetch just the persona prompt for `slug` (see getXcityAgentPersonaDetails). Kept for callers
 * that only inject the prompt and don't care about pricing.
 */
export async function getXcityAgentPersona(
    env: Cloudflare.Env,
    config: XcityConfig,
    storage: XcityModelPlaneStorage,
    identity: XcityUserIdentity,
    slug: string,
    email?: string): Promise<string | null> {
  let details = await getXcityAgentPersonaDetails(env, config, storage, identity, slug, email);
  return details?.persona ?? null;
}

export function clearXcityAgentPersonaCacheForTests(): void {
  personaCache = new Map();
  skillIndexCache = new Map();
  skillIndexFailedUntil = new Map();
  skillIndexInFlight = new Map();
}

function escapeXmlText(text: string): string {
  return text.replace(/[<>&]/g, char => {
    switch (char) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      default: return char;
    }
  });
}

/**
 * Formats a marketplace persona for the coding agent's static system prompt slot (see agent.ts).
 * Returns "" when there is no persona text, so the caller can skip it without a branch of its own.
 */
export function formatAgentPersona(name: string, persona: string | null | undefined): string {
  let trimmed = persona?.trim();
  if (!trimmed) return "";
  return `<xcity-agent-persona>\n` +
      `<name>${escapeXmlText(name)}</name>\n` +
      `<instructions>\n${trimmed}\n</instructions>\n` +
      `</xcity-agent-persona>`;
}
