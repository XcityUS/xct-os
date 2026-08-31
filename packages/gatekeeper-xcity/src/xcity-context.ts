// Xcity shared context store ("xct-context") client helpers. Mirrors xcity-media.ts: pure
// functions over a config object plus an injectable fetch, so the DO in xcity.ts stays thin and
// everything here is unit-testable without Durable Objects.

import type {
  ListContextDocumentsOptions,
  SaveContextDocumentOptions,
  UpdateContextDocumentOptions,
  XcityContextDocument,
  XcityContextDocumentList,
  XcityContextDocumentSummary,
  XcityContextWrite,
  XcityContextWriteKind,
} from "./types";
import {
  envString,
  isRecord,
  optionalBoolean,
  optionalString,
  stripTrailingSlashes,
  tokenhubRequestJson,
  XcityMediaApiError,
} from "./xcity-media";

type EnvLike = {
  XCITY_TOKENHUB_URL?: string;
  XCITY_WALLET_URL?: string;
  WALLET_SERVICE_TOKEN?: string;
};

/**
 * Complete configuration needed for the Xcity context store. Unlike media, it has no archival
 * worker: the wallet settings are only needed to mint the user's TokenHub virtual key.
 */
export type XcityContextConfig = {
  tokenhubUrl: string;
  walletUrl: string;
  walletServiceToken: string;
};

/** Documents are capped at 256 KB of UTF-8 content by tokenhub; enforced client-side too. */
export const MAX_CONTEXT_CONTENT_BYTES = 256 * 1024;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_TITLE_CHARS = 512;
const MAX_TAG_CHARS = 100;
const MAX_TAGS = 32;

/** Returns complete context config, or null to hide the resource on unconfigured deployments. */
export function readXcityContextConfig(env: EnvLike): XcityContextConfig | null {
  const tokenhubUrl = envString(env, "XCITY_TOKENHUB_URL");
  const walletUrl = envString(env, "XCITY_WALLET_URL");
  const walletServiceToken = envString(env, "WALLET_SERVICE_TOKEN");
  if (!tokenhubUrl || !walletUrl || !walletServiceToken) return null;
  return {
    tokenhubUrl: stripTrailingSlashes(tokenhubUrl),
    walletUrl: stripTrailingSlashes(walletUrl),
    walletServiceToken,
  };
}

/** Canonical whole-service resource URL for the configured Xcity context surface. */
export function xcityContextResourceUrl(config: Pick<XcityContextConfig, "tokenhubUrl">): string {
  return `${config.tokenhubUrl}/xct-context`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertContextId(contextId: unknown): string {
  if (typeof contextId !== "string" || !contextId.trim()) {
    throw new Error("A non-empty context document id is required.");
  }
  return contextId.trim();
}

function assertTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("A non-empty document title is required.");
  }
  const trimmed = title.trim();
  if (trimmed.length > MAX_TITLE_CHARS) {
    throw new Error(`Document title is too long. Keep it under ${MAX_TITLE_CHARS} characters.`);
  }
  return trimmed;
}

function assertContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new Error("Document content must be a string.");
  }
  const bytes = utf8ByteLength(content);
  if (bytes > MAX_CONTEXT_CONTENT_BYTES) {
    throw new Error(
      `Document content is too large (${bytes} bytes). Xcity context documents are limited to ` +
      `${MAX_CONTEXT_CONTENT_BYTES} bytes (256 KB) of UTF-8 text.`);
  }
  return content;
}

function assertTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    throw new Error("Document tags must be an array of strings.");
  }
  if (tags.length > MAX_TAGS) {
    throw new Error(`Too many tags. Keep it to at most ${MAX_TAGS}.`);
  }
  return tags.map(tag => {
    if (typeof tag !== "string" || !tag.trim()) {
      throw new Error("Each tag must be a non-empty string.");
    }
    const trimmed = tag.trim();
    if (trimmed.length > MAX_TAG_CHARS) {
      throw new Error(`Tag is too long: ${trimmed.slice(0, 40)}...`);
    }
    return trimmed;
  });
}

export function normalizeListContextOptions(
  options?: ListContextDocumentsOptions,
): Required<Pick<ListContextDocumentsOptions, "limit">> & ListContextDocumentsOptions {
  const limit = options?.limit === undefined
    ? DEFAULT_LIST_LIMIT
    : Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(options.limit)));
  if (!Number.isFinite(limit)) {
    throw new Error("limit must be a finite number.");
  }
  const cursor = options?.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor)) {
    throw new Error("cursor must be a non-empty string from a previous page's nextCursor.");
  }
  const query = options?.query;
  if (query !== undefined && typeof query !== "string") {
    throw new Error("query must be a string.");
  }
  return {
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(query !== undefined && query.trim() ? { query: query.trim() } : {}),
  };
}

export function normalizeSaveContextOptions(
  options: SaveContextDocumentOptions,
): SaveContextDocumentOptions {
  return {
    title: assertTitle(options.title),
    content: assertContent(options.content),
    ...(options.tags !== undefined ? { tags: assertTags(options.tags) } : {}),
    ...(options.isPublic !== undefined ? { isPublic: options.isPublic === true } : {}),
  };
}

export function normalizeUpdateContextOptions(
  options: UpdateContextDocumentOptions,
): UpdateContextDocumentOptions {
  const normalized: UpdateContextDocumentOptions = {
    ...(options.title !== undefined ? { title: assertTitle(options.title) } : {}),
    ...(options.content !== undefined ? { content: assertContent(options.content) } : {}),
    ...(options.tags !== undefined ? { tags: assertTags(options.tags) } : {}),
    ...(options.isPublic !== undefined ? { isPublic: options.isPublic === true } : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new Error(
      "An update must change at least one of title, content, tags, or isPublic.");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function optionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
  return tags.length > 0 ? tags : undefined;
}

export function parseContextDocumentSummary(body: unknown): XcityContextDocumentSummary {
  if (!isRecord(body)) {
    throw new Error("TokenHub context response row was not an object.");
  }
  const contextId = optionalString(body.context_id) ?? optionalString(body.id);
  const title = optionalString(body.title);
  if (!contextId || !title) {
    throw new Error("TokenHub context response row was missing context_id or title.");
  }
  const tags = parseTags(body.tags);
  const createdAt = optionalDate(body.created_at);
  const updatedAt = optionalDate(body.updated_at);
  return {
    contextId,
    title,
    contentPreview: optionalString(body.content_preview) ?? "",
    ...(tags ? { tags } : {}),
    isPublic: optionalBoolean(body.is_public) ?? false,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** Accepts both a bare document object and the `{data: {...}}` envelope tokenhub responds with. */
export function parseContextDocument(body: unknown): XcityContextDocument {
  const record = isRecord(body) && isRecord(body.data) ? body.data : body;
  const summary = parseContextDocumentSummary(record);
  const content = isRecord(record) ? optionalString(record.content) : undefined;
  return {
    ...summary,
    content: content ?? summary.contentPreview,
  };
}

export function parseContextDocumentList(body: unknown): XcityContextDocumentList {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("TokenHub context list response was missing data.");
  }
  const nextCursor = optionalString(body.next_cursor);
  return {
    documents: body.data.map(parseContextDocumentSummary),
    hasMore: body.has_more === true,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Performs one authenticated context-store request, mapping upstream failures to messages agents
 * can act on. 401 is rethrown untouched so `withContextKeyRetry` can re-mint the key and retry.
 */
async function contextRequest<T>(
  config: XcityContextConfig,
  apiKey: string,
  path: string,
  init: RequestInit,
  subject: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  try {
    const { body } = await tokenhubRequestJson<T>(config, apiKey, path, init, fetchImpl);
    return body;
  } catch (error) {
    if (error instanceof XcityMediaApiError) {
      if (error.status === 401) throw error;
      if (error.status === 404) {
        throw new Error(`${subject} was not found in the Xcity context store.`, { cause: error });
      }
      if (error.status === 403) {
        throw new Error(`${subject} is not accessible from this Xcity account.`, { cause: error });
      }
      throw new Error(`Xcity context store request failed: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export async function listContextDocuments(
  config: XcityContextConfig,
  apiKey: string,
  options?: ListContextDocumentsOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<XcityContextDocumentList> {
  const normalized = normalizeListContextOptions(options);
  const params = new URLSearchParams({ limit: String(normalized.limit) });
  if (normalized.cursor) params.set("cursor", normalized.cursor);
  if (normalized.query) params.set("q", normalized.query);
  const body = await contextRequest<unknown>(
    config, apiKey, `/xct-context?${params}`, { method: "GET" },
    "The requested context document listing", fetchImpl);
  return parseContextDocumentList(body);
}

export async function getContextDocument(
  config: XcityContextConfig,
  apiKey: string,
  contextId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XcityContextDocument> {
  const id = assertContextId(contextId);
  const body = await contextRequest<unknown>(
    config, apiKey, `/xct-context/${encodeURIComponent(id)}`, { method: "GET" },
    `Context document ${id}`, fetchImpl);
  return parseContextDocument(body);
}

function createOrUpdateBody(options: UpdateContextDocumentOptions): Record<string, unknown> {
  return {
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.content !== undefined ? { content: options.content } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
    ...(options.isPublic !== undefined ? { is_public: options.isPublic } : {}),
  };
}

export async function createContextDocument(
  config: XcityContextConfig,
  apiKey: string,
  options: SaveContextDocumentOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<XcityContextDocument> {
  const normalized = normalizeSaveContextOptions(options);
  const body = await contextRequest<unknown>(
    config, apiKey, "/xct-context",
    { method: "POST", body: JSON.stringify(createOrUpdateBody(normalized)) },
    "The Xcity context store", fetchImpl);
  return parseContextDocument(body);
}

export async function updateContextDocument(
  config: XcityContextConfig,
  apiKey: string,
  contextId: string,
  options: UpdateContextDocumentOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<XcityContextDocument | null> {
  const id = assertContextId(contextId);
  const normalized = normalizeUpdateContextOptions(options);
  const body = await contextRequest<unknown>(
    config, apiKey, `/xct-context/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(createOrUpdateBody(normalized)) },
    `Context document ${id}`, fetchImpl);
  try {
    return parseContextDocument(body);
  } catch {
    // A PATCH response without a recognizable document body is still a successful update.
    return null;
  }
}

export async function deleteContextDocument(
  config: XcityContextConfig,
  apiKey: string,
  contextId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const id = assertContextId(contextId);
  await contextRequest<unknown>(
    config, apiKey, `/xct-context/${encodeURIComponent(id)}`, { method: "DELETE" },
    `Context document ${id}`, fetchImpl);
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/**
 * Runs `fn` with the user's TokenHub key, re-minting the key and retrying exactly once when
 * tokenhub answers 401 (stale/revoked key). 403 deliberately does NOT re-mint: for the context
 * store it means "this document is not yours", which a fresh key cannot fix.
 */
export async function withContextKeyRetry<T>(
  getKey: (forceMint: boolean) => Promise<string>,
  fn: (apiKey: string) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await getKey(false));
  } catch (error) {
    if (!(error instanceof XcityMediaApiError) || error.status !== 401) throw error;
  }
  try {
    return await fn(await getKey(true));
  } catch (error) {
    if (error instanceof XcityMediaApiError && error.status === 401) {
      throw new Error(
        "Xcity rejected this account's TokenHub credentials. Reconnect Xcity and retry.",
        { cause: error });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Write receipts
// ---------------------------------------------------------------------------

export function pendingContextWrite(
  kind: XcityContextWriteKind,
  id: string,
  contextId: string | undefined,
  now: () => number = Date.now,
): XcityContextWrite {
  return {
    id,
    kind,
    status: "pending",
    ...(contextId ? { contextId } : {}),
    createdAt: new Date(now()),
    updatedAt: new Date(now()),
  };
}
