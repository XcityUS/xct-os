/**
 * Xcity media generation API for Gadgets.
 *
 * A connection represents the connected user's Xcity media account. Paid generation requests first
 * return a media id. Call `getGeneration(id)` until it returns a completed result with either an
 * archived R2 URL or an explicitly temporary provider URL with `expiresAt`, or a failed result.
 */

/** Supported media output kinds. */
export type XcityGeneratedMediaKind = "video" | "image";

/** Best-effort cost information in USD. */
export type MediaGenerationCost = {
  /** Total cost of this generation in US dollars. */
  totalUsd: number;
  /** Currency for `totalUsd`. */
  currency: "USD";
  /** Whether the value came from TokenHub or from a local price table. */
  source: "tokenhub" | "estimate";
  /** Model id used for the generation, when known. */
  model?: string;
  /** Video resolution, when the cost depends on it. */
  resolution?: string;
  /** Video duration, when the cost depends on it. */
  durationSeconds?: number;
  /** Price per generated second for video estimates. */
  pricePerSecond?: number;
};

/** Options for generating a Seedance video. */
export type GenerateVideoOptions = {
  /** Production prompt describing the video to generate. */
  prompt: string;
  /** Seedance model id. Defaults to `seedance-1-5-pro-251215`. */
  model?: string;
  /** Aspect ratio. Defaults to `16:9`. */
  ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "21:9";
  /** Output resolution. Defaults to `720p`. */
  resolution?: "480p" | "720p" | "1080p" | "4K";
  /** Clip duration in seconds. Values are clamped to the selected model's supported range. */
  seconds?: number;
  /** Whether to ask the model to generate audio. Defaults to true. */
  generateAudio?: boolean;
  /** Public HTTPS reference image URL for image-to-video. */
  inputReferenceUrl?: string;
  /** Whether to lock the camera in place, when supported by the selected model. */
  cameraFixed?: boolean;
};

/** Options for generating a Seedream image. */
export type GenerateImageOptions = {
  /** Prompt describing the image to generate. */
  prompt: string;
  /** Seedream model id exposed by the deployment's TokenHub image endpoint. */
  model: string;
  /** Output size. Defaults to `1024x1024`. */
  size?: "1024x1024" | "1280x720" | "720x1280" | "1152x864" | "864x1152";
};

/** Current status and output metadata for a generated media item. */
export type GeneratedMedia = {
  /** Stable id returned by `generateVideo()` or `generateImage()`. */
  id: string;
  /** Whether this is a video or image generation. */
  kind: XcityGeneratedMediaKind;
  /** Generation lifecycle state. */
  status: "pending" | "processing" | "completed" | "failed";
  /**
   * True when `url` is a permanent R2 URL. If false on a completed result, `expiresAt` is set and
   * the URL is only a temporary provider URL.
   */
  archived: boolean;
  /** Permanent R2 URL when `archived` is true; temporary provider URL when `expiresAt` is set. */
  url?: string;
  /** R2 object key when `archived` is true. */
  key?: string;
  /** Stored byte count when the media worker reported it. */
  bytes?: number | null;
  /** Whether R2 already contained the archived object. */
  cached?: boolean;
  /** Expiration time for a temporary provider URL when archival failed. */
  expiresAt?: Date;
  /** TokenHub video job id, for videos after the provider job has started. */
  providerJobId?: string;
  /** Provider progress percentage for an in-flight video. */
  progress?: number;
  /** Best-effort cost for this generation. */
  cost?: MediaGenerationCost;
  /** Failure detail when `status` is `failed`. */
  error?: string;
  /** Time this media request was created. */
  createdAt: Date;
  /** Time this status was last updated. */
  updatedAt: Date;
};

/** Xcity media generation session. */
export interface XcityMedia {
  /**
   * Requests a Seedance video generation and returns a media id immediately. Use `getGeneration()`
   * with the returned id to read progress and the final archived URL or temporary fallback.
   */
  generateVideo(options: GenerateVideoOptions): Promise<GeneratedMedia>;

  /**
   * Requests one Seedream image generation and returns a media id immediately. Use
   * `getGeneration()` with the returned id to read the final archived URL or temporary fallback.
   */
  generateImage(options: GenerateImageOptions): Promise<GeneratedMedia>;

  /** Reads the current status or final output for a media id returned by a generate method. */
  getGeneration(id: string): Promise<GeneratedMedia>;
}
