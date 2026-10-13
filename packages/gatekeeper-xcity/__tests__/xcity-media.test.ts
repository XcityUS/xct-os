import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMediaAction,
  archiveImageOrTemporary,
  archiveVideoOrTemporary,
  createImage,
  createVideoJob,
  estimateSeedanceVideoCost,
  extractTokenhubCost,
  mintTokenhubKey,
  readXcityMediaConfig,
  resolveMediaWorkerTransport,
  retrieveVideoJob,
  type MediaWorkerBinding,
  type MediaWorkerTransport,
  type StoredGenerateAction,
  type XcityMediaConfig,
} from "../src/xcity-media";
import type { GeneratedMedia } from "../src/types";

const CONFIG: XcityMediaConfig = {
  tokenhubUrl: "https://tokenhub.xcity.ai",
  mediaWorkerUrl: "https://media.xcity.ai",
  walletUrl: "https://wallet.xcity.ai",
  walletServiceToken: "service-token",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readXcityMediaConfig", () => {
  it("returns null when any media-plane setting is missing", () => {
    expect(readXcityMediaConfig({})).toBeNull();
    expect(readXcityMediaConfig({
      XCITY_TOKENHUB_URL: "https://tokenhub.xcity.ai",
      XCITY_MEDIA_WORKER_URL: "https://media.xcity.ai",
      XCITY_WALLET_URL: "https://wallet.xcity.ai",
    })).toBeNull();
  });

  it("returns normalized config when generation and archival are configured", () => {
    expect(readXcityMediaConfig({
      XCITY_TOKENHUB_URL: "https://tokenhub.xcity.ai/",
      XCITY_MEDIA_WORKER_URL: "https://media.xcity.ai/",
      XCITY_WALLET_URL: "https://wallet.xcity.ai/",
      WALLET_SERVICE_TOKEN: " service-token ",
    })).toEqual(CONFIG);
  });
});

describe("archiveVideoOrTemporary", () => {
  it("returns the permanent R2 URL when archive succeeds", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ url: "https://media.xcity.ai/media/u/1/video_1.mp4", key: "u/1/video_1.mp4", bytes: 1234, cached: false });

    await expect(archiveVideoOrTemporary(
      CONFIG,
      "key",
      "video_1",
      "https://ark.volces.com/tmp.mp4",
      { id: "video_1", kind: "video", createdAt: new Date(0) },
      fetchImpl as typeof fetch,
      () => 1000,
    )).resolves.toMatchObject({
      status: "completed",
      archived: true,
      url: "https://media.xcity.ai/media/u/1/video_1.mp4",
      key: "u/1/video_1.mp4",
      bytes: 1234,
    });
  });

  it("marks provider URLs as temporary when archive fails", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ error: "source fetch failed" }, 502);

    const result = await archiveVideoOrTemporary(
      CONFIG,
      "key",
      "video_1",
      "https://ark.volces.com/tmp.mp4",
      { id: "video_1", kind: "video", createdAt: new Date(0) },
      fetchImpl as typeof fetch,
      () => 1000,
    );

    expect(result).toMatchObject({
      status: "completed",
      archived: false,
      url: "https://ark.volces.com/tmp.mp4",
    });
    expect(result.expiresAt?.getTime()).toBe(24 * 60 * 60 * 1000 + 1000);
  });
});

describe("archiveImageOrTemporary", () => {
  it("uploads generated image bytes to R2", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://media.xcity.ai/upload");
      expect(init?.headers).toMatchObject({ "Content-Type": "image/png" });
      return json({ url: "https://media.xcity.ai/media/u/1/img.png", key: "u/1/img.png", bytes: 3, cached: true });
    };

    await expect(archiveImageOrTemporary(
      CONFIG,
      "key",
      { b64Json: "AQID" },
      { id: "image_1", kind: "image", createdAt: new Date(0) },
      fetchImpl as typeof fetch,
      () => 1000,
    )).resolves.toMatchObject({
      status: "completed",
      archived: true,
      url: "https://media.xcity.ai/media/u/1/img.png",
      key: "u/1/img.png",
      bytes: 3,
      cached: true,
    });
  });

  it("keeps URL image results temporary when bytes cannot be archived", async () => {
    const fetchImpl = async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "https://provider.example/image.png") {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "image/png" },
        });
      }
      return json({ error: "invalid key" }, 403);
    };

    const result = await archiveImageOrTemporary(
      CONFIG,
      "key",
      { url: "https://provider.example/image.png" },
      { id: "image_1", kind: "image", createdAt: new Date(0) },
      fetchImpl as typeof fetch,
      () => 1000,
    );

    expect(result.archived).toBe(false);
    expect(result.url).toBe("https://provider.example/image.png");
    expect(result.expiresAt?.getTime()).toBe(24 * 60 * 60 * 1000 + 1000);
  });
});

type SeenRequest = { url: string; init?: RequestInit };
type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

const PROVIDER_IMAGE_URL = "https://provider.example/image.png";
const VIDEO_BASE = { id: "video_1", kind: "video" as const, createdAt: new Date(0) };
const IMAGE_BASE = { id: "image_1", kind: "image" as const, createdAt: new Date(0) };

/** Replaces the global fetch for one test, recording every call. */
function stubGlobalFetch(respond: Responder): SeenRequest[] {
  const seen: SeenRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return await respond(String(input), init);
  });
  return seen;
}

/** A fake `XCITY_MEDIA` service binding, recording every call. */
function fakeBinding(respond: Responder): { binding: MediaWorkerBinding; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const binding = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return await respond(String(input), init);
    },
  } as MediaWorkerBinding;
  return { binding, seen };
}

function archived(url: string, key: string, bytes: number): Response {
  return json({ url, key, bytes, cached: false });
}

function providerImage(): Response {
  return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
}

/** A request minus its per-call AbortSignal, for comparing two transports' requests. */
function comparable({ url, init }: SeenRequest) {
  const { signal, ...rest } = init ?? {};
  expect(signal).toBeInstanceOf(AbortSignal);
  return { url, init: rest };
}

const archiveSuccess: Responder = url => url.endsWith("/archive")
  ? archived("https://media.xcity.ai/media/u/1/video_1.mp4", "u/1/video_1.mp4", 1234)
  : archived("https://media.xcity.ai/media/u/1/img.png", "u/1/img.png", 3);

/** Archives one video and one inline image over `mediaWorker` (or the default transport). */
async function archiveVideoThenImage(mediaWorker?: MediaWorkerTransport): Promise<void> {
  await archiveVideoOrTemporary(
    CONFIG, "key", "video_1", "https://ark.volces.com/tmp.mp4", VIDEO_BASE,
    undefined, () => 1000, mediaWorker,
  );
  await archiveImageOrTemporary(
    CONFIG, "key", { b64Json: "AQID" }, IMAGE_BASE, undefined, () => 1000, mediaWorker,
  );
}

describe("xcity-media Worker transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prefers the XCITY_MEDIA service binding and falls back to fetch without it", () => {
    expect(resolveMediaWorkerTransport({ XCITY_MEDIA: fakeBinding(() => json({})).binding }).kind)
      .toBe("service-binding");
    expect(resolveMediaWorkerTransport({}).kind).toBe("fetch");
  });

  it("archives video through the binding with the public URL, host and headers unchanged", async () => {
    const globalCalls = stubGlobalFetch(() => { throw new Error("global fetch must not be used"); });
    const { binding, seen } = fakeBinding(() =>
      archived("https://media.xcity.ai/media/u/1/video_1.mp4", "u/1/video_1.mp4", 1234));

    const result = await archiveVideoOrTemporary(
      CONFIG, "key", "video_1", "https://ark.volces.com/tmp.mp4", VIDEO_BASE,
      undefined, () => 1000, resolveMediaWorkerTransport({ XCITY_MEDIA: binding }),
    );

    expect(result).toMatchObject({ archived: true, url: "https://media.xcity.ai/media/u/1/video_1.mp4" });
    expect(globalCalls).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).host).toBe("media.xcity.ai");
    expect(comparable(seen[0])).toEqual({
      url: "https://media.xcity.ai/archive",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer key",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ video_id: "video_1", source_url: "https://ark.volces.com/tmp.mp4" }),
      },
    });
  });

  it("uploads image bytes through the binding while the provider image stays on global fetch", async () => {
    const globalCalls = stubGlobalFetch(url => {
      if (url === PROVIDER_IMAGE_URL) return providerImage();
      throw new Error(`unexpected global fetch to ${url}`);
    });
    const { binding, seen } = fakeBinding(() =>
      archived("https://media.xcity.ai/media/u/1/img.png", "u/1/img.png", 3));

    const result = await archiveImageOrTemporary(
      CONFIG, "key", { url: PROVIDER_IMAGE_URL }, IMAGE_BASE,
      undefined, () => 1000, resolveMediaWorkerTransport({ XCITY_MEDIA: binding }),
    );

    expect(result).toMatchObject({ archived: true, url: "https://media.xcity.ai/media/u/1/img.png", bytes: 3 });
    expect(globalCalls.map(r => r.url)).toEqual([PROVIDER_IMAGE_URL]);
    expect(globalCalls.some(r => r.url.startsWith(CONFIG.mediaWorkerUrl))).toBe(false);
    expect(seen).toHaveLength(1);
    expect(comparable(seen[0])).toEqual({
      url: "https://media.xcity.ai/upload",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer key",
          "Content-Type": "image/png",
          Accept: "application/json",
        },
        body: new Uint8Array([1, 2, 3]),
      },
    });
  });

  it("sends the same requests over global fetch when the binding is absent", async () => {
    // No transport argument at all: the pre-binding call shape.
    const legacy = stubGlobalFetch(archiveSuccess);
    await archiveVideoThenImage();
    // A transport resolved from an env without XCITY_MEDIA.
    const unbound = stubGlobalFetch(archiveSuccess);
    await archiveVideoThenImage(resolveMediaWorkerTransport({}));
    // The binding, for comparison: it must see exactly what the public-URL fetch sent.
    stubGlobalFetch(() => { throw new Error("global fetch must not be used"); });
    const { binding, seen: bound } = fakeBinding(archiveSuccess);
    await archiveVideoThenImage(resolveMediaWorkerTransport({ XCITY_MEDIA: binding }));

    expect(legacy.map(r => r.url)).toEqual(["https://media.xcity.ai/archive", "https://media.xcity.ai/upload"]);
    expect(unbound.map(comparable)).toEqual(legacy.map(comparable));
    expect(bound.map(comparable)).toEqual(legacy.map(comparable));
  });

  it("falls back to the provider URL and logs the transport when the binding rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const globalCalls = stubGlobalFetch(url => {
      if (url === PROVIDER_IMAGE_URL) return providerImage();
      throw new Error(`unexpected global fetch to ${url}`);
    });
    const { binding } = fakeBinding(() => {
      throw new Error("Subrequest depth limit exceeded.");
    });
    const mediaWorker = resolveMediaWorkerTransport({ XCITY_MEDIA: binding });

    const image = await archiveImageOrTemporary(
      CONFIG, "key", { url: PROVIDER_IMAGE_URL }, IMAGE_BASE, undefined, () => 1000, mediaWorker,
    );
    const video = await archiveVideoOrTemporary(
      CONFIG, "key", "video_1", "https://ark.volces.com/tmp.mp4", VIDEO_BASE,
      undefined, () => 1000, mediaWorker,
    );

    expect(image).toMatchObject({ archived: false, url: PROVIDER_IMAGE_URL });
    expect(image.expiresAt?.getTime()).toBe(24 * 60 * 60 * 1000 + 1000);
    expect(video).toMatchObject({ archived: false, url: "https://ark.volces.com/tmp.mp4" });
    expect(globalCalls.map(r => r.url)).toEqual([PROVIDER_IMAGE_URL]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "xcity.media_worker.request.failed",
      path: "/upload",
      transport: "service-binding",
      error: expect.stringContaining("Subrequest depth limit exceeded"),
    }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "xcity.media_worker.request.failed",
      path: "/archive",
      transport: "service-binding",
    }));
    // The API key travels in the Authorization header and must never reach the logs.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Bearer");
  });

  it("logs a non-2xx media Worker response with the fetch transport", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubGlobalFetch(() => json({ error: "invalid key" }, 403));

    const result = await archiveImageOrTemporary(
      CONFIG, "key", { b64Json: "AQID", url: PROVIDER_IMAGE_URL }, IMAGE_BASE,
      undefined, () => 1000, resolveMediaWorkerTransport({}),
    );

    expect(result).toMatchObject({ archived: false, url: PROVIDER_IMAGE_URL });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "xcity.media_worker.request.rejected",
      path: "/upload",
      transport: "fetch",
      status: 403,
    }));
  });

  it("keeps TokenHub generation and wallet key minting on global fetch with the binding bound", async () => {
    const globalCalls = stubGlobalFetch(url => {
      if (url === "https://tokenhub.xcity.ai/v1/images/generations") {
        return json({ data: [{ url: PROVIDER_IMAGE_URL }] });
      }
      if (url === "https://wallet.xcity.ai/v1/keys/for-user") return json({ key: "sk-user" });
      if (url === PROVIDER_IMAGE_URL) return providerImage();
      throw new Error(`unexpected global fetch to ${url}`);
    });
    const { binding, seen } = fakeBinding(() =>
      archived("https://media.xcity.ai/media/u/1/img.png", "u/1/img.png", 3));
    const mediaWorker = resolveMediaWorkerTransport({ XCITY_MEDIA: binding });

    const minted = await mintTokenhubKey(CONFIG, { sub: "user-1" });
    const created = await createImage(
      CONFIG, "sk-user", { model: "seedream-4-0", prompt: "a red cube", size: "1024x1024" },
    );
    const result = await archiveImageOrTemporary(
      CONFIG, "sk-user", created.image, IMAGE_BASE, undefined, () => 1000, mediaWorker,
    );

    expect(minted?.key).toBe("sk-user");
    expect(result.archived).toBe(true);
    expect(globalCalls.map(r => r.url)).toEqual([
      "https://wallet.xcity.ai/v1/keys/for-user",
      "https://tokenhub.xcity.ai/v1/images/generations",
      PROVIDER_IMAGE_URL,
    ]);
    expect(seen.map(r => r.url)).toEqual(["https://media.xcity.ai/upload"]);
  });
});

describe("media generation cost", () => {
  it("extracts cost from tokenhub response shapes", () => {
    expect(extractTokenhubCost({ usage: { total_cost: 0.123 } })).toEqual({
      totalUsd: 0.123,
      currency: "USD",
      source: "tokenhub",
    });
    expect(extractTokenhubCost({ _hidden_params: { response_cost: 0.5 } })?.totalUsd).toBe(0.5);
  });

  it("estimates Seedance video cost from the Studio price table", () => {
    expect(estimateSeedanceVideoCost({
      model: "seedance-1-5-pro-251215",
      resolution: "720p",
      seconds: 8,
    })).toEqual({
      totalUsd: 0.416,
      currency: "USD",
      source: "estimate",
      model: "seedance-1-5-pro-251215",
      resolution: "720p",
      durationSeconds: 8,
      pricePerSecond: 0.052,
    });
  });
});


// The outbound URLs are the one part of these calls that no unit test used to touch, and a wrong
// one is invisible until a real generation 404s: /v1/images (no such gateway route) shipped and
// broke every image generation. Pin the full URL for each generation call.
describe("tokenhub generation endpoints", () => {
  it("posts image generations to /v1/images/generations", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return json({
        data: [{ b64_json: "AQID", revised_prompt: "a red cube, studio lit" }],
        usage: { total_cost: 0.04 },
      });
    };

    const result = await createImage(
      CONFIG,
      "key",
      { model: "seedream-4-0", prompt: "a red cube", size: "1024x1024" },
      fetchImpl as typeof fetch,
    );

    expect(seen).toEqual([{
      url: "https://tokenhub.xcity.ai/v1/images/generations",
      method: "POST",
      body: { model: "seedream-4-0", prompt: "a red cube", n: 1, size: "1024x1024" },
    }]);
    expect(result.image).toEqual({ b64Json: "AQID", revisedPrompt: "a red cube, studio lit" });
    expect(result.cost?.totalUsd).toBe(0.04);
  });

  it("reads url-form image responses from the same endpoint", async () => {
    const fetchImpl = async (input: RequestInfo | URL, _init?: RequestInit) => {
      expect(String(input)).toBe("https://tokenhub.xcity.ai/v1/images/generations");
      return json({ data: [{ url: "https://provider.example/image.png" }] });
    };

    const result = await createImage(
      CONFIG,
      "key",
      { model: "seedream-4-0", prompt: "a red cube", size: "1024x1024" },
      fetchImpl as typeof fetch,
    );

    expect(result.image).toEqual({ url: "https://provider.example/image.png" });
  });

  it("surfaces the gateway message when the image endpoint rejects the request", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ error: { message: "404: Not Found" } }, 404);

    await expect(createImage(
      CONFIG,
      "key",
      { model: "seedream-4-0", prompt: "a red cube", size: "1024x1024" },
      fetchImpl as typeof fetch,
    )).rejects.toMatchObject({ name: "XcityMediaApiError", status: 404 });
  });

  it("posts video jobs to /v1/videos", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method });
      return json({ id: "vid_1", status: "queued" });
    };

    const job = await createVideoJob(
      CONFIG,
      "key",
      {
        model: "seedance-1-5-pro-251215",
        prompt: "a red cube spinning",
        ratio: "16:9",
        resolution: "720p",
        seconds: 5,
        generateAudio: true,
        inputReferenceUrl: "",
        cameraFixed: false,
      },
      fetchImpl as typeof fetch,
    );

    expect(seen).toEqual([{ url: "https://tokenhub.xcity.ai/v1/videos", method: "POST" }]);
    expect(job).toMatchObject({ id: "vid_1", status: "queued" });
  });

  it("polls video status at /v1/videos/{id}", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method });
      return json({ id: "vid 1", status: "completed", output_url: "https://ark.volces.com/tmp.mp4" });
    };

    await retrieveVideoJob(CONFIG, "key", "vid 1", fetchImpl as typeof fetch);

    expect(seen).toEqual([{ url: "https://tokenhub.xcity.ai/v1/videos/vid%201", method: "GET" }]);
  });
});

const IMAGE_ACTION: StoredGenerateAction = {
  kind: "image",
  mediaId: "image_1",
  options: { model: "seedream-4-0", prompt: "a red cube", size: "1024x1024" },
  submittedAt: 1000,
};

/** One pending action (id 7) over in-memory stores, standing in for the gatekeeper's DO storage. */
function applyHarness(action: StoredGenerateAction = IMAGE_ACTION) {
  const actions = new Map<number, StoredGenerateAction>([[7, action]]);
  const stored: GeneratedMedia[] = [];
  return {
    actions,
    stored,
    pending: {
      get: (actionId: number) => actions.get(actionId),
      remove: (actionId: number) => { actions.delete(actionId); },
    },
    storeResult: (result: GeneratedMedia) => { stored.push(result); },
  };
}

describe("applyMediaAction", () => {
  it("records a failed generation as the result instead of failing the approval", async () => {
    const h = applyHarness();
    const failures: unknown[] = [];

    await expect(applyMediaAction({
      actionId: 7,
      pending: h.pending,
      run: async () => { throw new Error("404: Not Found"); },
      storeResult: h.storeResult,
      onFailure: (_action, error) => { failures.push(error); },
    })).resolves.toBeUndefined();

    expect(h.stored).toEqual([{
      id: "image_1",
      kind: "image",
      status: "failed",
      archived: false,
      error: "404: Not Found",
      createdAt: new Date(1000),
      updatedAt: expect.any(Date),
    }]);
    // The pending record must go on the failure path too, or the action stays queued forever.
    expect(h.actions.has(7)).toBe(false);
    expect(failures).toHaveLength(1);
  });

  it("keeps a video action's cost estimate on the failure record", async () => {
    const h = applyHarness({
      kind: "video",
      mediaId: "video_1",
      options: {
        model: "seedance-1-5-pro-251215",
        prompt: "a red cube spinning",
        ratio: "16:9",
        resolution: "720p",
        seconds: 5,
        generateAudio: true,
        inputReferenceUrl: "",
        cameraFixed: false,
      },
      cost: { totalUsd: 0.26, currency: "USD", source: "estimate" },
      submittedAt: 2000,
    });

    await applyMediaAction({
      actionId: 7,
      pending: h.pending,
      run: async () => { throw "upstream exploded"; },
      storeResult: h.storeResult,
    });

    expect(h.stored[0]).toMatchObject({
      id: "video_1",
      kind: "video",
      status: "failed",
      error: "upstream exploded",
      cost: { totalUsd: 0.26, currency: "USD", source: "estimate" },
    });
  });

  it("stores nothing and clears the pending record when the generation succeeds", async () => {
    const h = applyHarness();

    await applyMediaAction({
      actionId: 7,
      pending: h.pending,
      run: async () => {},
      storeResult: h.storeResult,
    });

    expect(h.stored).toEqual([]);
    expect(h.actions.has(7)).toBe(false);
  });

  it("still rejects for an action that is not pending", async () => {
    const h = applyHarness();

    await expect(applyMediaAction({
      actionId: 8,
      pending: h.pending,
      run: async () => {},
      storeResult: h.storeResult,
    })).rejects.toThrow("Unknown pending Xcity media action: 8");
  });
});
