import { describe, expect, it } from "vitest";
import {
  applyMediaAction,
  archiveImageOrTemporary,
  archiveVideoOrTemporary,
  createImage,
  createVideoJob,
  estimateSeedanceVideoCost,
  extractTokenhubCost,
  readXcityMediaConfig,
  retrieveVideoJob,
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
