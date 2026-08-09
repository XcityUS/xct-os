import { describe, expect, it } from "vitest";
import {
  archiveImageOrTemporary,
  archiveVideoOrTemporary,
  estimateSeedanceVideoCost,
  extractTokenhubCost,
  readXcityMediaConfig,
  type XcityMediaConfig,
} from "../src/xcity-media";

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
