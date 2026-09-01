import type {
  AiChatAuthorInfo,
  AiModelConfig,
  XcityProviderDiagnostics,
} from "@gadgets/workshop-shared/api";
import type { Singleton } from "@gadgets/typed-storage";
import type { Model, Api } from "@earendil-works/pi-ai";
import { createWorkshopLogger } from "../observability.js";
import type { UserAiModelRecord } from "../user.js";
import type { XcityConfig } from "./config.js";
import { fetchWithOneRetry } from "./fetch-retry.js";

const logger = createWorkshopLogger("workshop.xcity.model-plane");

const CATALOG_CACHE_MS = 10 * 60 * 1000;
// Ceiling for serving a stale catalog: within 24h we serve stale and revalidate in the
// background; past it (or with no cache at all) the refresh happens inline, blocking the caller.
const CATALOG_STALE_MAX_MS = 24 * 60 * 60 * 1000;
export const XCITY_VENDOR_ID = "xcity";

/**
 * LiteLLM grant markers that `GET /v1/models` can echo back as if they were model ids. They are
 * entitlement placeholders on a virtual key, never callable model names: chatting with one gets
 * `400 Invalid model name passed in model=*` from the proxy. Note that LiteLLM does NOT expand a
 * literal `*` — a key minted with `models: ["*"]` yields a catalog of exactly this one fake
 * entry — so they are dropped before anything reaches the user's model list.
 */
export const LITELLM_GRANT_SENTINEL_MODEL_IDS: readonly string[] = [
  "*",
  "all-proxy-models",
  "all-team-models",
  "no-default-models",
];

/** True when `id` is a LiteLLM grant marker rather than a real, callable model id. */
export function isLiteLlmGrantSentinelModelId(id: string): boolean {
  return LITELLM_GRANT_SENTINEL_MODEL_IDS.includes(id);
}

// Single-flight guard for background catalog refreshes, keyed per tokenhub + user. The User DO is
// effectively single-threaded, but overlapping requests during the stale window would otherwise
// each kick their own refresh.
const inflightCatalogRefreshes = new Map<string, Promise<void>>();

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

export type JsonRecord = { [key: string]: JsonValue };

export type XcityUserIdentity = {
  userId: string;
  email?: string;
};

export type XcityModelCapabilities = {
  vision?: boolean;
  pdfInput?: boolean;
  functionCalling?: boolean;
  structuredOutput?: boolean;
  promptCaching?: boolean;
  webSearch?: boolean;
  audioInput?: boolean;
  audioOutput?: boolean;
};

export type XcityModelMetadata = {
  tokenhubUrl: string;
  xcityUserId: string;
  raw: JsonRecord;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  capabilities?: XcityModelCapabilities;
};

export type XcityAiModelConfig = AiModelConfig & {
  xcity?: XcityModelMetadata;
};

export type XcityVirtualKeyRecord = {
  userId: string;
  email?: string;
  walletUrl: string;
  key: string;
  keyToken?: string;
  walletId?: string;
  plan?: JsonValue;
  minted?: boolean;
  mintedAt: number;
};

export type XcityModelCatalogRecord = {
  tokenhubUrl: string;
  keyMintedAt: number;
  fetchedAt: number;
  models: Array<Omit<UserAiModelRecord, "config"> & { config: XcityAiModelConfig }>;
  /**
   * True when the fetched catalog held only LiteLLM grant sentinels, so `models` is empty for a
   * reason worth reporting. Persisted so a cache hit reports it too, instead of degrading into
   * an indistinguishable "no models granted".
   */
  grantNotExpanded?: boolean;
};

export type XcityModelPlaneCache = {
  key?: XcityVirtualKeyRecord;
  catalog?: XcityModelCatalogRecord;
};

export type XcityModelPlaneStorage = Singleton<XcityModelPlaneCache>;

type XcityModelLike = Model<Api> & {
  xcity?: XcityModelMetadata;
};

type WalletKeyResponse = {
  key: string;
  keyToken?: string;
  walletId?: string;
  plan?: JsonValue;
  minted?: boolean;
};

type CatalogFetchResult =
  | { status: "ok"; body: unknown }
  | { status: "unauthorized" }
  | { status: "failed" };

/**
 * A blank diagnostics record for one model-plane call. `identity` starts true because reaching
 * the plane at all means an Xcity identity was resolved; callers with no identity build their
 * own record with `identity: false`.
 */
export function newXcityProviderDiagnostics(): XcityProviderDiagnostics {
  return { identity: true, keyPresent: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify a thrown fetch into a short, user-safe string. Raw errors (and any upstream detail
 * they carry) never leave the worker.
 */
function classifyFetchError(error: unknown): string {
  let name = isRecord(error) && typeof error.name === "string" ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network-error";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

function asJsonRecord(value: Record<string, unknown>): JsonRecord {
  let result: JsonRecord = {};
  for (let [key, field] of Object.entries(value)) {
    if (isJsonValue(field)) result[key] = field;
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseWalletKeyResponse(body: unknown): WalletKeyResponse | undefined {
  if (!isRecord(body)) return undefined;
  let key = optionalString(body.key);
  if (!key) return undefined;
  return {
    key,
    keyToken: optionalString(body.key_token),
    walletId: optionalString(body.wallet_id),
    plan: isJsonValue(body.plan) ? body.plan : undefined,
    minted: optionalBoolean(body.minted),
  };
}

function parseCapabilities(raw: Record<string, unknown>): XcityModelCapabilities | undefined {
  let capabilities = isRecord(raw.capabilities) ? raw.capabilities : undefined;
  if (!capabilities) return undefined;

  let result: XcityModelCapabilities = {};
  let vision = optionalBoolean(capabilities.vision);
  let pdfInput = optionalBoolean(capabilities.pdf_input);
  let functionCalling = optionalBoolean(capabilities.function_calling);
  let structuredOutput = optionalBoolean(capabilities.structured_output);
  let promptCaching = optionalBoolean(capabilities.prompt_caching);
  let webSearch = optionalBoolean(capabilities.web_search);
  let audioInput = optionalBoolean(capabilities.audio_input);
  let audioOutput = optionalBoolean(capabilities.audio_output);
  if (vision !== undefined) result.vision = vision;
  if (pdfInput !== undefined) result.pdfInput = pdfInput;
  if (functionCalling !== undefined) result.functionCalling = functionCalling;
  if (structuredOutput !== undefined) result.structuredOutput = structuredOutput;
  if (promptCaching !== undefined) result.promptCaching = promptCaching;
  if (webSearch !== undefined) result.webSearch = webSearch;
  if (audioInput !== undefined) result.audioInput = audioInput;
  if (audioOutput !== undefined) result.audioOutput = audioOutput;
  return Object.keys(result).length > 0 ? result : undefined;
}

function modelCostScore(config: XcityAiModelConfig): number | undefined {
  let metadata = config.xcity;
  if (!metadata) return undefined;
  let input = metadata.inputCostPerToken;
  let output = metadata.outputCostPerToken;
  return input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined;
}

export function getXcityModelMetadata(config: AiModelConfig): XcityModelMetadata | undefined {
  return (config as XcityAiModelConfig).xcity;
}

export function getXcityModelDescriptorMetadata(model: Model<Api>): XcityModelMetadata | undefined {
  return (model as XcityModelLike).xcity;
}

export function attachXcityModelDescriptorMetadata<T extends Model<Api>>(
    model: T, config: AiModelConfig): T {
  let metadata = getXcityModelMetadata(config);
  if (metadata) {
    (model as XcityModelLike).xcity = metadata;
  }
  return model;
}

export function xcityModelCost(config: AiModelConfig) {
  let metadata = getXcityModelMetadata(config);
  if (!metadata) return undefined;
  return {
    input: metadata.inputCostPerToken ?? 0,
    output: metadata.outputCostPerToken ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

export function tokenhubModelToRecord(
    rawModel: unknown,
    context: { tokenhubUrl: string; apiKey: string; xcityUserId: string }
): (Omit<UserAiModelRecord, "config"> & { config: XcityAiModelConfig }) | undefined {
  if (!isRecord(rawModel)) return undefined;
  let id = optionalString(rawModel.id);
  if (!id) return undefined;

  let metadata: XcityModelMetadata = {
    tokenhubUrl: context.tokenhubUrl,
    xcityUserId: context.xcityUserId,
    raw: asJsonRecord(rawModel),
  };
  let contextWindow = optionalPositiveInteger(rawModel.context_window);
  let maxOutputTokens = optionalPositiveInteger(rawModel.max_output_tokens);
  let inputCostPerToken = optionalFiniteNumber(rawModel.input_cost_per_token);
  let outputCostPerToken = optionalFiniteNumber(rawModel.output_cost_per_token);
  let capabilities = parseCapabilities(rawModel);
  if (contextWindow !== undefined) metadata.contextWindow = contextWindow;
  if (maxOutputTokens !== undefined) metadata.maxOutputTokens = maxOutputTokens;
  if (inputCostPerToken !== undefined) metadata.inputCostPerToken = inputCostPerToken;
  if (outputCostPerToken !== undefined) metadata.outputCostPerToken = outputCostPerToken;
  if (capabilities) metadata.capabilities = capabilities;

  let profile: AiChatAuthorInfo = { type: "agent", id, name: id };
  let config: XcityAiModelConfig = {
    provider: "ollama",
    model: id,
    apiUrl: `${context.tokenhubUrl}/v1`,
    apiToken: context.apiKey,
    xcity: metadata,
  };
  return { profile, config };
}

export type ParsedTokenhubModelCatalog = {
  /** Real, callable models — LiteLLM grant sentinels are already dropped. */
  models: Array<Omit<UserAiModelRecord, "config"> & { config: XcityAiModelConfig }>;

  /** How many entries were dropped for being LiteLLM grant sentinels. */
  sentinelCount: number;
};

/**
 * Parses a tokenhub `GET /v1/models` body, dropping LiteLLM grant sentinels
 * (`LITELLM_GRANT_SENTINEL_MODEL_IDS`) and reporting how many were dropped. Returns undefined
 * only when the body itself is malformed.
 *
 * The counts matter because `sentinelCount > 0` with no models left means the gateway never
 * expanded the key's grant — a wallet/key provisioning bug that looks identical to "no models
 * granted" unless it is reported separately.
 */
export function parseTokenhubModelCatalogEntries(
    body: unknown,
    context: { tokenhubUrl: string; apiKey: string; xcityUserId: string }
): ParsedTokenhubModelCatalog | undefined {
  if (!isRecord(body) || !Array.isArray(body.data)) return undefined;
  let models: ParsedTokenhubModelCatalog["models"] = [];
  let sentinelCount = 0;
  for (let rawModel of body.data) {
    let record = tokenhubModelToRecord(rawModel, context);
    if (!record) continue;
    if (isLiteLlmGrantSentinelModelId(record.profile.id)) {
      sentinelCount++;
      continue;
    }
    models.push(record);
  }
  return { models, sentinelCount };
}

/**
 * The model list from a tokenhub `GET /v1/models` body, with LiteLLM grant sentinels removed;
 * undefined when the body is malformed. Use `parseTokenhubModelCatalogEntries` when the count of
 * dropped sentinels is needed too.
 */
export function parseTokenhubModelCatalog(
    body: unknown,
    context: { tokenhubUrl: string; apiKey: string; xcityUserId: string }
): Array<Omit<UserAiModelRecord, "config"> & { config: XcityAiModelConfig }> | undefined {
  return parseTokenhubModelCatalogEntries(body, context)?.models;
}

export function pickQuickXcityModelConfig(
    models: readonly (Omit<UserAiModelRecord, "config"> & { config: XcityAiModelConfig })[],
    quickModel?: string,
): XcityAiModelConfig | undefined {
  if (quickModel) {
    return models.find(record => record.profile.id === quickModel)?.config;
  }

  let best: { config: XcityAiModelConfig; score: number } | undefined;
  for (let { config } of models) {
    let score = modelCostScore(config);
    if (score === undefined) {
      if (!best) best = { config, score: Number.POSITIVE_INFINITY };
      continue;
    }
    if (!best || score < best.score) best = { config, score };
  }
  return best?.config;
}

/**
 * Awaits (and thereby drains) all in-flight background catalog refreshes, so tests can assert on
 * their outcome deterministically.
 */
export async function flushXcityCatalogRefreshesForTests(): Promise<void> {
  while (inflightCatalogRefreshes.size > 0) {
    await Promise.all(inflightCatalogRefreshes.values());
  }
}

function makeMemoryStorage(): XcityModelPlaneStorage {
  let value: XcityModelPlaneCache = {};
  return {
    get: () => value,
    put: next => { value = next; },
    subscribe: () => {},
    unsubscribe: () => {},
  };
}

export class XcityModelPlane {
  #config: XcityConfig;
  #storage: XcityModelPlaneStorage;
  #xcityUserId: string;
  #email?: string;
  #models: XcityModelCatalogRecord["models"];
  // Outcome of the load that built THIS instance. Background refreshes get their own record, so
  // nothing here is overwritten after forUser() resolves.
  #diagnostics: XcityProviderDiagnostics = newXcityProviderDiagnostics();

  private constructor(
      _env: Cloudflare.Env,
      config: XcityConfig,
      storage: XcityModelPlaneStorage,
      xcityUserId: string,
      email: string | undefined,
      models: XcityModelCatalogRecord["models"]) {
    this.#config = config;
    this.#storage = storage;
    this.#xcityUserId = xcityUserId;
    this.#email = email;
    this.#models = models;
  }

  static async forUser(
      env: Cloudflare.Env,
      config: XcityConfig,
      xcityUserId: string,
      email?: string,
  ): Promise<XcityModelPlane>;
  static async forUser(
      env: Cloudflare.Env,
      config: XcityConfig,
      storage: XcityModelPlaneStorage,
      xcityUserId: string,
      email?: string,
  ): Promise<XcityModelPlane>;
  static async forUser(
      env: Cloudflare.Env,
      config: XcityConfig,
      storageOrUserId: XcityModelPlaneStorage | string,
      xcityUserIdOrEmail?: string,
      email?: string,
  ): Promise<XcityModelPlane> {
    let storage: XcityModelPlaneStorage;
    let xcityUserId: string;
    if (typeof storageOrUserId === "string") {
      storage = makeMemoryStorage();
      xcityUserId = storageOrUserId;
      email = xcityUserIdOrEmail;
    } else {
      storage = storageOrUserId;
      xcityUserId = xcityUserIdOrEmail!;
    }

    let plane = new XcityModelPlane(env, config, storage, xcityUserId, email, []);
    plane.#models = await plane.#loadModels(plane.#diagnostics);
    return plane;
  }

  static async getUserTokenhubKey(
      env: Cloudflare.Env,
      config: XcityConfig,
      storage: XcityModelPlaneStorage,
      xcityUserId: string,
      email?: string,
      forceMint = false,
  ): Promise<XcityVirtualKeyRecord | undefined> {
    let plane = new XcityModelPlane(env, config, storage, xcityUserId, email, []);
    return plane.#ensureKey(forceMint, plane.#diagnostics);
  }

  getModelList(): AiChatAuthorInfo[] {
    return this.#models.map(record => record.profile);
  }

  /**
   * Per-hop outcome of the load that produced this instance's model list: identity, wallet key
   * mint, tokenhub catalog. Returned as a copy, so later background refreshes can't mutate it.
   */
  getDiagnostics(): XcityProviderDiagnostics {
    let diagnostics = this.#diagnostics;
    return {
      identity: diagnostics.identity,
      keyPresent: diagnostics.keyPresent,
      ...(diagnostics.keyMint ? { keyMint: { ...diagnostics.keyMint } } : {}),
      ...(diagnostics.catalog ? { catalog: { ...diagnostics.catalog } } : {}),
    };
  }

  resolveModel(modelId: string): UserAiModelRecord | undefined {
    return this.#models.find(record => record.profile.id === modelId);
  }

  getQuickModelConfig(): AiModelConfig | undefined {
    return pickQuickXcityModelConfig(this.#models, this.#config.quickModel);
  }

  async #loadModels(diagnostics: XcityProviderDiagnostics):
      Promise<XcityModelCatalogRecord["models"]> {
    let cache = this.#storage.get();
    // A cached catalog is usable only if it was fetched from the current tokenhub with the
    // currently-cached key (the model configs embed that key as their apiToken).
    let cached = cache.catalog && cache.key &&
        cache.catalog.tokenhubUrl === this.#config.tokenhubUrl &&
        cache.catalog.keyMintedAt === cache.key.mintedAt
        ? cache.catalog : undefined;
    let age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;

    // A cached key for this user and wallet counts as present even when no mint runs below.
    diagnostics.keyPresent = !!(cache.key &&
        cache.key.walletUrl === this.#config.walletUrl &&
        cache.key.userId === this.#xcityUserId);

    // A catalog that held only grant sentinels is a known-broken provisioning state, not a
    // legitimately empty one: the key is repaired on the wallet side without its token changing,
    // so honouring the cache here would keep serving an empty list for the rest of the TTL after
    // the fix landed. Always revalidate instead.
    if (cached && cached.grantNotExpanded) {
      let models = await this.#refreshModels(diagnostics);
      if (models) return models;
      diagnostics.catalog = {
        ...diagnostics.catalog,
        modelCount: cached.models.length,
        grantNotExpanded: true,
      };
      return cached.models;
    }

    if (cached && age < CATALOG_CACHE_MS) {
      diagnostics.catalog = { modelCount: cached.models.length };
      return cached.models;
    }

    if (cached && age < CATALOG_STALE_MAX_MS) {
      // Stale but recent enough: serve immediately and revalidate off the request path.
      logger.info("serving stale tokenhub model catalog while revalidating", {
        event: "xcity.tokenhub.models.stale-served", durationMs: age,
      });
      this.#refreshInBackground();
      diagnostics.catalog = {
        modelCount: cached.models.length,
        servedStale: true,
      };
      return cached.models;
    }

    // No usable cache (or one past the stale ceiling): refresh inline, but on failure still
    // prefer whatever we had over an empty model list.
    let models = await this.#refreshModels(diagnostics);
    if (models) return models;
    if (cached) {
      logger.warn("serving stale tokenhub model catalog after refresh failure", {
        event: "xcity.tokenhub.models.stale-served", durationMs: age,
      });
      // Keep the inline refresh's failure detail alongside what we ended up serving.
      diagnostics.catalog = {
        ...diagnostics.catalog,
        modelCount: cached.models.length,
        servedStale: true,
      };
      return cached.models;
    }
    return [];
  }

  /**
   * Refreshes the catalog from tokenhub (minting/re-minting the per-user key as needed) and
   * persists it on success. Returns undefined on failure without touching the cached catalog,
   * except that a key re-mint on 401 invalidates the catalog tied to the old key.
   *
   * `diagnostics` collects this refresh's per-hop outcome; background refreshes pass their own
   * record so they never overwrite what a completed forUser() call reported.
   */
  async #refreshModels(diagnostics: XcityProviderDiagnostics):
      Promise<XcityModelCatalogRecord["models"] | undefined> {
    let key = await this.#ensureKey(false, diagnostics);
    if (!key) return undefined;

    let fetched = await this.#fetchCatalog(key.key, diagnostics);
    if (fetched.status === "unauthorized") {
      key = await this.#ensureKey(true, diagnostics);
      if (!key) return undefined;
      fetched = await this.#fetchCatalog(key.key, diagnostics);
    }
    if (fetched.status !== "ok") return undefined;

    let parsed = parseTokenhubModelCatalogEntries(fetched.body, {
      tokenhubUrl: this.#config.tokenhubUrl,
      apiKey: key.key,
      xcityUserId: this.#xcityUserId,
    });
    if (!parsed) {
      logger.warn("tokenhub model catalog response was malformed", {
        event: "xcity.tokenhub.models.malformed",
      });
      diagnostics.catalog = { ...diagnostics.catalog, error: "malformed-response" };
      return undefined;
    }
    let { models, sentinelCount } = parsed;
    // Nothing but grant sentinels came back: the key's grant was never expanded into real model
    // names, which is a provisioning failure and not an empty plan.
    let grantNotExpanded = sentinelCount > 0 && models.length === 0;
    if (grantNotExpanded) {
      logger.warn("tokenhub model catalog contained only litellm grant sentinels", {
        event: "xcity.tokenhub.models.grant-not-expanded",
      });
    }
    diagnostics.catalog = {
      ...diagnostics.catalog,
      modelCount: models.length,
      ...(grantNotExpanded ? { grantNotExpanded: true } : {}),
    };

    let cache = this.#storage.get();
    cache.catalog = {
      tokenhubUrl: this.#config.tokenhubUrl,
      keyMintedAt: key.mintedAt,
      fetchedAt: Date.now(),
      models,
      ...(grantNotExpanded ? { grantNotExpanded: true } : {}),
    };
    this.#storage.put(cache);
    return models;
  }

  // Fire-and-forget catalog revalidation for the stale-serve path. The User DO has no
  // ExecutionContext at hand here, so this is a detached promise chain; a failed refresh only
  // logs and leaves the cached catalog in place.
  #refreshInBackground(): void {
    let refreshKey = `${this.#config.tokenhubUrl}\n${this.#xcityUserId}`;
    if (inflightCatalogRefreshes.has(refreshKey)) return;
    let refresh = this.#refreshModels(newXcityProviderDiagnostics())
        .then(models => {
          if (models) this.#models = models;
        })
        .catch(error => {
          logger.warn("background tokenhub model catalog refresh failed", {
            event: "xcity.tokenhub.models.refresh.failed", error,
          });
        })
        .finally(() => {
          inflightCatalogRefreshes.delete(refreshKey);
        });
    inflightCatalogRefreshes.set(refreshKey, refresh);
  }

  async #ensureKey(forceMint: boolean, diagnostics: XcityProviderDiagnostics):
      Promise<XcityVirtualKeyRecord | undefined> {
    let cache = this.#storage.get();
    if (!forceMint && cache.key &&
        cache.key.walletUrl === this.#config.walletUrl &&
        cache.key.userId === this.#xcityUserId) {
      diagnostics.keyPresent = true;
      return cache.key;
    }

    let minted = await this.#mintKey(diagnostics);
    if (!minted) {
      diagnostics.keyPresent = false;
      return undefined;
    }
    diagnostics.keyPresent = true;

    cache = this.#storage.get();
    cache.key = minted;
    cache.catalog = undefined;
    this.#storage.put(cache);
    return minted;
  }

  async #mintKey(diagnostics: XcityProviderDiagnostics):
      Promise<XcityVirtualKeyRecord | undefined> {
    let response: Response;
    try {
      response = await fetchWithOneRetry(`${this.#config.walletUrl}/v1/keys/for-user`, () => ({
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#config.walletServiceToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          user_id: this.#xcityUserId,
          ...(this.#email ? { email: this.#email } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      }));
    } catch (error) {
      logger.warn("xcity wallet key mint request failed", {
        event: "xcity.wallet.key.mint.failed", error,
      });
      diagnostics.keyMint = { attempted: true, error: classifyFetchError(error) };
      return undefined;
    }

    if (!response.ok) {
      logger.warn("xcity wallet key mint request failed", {
        event: "xcity.wallet.key.mint.failed",
        status: response.status,
        statusText: response.statusText,
      });
      diagnostics.keyMint = { attempted: true, status: response.status };
      response.body?.cancel();
      return undefined;
    }
    diagnostics.keyMint = { attempted: true, status: response.status };

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      logger.warn("xcity wallet key mint response could not be read", {
        event: "xcity.wallet.key.mint.malformed", error,
      });
      diagnostics.keyMint = {
        attempted: true, status: response.status, error: "malformed-response",
      };
      return undefined;
    }

    let parsed = parseWalletKeyResponse(body);
    if (!parsed) {
      logger.warn("xcity wallet key mint response was malformed", {
        event: "xcity.wallet.key.mint.malformed",
      });
      diagnostics.keyMint = {
        attempted: true, status: response.status, error: "malformed-response",
      };
      return undefined;
    }

    return {
      userId: this.#xcityUserId,
      ...(this.#email ? { email: this.#email } : {}),
      walletUrl: this.#config.walletUrl,
      key: parsed.key,
      ...(parsed.keyToken ? { keyToken: parsed.keyToken } : {}),
      ...(parsed.walletId ? { walletId: parsed.walletId } : {}),
      ...(parsed.plan !== undefined ? { plan: parsed.plan } : {}),
      ...(parsed.minted !== undefined ? { minted: parsed.minted } : {}),
      mintedAt: Date.now(),
    };
  }

  async #fetchCatalog(apiKey: string, diagnostics: XcityProviderDiagnostics):
      Promise<CatalogFetchResult> {
    let response: Response;
    try {
      response = await fetchWithOneRetry(`${this.#config.tokenhubUrl}/v1/models`, () => ({
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      }));
    } catch (error) {
      logger.warn("tokenhub model catalog request failed", {
        event: "xcity.tokenhub.models.failed", error,
      });
      diagnostics.catalog = { error: classifyFetchError(error) };
      return { status: "failed" };
    }

    if (response.status === 401) {
      // Reported as-is; a successful re-mint retry overwrites this with its own outcome.
      diagnostics.catalog = { status: response.status };
      response.body?.cancel();
      return { status: "unauthorized" };
    }
    if (!response.ok) {
      logger.warn("tokenhub model catalog request failed", {
        event: "xcity.tokenhub.models.failed",
        status: response.status,
        statusText: response.statusText,
      });
      diagnostics.catalog = { status: response.status };
      response.body?.cancel();
      return { status: "failed" };
    }

    try {
      let body = await response.json();
      diagnostics.catalog = { status: response.status };
      return { status: "ok", body };
    } catch (error) {
      logger.warn("tokenhub model catalog response could not be read", {
        event: "xcity.tokenhub.models.malformed", error,
      });
      diagnostics.catalog = { status: response.status, error: "malformed-response" };
      return { status: "failed" };
    }
  }
}
