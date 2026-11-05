import type { XcityCatalogAgent, XcityCatalogAgentSkill } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "../observability.js";
import { getXcityHomeUrl } from "./config.js";
import { fetchWithOneRetry } from "./fetch-retry.js";

const logger = createWorkshopLogger("workshop.xcity.agent-catalog");

const CATALOG_CACHE_MS = 5 * 60 * 1000;
// Ceiling for serving a stale catalog: within 24h we serve stale and revalidate in the
// background; past it (or with no cache at all) the refresh happens inline, blocking the caller.
const CATALOG_STALE_MAX_MS = 24 * 60 * 60 * 1000;
// Edge cache lifetime for the catalog snapshot, matching the module cache's fresh window.
const EDGE_CACHE_MAX_AGE_SECONDS = 300;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

type CatalogCache = {
  homeUrl: string;
  fetchedAt: number;
  agents: XcityCatalogAgent[];
};

let catalogCache: CatalogCache | undefined;

// Single-flight guard for the background revalidation kicked off by a stale-cache hit.
let inflightCatalogRefresh: Promise<void> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function parseSkill(value: unknown): XcityCatalogAgentSkill | undefined {
  if (!isRecord(value)) return undefined;
  let id = optionalString(value.id);
  let name = optionalString(value.name);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    description: optionalString(value.description),
    tags: optionalStringArray(value.tags),
    examples: optionalStringArray(value.examples),
  };
}

function parseAgent(value: unknown): XcityCatalogAgent | undefined {
  if (!isRecord(value)) return undefined;

  let slug = optionalString(value.slug);
  if (!slug || !isSafeXcityAgentSlug(slug)) return undefined;

  let id = optionalString(value.id) ?? slug;
  let displayName = optionalString(value.displayName) ?? optionalString(value.name) ?? slug;
  return {
    id,
    slug,
    displayName,
    emoji: optionalString(value.emoji),
    name: optionalString(value.name),
    description: optionalString(value.description),
    category: optionalString(value.category),
    tags: optionalStringArray(value.tags),
    skills: Array.isArray(value.skills)
        ? value.skills.map(parseSkill).filter((skill): skill is XcityCatalogAgentSkill => !!skill)
        : [],
    version: optionalString(value.version),
    streaming: optionalBoolean(value.streaming),
    source: optionalString(value.source),
    authorName: optionalString(value.authorName),
    createdBy: optionalString(value.createdBy),
    // available_plans is the upstream wire shape; availablePlans re-parses our own already-parsed
    // agents when a fresh isolate warms from the edge-cached snapshot.
    availablePlans: optionalStringArray(value.available_plans ?? value.availablePlans),
  };
}

function parseCatalog(body: unknown): { agents: XcityCatalogAgent[]; degraded: boolean } | undefined {
  if (!isRecord(body) || !Array.isArray(body.data)) return undefined;
  let agents = body.data.map(parseAgent).filter((agent): agent is XcityCatalogAgent => !!agent);
  return {
    agents,
    degraded: body.degraded === true,
  };
}

export function isSafeXcityAgentSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

type CatalogFetchOutcome =
  | { status: "ok"; agents: XcityCatalogAgent[] }
  | { status: "degraded"; agents: XcityCatalogAgent[] }
  | { status: "failed" };

async function fetchAgentCatalog(homeUrl: string): Promise<CatalogFetchOutcome> {
  let response: Response;
  try {
    response = await fetchWithOneRetry(`${homeUrl}/api/catalog/agents`, () => ({
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }));
  } catch (error) {
    logger.warn("xcity agent catalog request failed", {
      event: "xcity.agent.catalog.failed", error,
    });
    return { status: "failed" };
  }

  if (!response.ok) {
    logger.warn("xcity agent catalog request failed", {
      event: "xcity.agent.catalog.failed",
      status: response.status,
      statusText: response.statusText,
    });
    response.body?.cancel();
    return { status: "failed" };
  }

  let parsed: { agents: XcityCatalogAgent[]; degraded: boolean } | undefined;
  try {
    parsed = parseCatalog(await response.json());
  } catch (error) {
    logger.warn("xcity agent catalog response could not be read", {
      event: "xcity.agent.catalog.malformed", error,
    });
    return { status: "failed" };
  }

  if (!parsed) {
    logger.warn("xcity agent catalog response was malformed", {
      event: "xcity.agent.catalog.malformed",
    });
    return { status: "failed" };
  }
  if (parsed.degraded) {
    logger.warn("xcity agent catalog is degraded", {
      event: "xcity.agent.catalog.degraded",
    });
    return { status: "degraded", agents: parsed.agents };
  }
  return { status: "ok", agents: parsed.agents };
}

// The synthetic edge-cache key: the upstream URL itself. The body we cache is our own wrapper
// ({fetchedAt, agents}), not the upstream response.
function edgeCacheUrl(homeUrl: string): string {
  return `${homeUrl}/api/catalog/agents`;
}

function getEdgeCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

// Warm a fresh isolate from the Workers cache instead of hitting xct-home. Best-effort: the Cache
// API can be unavailable or throw in tests/miniflare, so any failure reads as a miss.
async function matchEdgeCache(homeUrl: string): Promise<CatalogCache | undefined> {
  try {
    let cache = getEdgeCache();
    if (!cache) return undefined;
    let hit = await cache.match(edgeCacheUrl(homeUrl));
    if (!hit) return undefined;
    let body: unknown = await hit.json();
    if (!isRecord(body) || typeof body.fetchedAt !== "number" || !Array.isArray(body.agents)) {
      return undefined;
    }
    let agents = body.agents.map(parseAgent)
        .filter((agent): agent is XcityCatalogAgent => !!agent);
    logger.info("warmed xcity agent catalog from edge cache", {
      event: "xcity.agent.catalog.edge-hit",
    });
    return { homeUrl, fetchedAt: body.fetchedAt, agents };
  } catch {
    return undefined;
  }
}

async function putEdgeCache(entry: CatalogCache): Promise<void> {
  try {
    let cache = getEdgeCache();
    if (!cache) return;
    await cache.put(edgeCacheUrl(entry.homeUrl), new Response(
        JSON.stringify({ fetchedAt: entry.fetchedAt, agents: entry.agents }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${EDGE_CACHE_MAX_AGE_SECONDS}`,
          },
        }));
  } catch {
    // Best-effort only; the module cache still has the fresh catalog.
  }
}

async function storeCatalog(homeUrl: string, agents: XcityCatalogAgent[]): Promise<void> {
  catalogCache = { homeUrl, fetchedAt: Date.now(), agents };
  await putEdgeCache(catalogCache);
}

// Fire-and-forget revalidation for the stale-serve path (no ExecutionContext is reachable here,
// so this is a detached promise chain). A failed or degraded refresh keeps the stale catalog.
function revalidateInBackground(homeUrl: string): void {
  if (inflightCatalogRefresh) return;
  inflightCatalogRefresh = (async () => {
    let outcome = await fetchAgentCatalog(homeUrl);
    if (outcome.status === "ok") {
      await storeCatalog(homeUrl, outcome.agents);
    }
  })()
      .catch(error => {
        logger.warn("background xcity agent catalog refresh failed", {
          event: "xcity.agent.catalog.refresh.failed", error,
        });
      })
      .finally(() => {
        inflightCatalogRefresh = undefined;
      });
}

/**
 * Lists the marketplace agents from xct-home's public catalog. Never throws; on upstream failure
 * serves the last good catalog (module cache, or the Workers edge cache for fresh isolates) and
 * only falls back to an empty list when there is nothing cached at all.
 */
export async function listXcityAgents(env: Cloudflare.Env): Promise<XcityCatalogAgent[]> {
  let homeUrl = getXcityHomeUrl(env);
  if (!homeUrl) return [];

  let cached = catalogCache && catalogCache.homeUrl === homeUrl ? catalogCache : undefined;
  let age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;

  if (cached && age < CATALOG_CACHE_MS) {
    return cached.agents;
  }

  // Fresh isolate: try to warm from the edge before going to xct-home.
  if (!cached) {
    let edge = await matchEdgeCache(homeUrl);
    if (edge) {
      catalogCache = edge;
      cached = edge;
      age = Date.now() - edge.fetchedAt;
      if (age < CATALOG_CACHE_MS) return edge.agents;
    }
  }

  if (cached && age < CATALOG_STALE_MAX_MS) {
    // Stale but recent enough: serve immediately and revalidate off the request path.
    logger.info("serving stale xcity agent catalog while revalidating", {
      event: "xcity.agent.catalog.stale-served", durationMs: age,
    });
    revalidateInBackground(homeUrl);
    return cached.agents;
  }

  // No usable cache (or one past the stale ceiling): refresh inline.
  let outcome = await fetchAgentCatalog(homeUrl);
  if (outcome.status === "ok") {
    await storeCatalog(homeUrl, outcome.agents);
    return outcome.agents;
  }
  if (cached) {
    logger.warn("serving stale xcity agent catalog after refresh failure", {
      event: "xcity.agent.catalog.stale-served", durationMs: age,
    });
    return cached.agents;
  }
  if (outcome.status === "degraded") {
    // Nothing cached at all: a degraded snapshot beats an empty picker, but don't cache it —
    // the next call gets another chance at a full catalog.
    return outcome.agents;
  }
  return [];
}

export async function getXcityAgent(
    env: Cloudflare.Env, slug: string): Promise<XcityCatalogAgent | null> {
  if (!isSafeXcityAgentSlug(slug)) return null;
  return (await listXcityAgents(env)).find(agent => agent.slug === slug) ?? null;
}

/**
 * Resets the module cache (test hook). Also drops the edge-cached snapshot so tests don't warm
 * from a previous test's catalog.
 */
export async function clearXcityAgentCatalogCacheForTests(): Promise<void> {
  let homeUrl = catalogCache?.homeUrl;
  catalogCache = undefined;
  inflightCatalogRefresh = undefined;
  if (homeUrl) {
    try {
      await getEdgeCache()?.delete(edgeCacheUrl(homeUrl));
    } catch {
      // The Cache API may be unavailable in this test environment.
    }
  }
}

/** Awaits any in-flight background catalog revalidation (test hook). */
export async function flushXcityAgentCatalogRefreshForTests(): Promise<void> {
  for (;;) {
    let pending = inflightCatalogRefresh;
    if (!pending) return;
    await pending;
  }
}
