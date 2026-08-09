import type { XcityCatalogAgent, XcityCatalogAgentSkill } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "../observability.js";
import { getXcityHomeUrl } from "./config.js";

const logger = createWorkshopLogger("workshop.xcity.agent-catalog");

const CATALOG_CACHE_MS = 5 * 60 * 1000;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

type CatalogCache = {
  homeUrl: string;
  fetchedAt: number;
  agents: XcityCatalogAgent[];
};

let catalogCache: CatalogCache | undefined;

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
    availablePlans: optionalStringArray(value.available_plans),
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

export async function listXcityAgents(env: Cloudflare.Env): Promise<XcityCatalogAgent[]> {
  let homeUrl = getXcityHomeUrl(env);
  if (!homeUrl) return [];

  if (catalogCache && catalogCache.homeUrl === homeUrl &&
      Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_MS) {
    return catalogCache.agents;
  }

  let response: Response;
  try {
    response = await fetch(`${homeUrl}/api/catalog/agents`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    logger.warn("xcity agent catalog request failed", {
      event: "xcity.agent.catalog.failed", error,
    });
    return [];
  }

  if (!response.ok) {
    logger.warn("xcity agent catalog request failed", {
      event: "xcity.agent.catalog.failed",
      status: response.status,
      statusText: response.statusText,
    });
    response.body?.cancel();
    return [];
  }

  let parsed: { agents: XcityCatalogAgent[]; degraded: boolean } | undefined;
  try {
    parsed = parseCatalog(await response.json());
  } catch (error) {
    logger.warn("xcity agent catalog response could not be read", {
      event: "xcity.agent.catalog.malformed", error,
    });
    return [];
  }

  if (!parsed) {
    logger.warn("xcity agent catalog response was malformed", {
      event: "xcity.agent.catalog.malformed",
    });
    return [];
  }
  if (parsed.degraded) {
    logger.warn("xcity agent catalog is degraded", {
      event: "xcity.agent.catalog.degraded",
    });
    return [];
  }

  catalogCache = {
    homeUrl,
    fetchedAt: Date.now(),
    agents: parsed.agents,
  };
  return parsed.agents;
}

export async function getXcityAgent(
    env: Cloudflare.Env, slug: string): Promise<XcityCatalogAgent | null> {
  if (!isSafeXcityAgentSlug(slug)) return null;
  return (await listXcityAgents(env)).find(agent => agent.slug === slug) ?? null;
}

export function clearXcityAgentCatalogCacheForTests(): void {
  catalogCache = undefined;
}
