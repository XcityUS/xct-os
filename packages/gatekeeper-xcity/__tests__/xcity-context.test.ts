import { describe, expect, it } from "vitest";
import {
  createContextDocument,
  deleteContextDocument,
  getContextDocument,
  listContextDocuments,
  MAX_CONTEXT_CONTENT_BYTES,
  normalizeSaveContextOptions,
  normalizeUpdateContextOptions,
  readXcityContextConfig,
  updateContextDocument,
  withContextKeyRetry,
  xcityContextResourceUrl,
  type XcityContextConfig,
} from "../src/xcity-context";
import { XcityMediaApiError } from "../src/xcity-media";

const CONFIG: XcityContextConfig = {
  tokenhubUrl: "https://tokenhub.xcity.ai",
  walletUrl: "https://wallet.xcity.ai",
  walletServiceToken: "service-token",
};

const DOC_ROW = {
  context_id: "ctx_1",
  title: "Team glossary",
  content_preview: "Common terms...",
  tags: ["reference"],
  is_public: false,
  user_id: "user_1",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readXcityContextConfig", () => {
  it("returns null when any context-plane setting is missing", () => {
    expect(readXcityContextConfig({})).toBeNull();
    expect(readXcityContextConfig({
      XCITY_TOKENHUB_URL: "https://tokenhub.xcity.ai",
      XCITY_WALLET_URL: "https://wallet.xcity.ai",
    })).toBeNull();
    expect(readXcityContextConfig({
      XCITY_TOKENHUB_URL: "https://tokenhub.xcity.ai",
      WALLET_SERVICE_TOKEN: "service-token",
    })).toBeNull();
  });

  it("returns normalized config without requiring the media worker", () => {
    expect(readXcityContextConfig({
      XCITY_TOKENHUB_URL: "https://tokenhub.xcity.ai/",
      XCITY_WALLET_URL: "https://wallet.xcity.ai/",
      WALLET_SERVICE_TOKEN: " service-token ",
    })).toEqual(CONFIG);
    expect(xcityContextResourceUrl(CONFIG)).toBe("https://tokenhub.xcity.ai/xct-context");
  });
});

describe("listContextDocuments", () => {
  it("lists documents with previews, tags, and paging metadata", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://tokenhub.xcity.ai/v1/xct-context");
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("q")).toBe("glossary");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer user-key" });
      return json({ data: [DOC_ROW], has_more: true, next_cursor: "cursor_2" });
    };

    const list = await listContextDocuments(
      CONFIG, "user-key", { query: "glossary" }, fetchImpl as typeof fetch);
    expect(list.hasMore).toBe(true);
    expect(list.nextCursor).toBe("cursor_2");
    expect(list.documents).toHaveLength(1);
    expect(list.documents[0]).toMatchObject({
      contextId: "ctx_1",
      title: "Team glossary",
      contentPreview: "Common terms...",
      tags: ["reference"],
      isPublic: false,
    });
    expect(list.documents[0].createdAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(list.documents[0]).not.toHaveProperty("content");
  });

  it("forwards the cursor and clamps the limit", async () => {
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("cursor")).toBe("cursor_2");
      return json({ data: [], has_more: false });
    };

    const list = await listContextDocuments(
      CONFIG, "user-key", { limit: 5000, cursor: "cursor_2" }, fetchImpl as typeof fetch);
    expect(list).toEqual({ documents: [], hasMore: false });
  });
});

describe("getContextDocument", () => {
  it("returns the full document content from the data envelope", async () => {
    const fetchImpl = async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://tokenhub.xcity.ai/v1/xct-context/ctx_1");
      return json({ data: { ...DOC_ROW, content: "Full body of the glossary." } });
    };

    await expect(getContextDocument(CONFIG, "user-key", "ctx_1", fetchImpl as typeof fetch))
        .resolves.toMatchObject({
          contextId: "ctx_1",
          title: "Team glossary",
          content: "Full body of the glossary.",
        });
  });

  it("maps 404 to a clear not-found error", async () => {
    const fetchImpl = async () => json({ error: "no such row" }, 404);
    await expect(getContextDocument(CONFIG, "user-key", "ctx_missing", fetchImpl as typeof fetch))
        .rejects.toThrow("Context document ctx_missing was not found in the Xcity context store.");
  });

  it("maps 403 to a clear not-accessible error", async () => {
    const fetchImpl = async () => json({ error: "not yours" }, 403);
    await expect(getContextDocument(CONFIG, "user-key", "ctx_other", fetchImpl as typeof fetch))
        .rejects.toThrow("Context document ctx_other is not accessible from this Xcity account.");
  });
});

describe("createContextDocument", () => {
  it("posts the document and returns the created row", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://tokenhub.xcity.ai/v1/xct-context");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        title: "Team glossary",
        content: "Full body.",
        tags: ["reference"],
        is_public: true,
      });
      return json({ data: { ...DOC_ROW, is_public: true, content: "Full body." } });
    };

    await expect(createContextDocument(
      CONFIG, "user-key",
      { title: " Team glossary ", content: "Full body.", tags: [" reference "], isPublic: true },
      fetchImpl as typeof fetch,
    )).resolves.toMatchObject({ contextId: "ctx_1", isPublic: true, content: "Full body." });
  });

  it("rejects content over the 256 KB limit before any request is made", async () => {
    const fetchImpl = async () => {
      throw new Error("must not fetch");
    };
    const oversized = "x".repeat(MAX_CONTEXT_CONTENT_BYTES + 1);
    await expect(createContextDocument(
      CONFIG, "user-key", { title: "Big", content: oversized }, fetchImpl as typeof fetch,
    )).rejects.toThrow(/limited to 262144 bytes \(256 KB\)/);
  });
});

describe("updateContextDocument / deleteContextDocument", () => {
  it("patches only the provided fields", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://tokenhub.xcity.ai/v1/xct-context/ctx_1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ title: "Renamed" });
      return json({ data: { ...DOC_ROW, title: "Renamed" } });
    };

    await expect(updateContextDocument(
      CONFIG, "user-key", "ctx_1", { title: "Renamed" }, fetchImpl as typeof fetch,
    )).resolves.toMatchObject({ contextId: "ctx_1", title: "Renamed" });
  });

  it("treats a bodyless PATCH response as a successful update", async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });
    await expect(updateContextDocument(
      CONFIG, "user-key", "ctx_1", { content: "New." }, fetchImpl as typeof fetch,
    )).resolves.toBeNull();
  });

  it("deletes by id and maps 404", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://tokenhub.xcity.ai/v1/xct-context/ctx_1");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    };
    await expect(deleteContextDocument(CONFIG, "user-key", "ctx_1", fetchImpl as typeof fetch))
        .resolves.toBeUndefined();

    const missingFetch = async () => json({ error: "gone" }, 404);
    await expect(deleteContextDocument(CONFIG, "user-key", "ctx_1", missingFetch as typeof fetch))
        .rejects.toThrow("Context document ctx_1 was not found in the Xcity context store.");
  });
});

describe("normalize options", () => {
  it("requires a non-empty title and at least one updated field", () => {
    expect(() => normalizeSaveContextOptions({ title: "  ", content: "x" }))
        .toThrow("A non-empty document title is required.");
    expect(() => normalizeUpdateContextOptions({}))
        .toThrow("An update must change at least one of title, content, tags, or isPublic.");
  });

  it("enforces the 256 KB limit on updates too", () => {
    expect(() => normalizeUpdateContextOptions({ content: "y".repeat(MAX_CONTEXT_CONTENT_BYTES + 1) }))
        .toThrow(/256 KB/);
    // Multi-byte characters count as UTF-8 bytes, not string length.
    expect(() => normalizeUpdateContextOptions({ content: "é".repeat(MAX_CONTEXT_CONTENT_BYTES / 2 + 1) }))
        .toThrow(/256 KB/);
  });
});

describe("withContextKeyRetry", () => {
  it("re-mints the key and retries exactly once on 401", async () => {
    const mints: boolean[] = [];
    const getKey = async (forceMint: boolean) => {
      mints.push(forceMint);
      return forceMint ? "fresh-key" : "stale-key";
    };
    const seenKeys: string[] = [];
    const result = await withContextKeyRetry(getKey, async apiKey => {
      seenKeys.push(apiKey);
      if (apiKey === "stale-key") throw new XcityMediaApiError(401, "expired");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(mints).toEqual([false, true]);
    expect(seenKeys).toEqual(["stale-key", "fresh-key"]);
  });

  it("retries the full request against tokenhub after a 401", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return json({ error: "invalid key" }, 401);
      return json({ data: [DOC_ROW], has_more: false });
    };
    const getKey = async (forceMint: boolean) => (forceMint ? "fresh-key" : "stale-key");

    const list = await withContextKeyRetry(getKey, apiKey =>
      listContextDocuments(CONFIG, apiKey, undefined, fetchImpl as typeof fetch));
    expect(calls).toBe(2);
    expect(list.documents).toHaveLength(1);
  });

  it("does not re-mint on 403 and surfaces a clean error after a second 401", async () => {
    const mints: boolean[] = [];
    const getKey = async (forceMint: boolean) => {
      mints.push(forceMint);
      return "key";
    };

    await expect(withContextKeyRetry(getKey, async apiKey =>
      getContextDocument(CONFIG, apiKey, "ctx_other",
        (async () => json({ error: "not yours" }, 403)) as unknown as typeof fetch),
    )).rejects.toThrow("is not accessible from this Xcity account");
    expect(mints).toEqual([false]);

    await expect(withContextKeyRetry(getKey, async () => {
      throw new XcityMediaApiError(401, "still bad");
    })).rejects.toThrow("Xcity rejected this account's TokenHub credentials.");
  });
});
