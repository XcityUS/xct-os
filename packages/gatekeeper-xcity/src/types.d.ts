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

/**
 * Xcity shared context store API for Gadgets.
 *
 * A connection represents the connected user's slice of the cross-product Xcity context store:
 * documents shared by all Xcity products under the same account. Reads return live data. Writes
 * (save/update/delete) are staged for user approval and return a pending `XcityContextWrite`
 * receipt; call `getWrite(id)` after approval to see the outcome and the created document's id.
 */

/** The kind of a staged context-store write. */
export type XcityContextWriteKind = "create" | "update" | "delete";

/** One document in the user's Xcity context store, as listed. Content is previewed only. */
export type XcityContextDocumentSummary = {
  /** Stable document id. Pass to getDocument(), updateDocument(), or deleteDocument(). */
  contextId: string;
  /** Document title. */
  title: string;
  /** Leading excerpt of the content. Call getDocument() for the full content. */
  contentPreview: string;
  /** Labels attached to the document, when any. */
  tags?: string[];
  /** Whether the document is shared beyond its owner. */
  isPublic: boolean;
  /** Creation time, when the store reported one. */
  createdAt?: Date;
  /** Last update time, when the store reported one. */
  updatedAt?: Date;
};

/** Full document returned by getDocument(). Content is at most 256 KB of UTF-8 text. */
export type XcityContextDocument = XcityContextDocumentSummary & {
  /** Complete document content. */
  content: string;
};

/** One page of context documents. */
export type XcityContextDocumentList = {
  /** Documents on this page, newest first. */
  documents: XcityContextDocumentSummary[];
  /** True when more documents exist beyond this page. */
  hasMore: boolean;
  /** Opaque cursor for the next page; pass as `listDocuments({ cursor })`. */
  nextCursor?: string;
};

/** Options for listDocuments(). */
export type ListContextDocumentsOptions = {
  /** Maximum documents per page, 1-100. Defaults to 50. */
  limit?: number;
  /** Cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Text query to filter documents. */
  query?: string;
};

/** Options for saveDocument(). */
export type SaveContextDocumentOptions = {
  /** Document title. Required and non-empty. */
  title: string;
  /** Document content; at most 256 KB of UTF-8 text. */
  content: string;
  /** Labels to attach to the document. */
  tags?: string[];
  /** Whether the document should be shared beyond its owner. Defaults to false. */
  isPublic?: boolean;
};

/** Options for updateDocument(). At least one field must be present. */
export type UpdateContextDocumentOptions = {
  title?: string;
  /** Replacement content; at most 256 KB of UTF-8 text. */
  content?: string;
  tags?: string[];
  isPublic?: boolean;
};

/** Status receipt for a staged context-store write. */
export type XcityContextWrite = {
  /** Stable id returned by saveDocument(), updateDocument(), or deleteDocument(). */
  id: string;
  /** What this write does. */
  kind: XcityContextWriteKind;
  /** Write lifecycle state. `pending` until the user approves and the write applies. */
  status: "pending" | "completed" | "failed";
  /** The target document id; for creates, set once the write has completed. */
  contextId?: string;
  /** The stored document after a completed create or update, when the store returned it. */
  document?: XcityContextDocument;
  /** Failure detail when `status` is `failed`. */
  error?: string;
  /** Time this write was requested. */
  createdAt: Date;
  /** Time this status was last updated. */
  updatedAt: Date;
};

/** Xcity shared context store session. */
export interface XcityContext {
  /** Lists the user's context documents (title, preview, tags), cursor-paged, 50 per page by default. */
  listDocuments(options?: ListContextDocumentsOptions): Promise<XcityContextDocumentList>;

  /** Reads one document, including its full content, by an id from listDocuments(). */
  getDocument(contextId: string): Promise<XcityContextDocument>;

  /**
   * Stages creation of a new document and returns a pending write receipt immediately. After the
   * user approves, call `getWrite()` with the receipt id to get the created document's contextId.
   */
  saveDocument(options: SaveContextDocumentOptions): Promise<XcityContextWrite>;

  /** Stages a partial update of an existing document. Track the outcome via `getWrite()`. */
  updateDocument(contextId: string, options: UpdateContextDocumentOptions): Promise<XcityContextWrite>;

  /** Stages deletion of a document. Track the outcome via `getWrite()`. */
  deleteDocument(contextId: string): Promise<XcityContextWrite>;

  /** Reads the current status or final outcome for a write receipt id. */
  getWrite(id: string): Promise<XcityContextWrite>;
}

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
