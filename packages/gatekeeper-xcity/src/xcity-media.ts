import type {
  GenerateImageOptions,
  GenerateVideoOptions,
  GeneratedMedia,
  MediaGenerationCost,
  XcityGeneratedMediaKind,
} from "./types";

type VideoRatio = NonNullable<GenerateVideoOptions["ratio"]>;
type VideoResolution = NonNullable<GenerateVideoOptions["resolution"]>;
type ImageSize = NonNullable<GenerateImageOptions["size"]>;

type EnvLike = {
  XCITY_TOKENHUB_URL?: string;
  XCITY_MEDIA_WORKER_URL?: string;
  XCITY_WALLET_URL?: string;
  WALLET_SERVICE_TOKEN?: string;
};

/** Complete configuration needed for Xcity media generation and permanent archival. */
export type XcityMediaConfig = {
  tokenhubUrl: string;
  mediaWorkerUrl: string;
  walletUrl: string;
  walletServiceToken: string;
};

/** The wallet-facing subset of the config, shared by every capability that mints per-user keys. */
export type XcityWalletConfig = { walletUrl: string; walletServiceToken: string };

export type XcityVirtualKeyRecord = {
  userId: string;
  email?: string;
  walletUrl: string;
  key: string;
  keyToken?: string;
  walletId?: string;
  plan?: unknown;
  minted?: boolean;
  mintedAt: number;
};

export type XcityTokenhubVideoJob = {
  id: string;
  object?: string;
  created_at?: number;
  status: "queued" | "in_progress" | "completed" | "failed";
  model?: string;
  progress?: number;
  seconds?: string | number;
  size?: string;
  output_url?: string;
  prompt?: string;
  error?: { message?: string; code?: string } | string;
  cost?: MediaGenerationCost;
  raw: unknown;
};

export type XcityTokenhubImage = {
  b64Json?: string;
  url?: string;
  revisedPrompt?: string;
};

export class XcityMediaApiError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly isAuthError: boolean;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "XcityMediaApiError";
    this.status = status;
    this.details = details;
    this.isAuthError = status === 401 || status === 403;
  }
}

const REQUEST_TIMEOUT_MS = 90_000;
const ARK_URL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const DEFAULT_VIDEO_MODEL = "seedance-1-5-pro-251215";
const DEFAULT_VIDEO_RATIO: VideoRatio = "16:9";
const DEFAULT_VIDEO_RESOLUTION: VideoResolution = "720p";
const DEFAULT_VIDEO_SECONDS = 5;
const DEFAULT_IMAGE_SIZE: ImageSize = "1024x1024";

const VIDEO_RATIOS = new Set<VideoRatio>(["16:9", "9:16", "1:1", "4:3", "21:9"]);
const VIDEO_RESOLUTIONS = new Set<VideoResolution>(["480p", "720p", "1080p", "4K"]);
const IMAGE_SIZES = new Set<ImageSize>(["1024x1024", "1280x720", "720x1280", "1152x864", "864x1152"]);

const SEEDANCE_MODELS = {
  "seedance-1-5-pro-251215": {
    minSeconds: 4,
    maxSeconds: 12,
    pricePerSecond: { "480p": 0.023, "720p": 0.052, "1080p": 0.117, "4K": null },
  },
  "dreamina-seedance-2-0-260128": {
    minSeconds: 4,
    maxSeconds: 12,
    pricePerSecond: { "480p": 0.067, "720p": 0.151, "1080p": 0.374, "4K": null },
  },
  "dreamina-seedance-2-0-fast-260128": {
    minSeconds: 4,
    maxSeconds: 12,
    pricePerSecond: { "480p": 0.054, "720p": 0.121, "1080p": null, "4K": null },
  },
  "dreamina-seedance-2-5-260628": {
    minSeconds: 4,
    maxSeconds: 30,
    pricePerSecond: { "480p": 0.067, "720p": 0.151, "1080p": 0.374, "4K": 0.748 },
    estimated: true,
  },
} as const;

const UPLOADABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) --end;
  return end === value.length ? value : value.slice(0, end);
}

export function envString<E extends Record<string, string | undefined>>(
  env: E, key: keyof E & string,
): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function assertPrompt(prompt: unknown): string {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("A non-empty prompt is required.");
  }
  const trimmed = prompt.trim();
  if (trimmed.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt is too long. Keep it under ${MAX_PROMPT_CHARS} characters.`);
  }
  return trimmed;
}

function assertHttpsUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${field} must be an HTTPS URL.`);
  }
  return parsed.toString();
}

function parseJsonCost(value: unknown): MediaGenerationCost | undefined {
  const parsedValue = typeof value === "string" && value.trim() ? Number(value) : value;
  const totalUsd = optionalFiniteNumber(parsedValue);
  if (totalUsd === undefined || totalUsd < 0) return undefined;
  return { totalUsd, currency: "USD", source: "tokenhub" };
}

function costFromPath(body: unknown, path: string[]): MediaGenerationCost | undefined {
  let cursor = body;
  for (const part of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return parseJsonCost(cursor);
}

function contentTypeFromUrl(url: string): string | undefined {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return undefined;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}

function errorMessage(status: number, statusText: string, parsed: unknown): string {
  if (typeof parsed === "string" && parsed.length > 0) return parsed;
  if (isRecord(parsed)) {
    const message = optionalString(parsed.message)
      ?? optionalString(parsed.error_description)
      ?? optionalString(parsed.error);
    if (message) return message;
  }
  return `${status} ${statusText}`;
}

function normalizeModelId(model: string): keyof typeof SEEDANCE_MODELS | undefined {
  const id = model.replace(/^byteplus\//, "");
  return id in SEEDANCE_MODELS ? (id as keyof typeof SEEDANCE_MODELS) : undefined;
}

function clampSeconds(value: number, model: string): number {
  const modelDef = SEEDANCE_MODELS[normalizeModelId(model) ?? DEFAULT_VIDEO_MODEL];
  if (!Number.isFinite(value)) return DEFAULT_VIDEO_SECONDS;
  return Math.min(modelDef.maxSeconds, Math.max(modelDef.minSeconds, Math.round(value)));
}

function requireOption<T extends string>(value: string, allowed: ReadonlySet<T>, field: string): T {
  if (!allowed.has(value as T)) {
    throw new Error(`${field} is unsupported: ${value}`);
  }
  return value as T;
}

function decodeBase64(value: string): Uint8Array {
  const base64 = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Returns complete media config, or null to hide media resources on unconfigured deployments. */
export function readXcityMediaConfig(env: EnvLike): XcityMediaConfig | null {
  const tokenhubUrl = envString(env, "XCITY_TOKENHUB_URL");
  const mediaWorkerUrl = envString(env, "XCITY_MEDIA_WORKER_URL");
  const walletUrl = envString(env, "XCITY_WALLET_URL");
  const walletServiceToken = envString(env, "WALLET_SERVICE_TOKEN");
  if (!tokenhubUrl || !mediaWorkerUrl || !walletUrl || !walletServiceToken) return null;
  return {
    tokenhubUrl: stripTrailingSlashes(tokenhubUrl),
    mediaWorkerUrl: stripTrailingSlashes(mediaWorkerUrl),
    walletUrl: stripTrailingSlashes(walletUrl),
    walletServiceToken,
  };
}

/** Canonical whole-service resource URL for the configured Xcity media surface. */
export function xcityMediaResourceUrl(config: Pick<XcityMediaConfig, "tokenhubUrl">): string {
  return `${config.tokenhubUrl}/media`;
}

export function parseWalletKeyResponse(
  body: unknown,
  context: { walletUrl: string; userId: string; email?: string; now?: number },
): XcityVirtualKeyRecord | undefined {
  if (!isRecord(body)) return undefined;
  const key = optionalString(body.key);
  if (!key) return undefined;
  const keyToken = optionalString(body.key_token);
  const walletId = optionalString(body.wallet_id);
  const minted = optionalBoolean(body.minted);
  return {
    userId: context.userId,
    ...(context.email ? { email: context.email } : {}),
    walletUrl: context.walletUrl,
    key,
    ...(keyToken ? { keyToken } : {}),
    ...(walletId ? { walletId } : {}),
    ...(body.plan !== undefined ? { plan: body.plan } : {}),
    ...(minted !== undefined ? { minted } : {}),
    mintedAt: context.now ?? Date.now(),
  };
}

export async function mintTokenhubKey(
  config: XcityWalletConfig,
  identity: { sub: string; email?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<XcityVirtualKeyRecord | undefined> {
  const response = await fetchImpl(`${config.walletUrl}/v1/keys/for-user`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.walletServiceToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      user_id: identity.sub,
      ...(identity.email ? { email: identity.email } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await parseBody(response);
  if (!response.ok) {
    throw new XcityMediaApiError(response.status, errorMessage(response.status, response.statusText, body), body);
  }
  return parseWalletKeyResponse(body, {
    walletUrl: config.walletUrl,
    userId: identity.sub,
    ...(identity.email ? { email: identity.email } : {}),
  });
}

export function normalizeVideoOptions(options: GenerateVideoOptions): Required<GenerateVideoOptions> {
  const model = options.model?.trim() || DEFAULT_VIDEO_MODEL;
  const ratio = requireOption(options.ratio ?? DEFAULT_VIDEO_RATIO, VIDEO_RATIOS, "ratio");
  const resolution = requireOption(
    options.resolution ?? DEFAULT_VIDEO_RESOLUTION,
    VIDEO_RESOLUTIONS,
    "resolution",
  );
  const inputReferenceUrl = options.inputReferenceUrl
    ? assertHttpsUrl(options.inputReferenceUrl, "inputReferenceUrl")
    : "";
  return {
    model,
    prompt: assertPrompt(options.prompt),
    ratio,
    resolution,
    seconds: clampSeconds(options.seconds ?? DEFAULT_VIDEO_SECONDS, model),
    generateAudio: options.generateAudio ?? true,
    inputReferenceUrl,
    cameraFixed: options.cameraFixed ?? false,
  };
}

export function normalizeImageOptions(options: GenerateImageOptions): Required<GenerateImageOptions> {
  if (typeof options.model !== "string" || !options.model.trim()) {
    throw new Error("An image model is required.");
  }
  const size = requireOption(options.size ?? DEFAULT_IMAGE_SIZE, IMAGE_SIZES, "size");
  return {
    model: options.model.trim(),
    prompt: assertPrompt(options.prompt),
    size,
  };
}

export function estimateSeedanceVideoCost(
  options: Pick<Required<GenerateVideoOptions>, "model" | "resolution" | "seconds">,
): MediaGenerationCost | undefined {
  const modelId = normalizeModelId(options.model);
  if (!modelId) return undefined;
  const model = SEEDANCE_MODELS[modelId];
  const pricePerSecond = model.pricePerSecond[options.resolution as keyof typeof model.pricePerSecond];
  if (pricePerSecond == null) return undefined;
  return {
    totalUsd: Math.round(options.seconds * pricePerSecond * 1000) / 1000,
    currency: "USD",
    source: "estimate",
    model: options.model,
    resolution: options.resolution,
    durationSeconds: options.seconds,
    pricePerSecond,
  };
}

export function extractTokenhubCost(...bodies: unknown[]): MediaGenerationCost | undefined {
  const paths = [
    ["response_cost"],
    ["total_cost"],
    ["cost"],
    ["usage", "cost"],
    ["usage", "total_cost"],
    ["usage", "totalCost"],
    ["_hidden_params", "response_cost"],
  ];
  for (const body of bodies) {
    for (const path of paths) {
      const cost = costFromPath(body, path);
      if (cost) return cost;
    }
  }
  return undefined;
}

export function videoCreateBody(options: Required<GenerateVideoOptions>): Record<string, unknown> {
  return {
    model: options.model,
    prompt: options.prompt,
    seconds: options.seconds,
    ratio: options.ratio,
    resolution: options.resolution,
    generate_audio: options.generateAudio,
    ...(options.inputReferenceUrl ? { input_reference: options.inputReferenceUrl } : {}),
    ...(options.cameraFixed !== undefined ? { camera_fixed: options.cameraFixed } : {}),
  };
}

export function imageCreateBody(options: Required<GenerateImageOptions>): Record<string, unknown> {
  return {
    model: options.model,
    prompt: options.prompt,
    n: 1,
    size: options.size,
  };
}

export async function tokenhubRequestJson<T>(
  config: Pick<XcityMediaConfig, "tokenhubUrl">,
  apiKey: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<{ body: T; raw: unknown }> {
  const response = await fetchImpl(`${config.tokenhubUrl}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await parseBody(response);
  if (!response.ok) {
    throw new XcityMediaApiError(response.status, errorMessage(response.status, response.statusText, raw), raw);
  }
  return { body: raw as T, raw };
}

export function parseVideoJob(body: unknown): XcityTokenhubVideoJob {
  if (!isRecord(body)) {
    throw new Error("TokenHub video response was not an object.");
  }
  const id = optionalString(body.id);
  const rawStatus = optionalString(body.status);
  if (!id || !rawStatus) {
    throw new Error("TokenHub video response was missing id or status.");
  }
  if (rawStatus !== "queued" && rawStatus !== "in_progress" &&
      rawStatus !== "completed" && rawStatus !== "failed") {
    throw new Error(`TokenHub video response had an unsupported status: ${rawStatus}`);
  }
  let error: XcityTokenhubVideoJob["error"];
  if (typeof body.error === "string") {
    error = body.error;
  } else if (isRecord(body.error)) {
    error = {
      message: optionalString(body.error.message),
      code: optionalString(body.error.code),
    };
  }
  return {
    id,
    object: optionalString(body.object),
    created_at: optionalFiniteNumber(body.created_at),
    status: rawStatus,
    model: optionalString(body.model),
    progress: optionalFiniteNumber(body.progress),
    seconds: optionalString(body.seconds) ?? optionalFiniteNumber(body.seconds),
    size: optionalString(body.size),
    output_url: optionalString(body.output_url),
    prompt: optionalString(body.prompt),
    ...(error !== undefined ? { error } : {}),
    ...(extractTokenhubCost(body) ? { cost: extractTokenhubCost(body) } : {}),
    raw: body,
  };
}

export async function createVideoJob(
  config: XcityMediaConfig,
  apiKey: string,
  options: Required<GenerateVideoOptions>,
  fetchImpl: typeof fetch = fetch,
): Promise<XcityTokenhubVideoJob> {
  const { raw } = await tokenhubRequestJson<unknown>(
    config,
    apiKey,
    "/videos",
    { method: "POST", body: JSON.stringify(videoCreateBody(options)) },
    fetchImpl,
  );
  return parseVideoJob(raw);
}

export async function retrieveVideoJob(
  config: XcityMediaConfig,
  apiKey: string,
  videoId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XcityTokenhubVideoJob> {
  const { raw } = await tokenhubRequestJson<unknown>(
    config,
    apiKey,
    `/videos/${encodeURIComponent(videoId)}`,
    { method: "GET" },
    fetchImpl,
  );
  return parseVideoJob(raw);
}

export async function createImage(
  config: XcityMediaConfig,
  apiKey: string,
  options: Required<GenerateImageOptions>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ image: XcityTokenhubImage; cost?: MediaGenerationCost; raw: unknown }> {
  const { raw } = await tokenhubRequestJson<unknown>(
    config,
    apiKey,
    "/images",
    { method: "POST", body: JSON.stringify(imageCreateBody(options)) },
    fetchImpl,
  );
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new Error("TokenHub image response was missing data.");
  }
  for (const item of raw.data) {
    if (!isRecord(item)) continue;
    const b64Json = optionalString(item.b64_json);
    const url = optionalString(item.url);
    if (b64Json || url) {
      return {
        image: {
          ...(b64Json ? { b64Json } : {}),
          ...(url ? { url } : {}),
          ...(optionalString(item.revised_prompt) ? { revisedPrompt: optionalString(item.revised_prompt) } : {}),
        },
        ...(extractTokenhubCost(raw) ? { cost: extractTokenhubCost(raw) } : {}),
        raw,
      };
    }
  }
  throw new Error("TokenHub image response did not contain an image.");
}

export async function archiveVideoToR2(
  config: XcityMediaConfig,
  apiKey: string,
  videoId: string,
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Pick<GeneratedMedia, "url" | "key" | "bytes" | "cached"> | null> {
  const response = await fetchImpl(`${config.mediaWorkerUrl}/archive`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ video_id: videoId, source_url: sourceUrl }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await parseBody(response);
  if (!response.ok) return null;
  if (!isRecord(raw)) return null;
  const url = optionalString(raw.url);
  const key = optionalString(raw.key);
  const bytes = optionalFiniteNumber(raw.bytes);
  if (!url || !key) return null;
  return {
    url,
    key,
    bytes: bytes ?? null,
    cached: raw.cached === true,
  };
}

export async function uploadImageToR2(
  config: XcityMediaConfig,
  apiKey: string,
  bytes: Uint8Array,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Pick<GeneratedMedia, "url" | "key" | "bytes" | "cached"> | null> {
  if (!UPLOADABLE_IMAGE_TYPES.has(contentType)) {
    throw new Error(`Unsupported generated image content type: ${contentType}`);
  }
  if (bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error(`Generated image is too large to archive (${bytes.byteLength} bytes).`);
  }
  const response = await fetchImpl(`${config.mediaWorkerUrl}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": contentType,
      Accept: "application/json",
    },
    body: bytes,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await parseBody(response);
  if (!response.ok) return null;
  if (!isRecord(raw)) return null;
  const url = optionalString(raw.url);
  const key = optionalString(raw.key);
  const storedBytes = optionalFiniteNumber(raw.bytes);
  if (!url || !key) return null;
  return {
    url,
    key,
    bytes: storedBytes ?? bytes.byteLength,
    cached: raw.cached === true,
  };
}

export async function fetchImageBytes(
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const url = assertHttpsUrl(sourceUrl, "image URL");
  const response = await fetchImpl(url, {
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    response.body?.cancel();
    return null;
  }
  const contentLengthHeader = response.headers.get("content-length");
  const declaredLength = contentLengthHeader === null
    ? undefined
    : optionalFiniteNumber(Number(contentLengthHeader));
  if (declaredLength !== undefined && declaredLength > MAX_IMAGE_UPLOAD_BYTES) {
    response.body?.cancel();
    return null;
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim()
    || contentTypeFromUrl(url)
    || "image/png";
  if (!UPLOADABLE_IMAGE_TYPES.has(contentType)) {
    response.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) return null;
  return { bytes, contentType };
}

export async function archiveVideoOrTemporary(
  config: XcityMediaConfig,
  apiKey: string,
  mediaId: string,
  sourceUrl: string,
  base: Omit<GeneratedMedia, "url" | "key" | "bytes" | "cached" | "archived" | "expiresAt" | "status" | "updatedAt">,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<GeneratedMedia> {
  let archived: Pick<GeneratedMedia, "url" | "key" | "bytes" | "cached"> | null = null;
  try {
    archived = await archiveVideoToR2(config, apiKey, mediaId, sourceUrl, fetchImpl);
  } catch {
    archived = null;
  }
  const updatedAt = new Date(now());
  if (archived) {
    return {
      ...base,
      status: "completed",
      archived: true,
      updatedAt,
      ...archived,
    };
  }
  return {
    ...base,
    status: "completed",
    archived: false,
    url: sourceUrl,
    expiresAt: new Date(now() + ARK_URL_TTL_MS),
    updatedAt,
  };
}

export async function archiveImageOrTemporary(
  config: XcityMediaConfig,
  apiKey: string,
  source: XcityTokenhubImage,
  base: Omit<GeneratedMedia, "url" | "key" | "bytes" | "cached" | "archived" | "expiresAt" | "status" | "updatedAt">,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<GeneratedMedia> {
  let imageBytes: { bytes: Uint8Array; contentType: string } | null = null;
  if (source.b64Json) {
    imageBytes = { bytes: decodeBase64(source.b64Json), contentType: "image/png" };
  } else if (source.url) {
    try {
      imageBytes = await fetchImageBytes(source.url, fetchImpl);
    } catch {
      imageBytes = null;
    }
  }
  const updatedAt = new Date(now());
  if (imageBytes) {
    let archived: Pick<GeneratedMedia, "url" | "key" | "bytes" | "cached"> | null = null;
    try {
      archived = await uploadImageToR2(config, apiKey, imageBytes.bytes, imageBytes.contentType, fetchImpl);
    } catch {
      archived = null;
    }
    if (archived) {
      return {
        ...base,
        status: "completed",
        archived: true,
        updatedAt,
        ...archived,
      };
    }
  }
  if (!source.url) {
    throw new Error("Generated image could not be archived and had no provider URL fallback.");
  }
  return {
    ...base,
    status: "completed",
    archived: false,
    url: source.url,
    expiresAt: new Date(now() + ARK_URL_TTL_MS),
    updatedAt,
  };
}

export function pendingGeneratedMedia(
  kind: XcityGeneratedMediaKind,
  id: string,
  cost: MediaGenerationCost | undefined,
  now: () => number = Date.now,
): GeneratedMedia {
  return {
    id,
    kind,
    status: "pending",
    archived: false,
    ...(cost ? { cost } : {}),
    createdAt: new Date(now()),
    updatedAt: new Date(now()),
  };
}
