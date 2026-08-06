import { afterEach, describe, expect, it, vi } from "vitest";
import type { XcityGatekeeperUser } from "@gadgets/workshop-shared/xcity-gatekeeper";
import { checkXcityUsage } from "../src/xcity/usage-checker.js";
import type { UserDurableObject } from "../src/user.js";

type XcityWalletBalance = {
  creditsRemaining?: number | null;
  creditsUpdatedAt?: number;
};

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    XCITY_WALLET_URL: "https://wallet.xcity.ai",
    XCITY_HOME_URL: "https://xcity.ai",
    ...overrides,
  } as Cloudflare.Env;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeUserStub(options: {
  token?: string | null;
  cache?: XcityWalletBalance | null;
} = {}) {
  let cache = options.cache ?? null;
  const token = options.token === undefined ? "gotrue-token" : options.token;
  const dispose = vi.fn();
  const account = {
    getUsableAccessToken: vi.fn(async () => token),
    [Symbol.dispose]: dispose,
  } as unknown as Fetcher<XcityGatekeeperUser>;
  const stub = {
    getXcityGatekeeperAccount: vi.fn(async () => account),
    getXcityWalletBalance: vi.fn(async () => cache),
    updateXcityWalletBalance: vi.fn(async (creditsRemaining: number | null) => {
      cache = { creditsRemaining, creditsUpdatedAt: Date.now() };
    }),
  } as unknown as DurableObjectStub<UserDurableObject>;
  return { stub, account, dispose };
}

describe("checkXcityUsage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("allows a turn when the wallet has a positive KWH balance", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ balance: 250 }));
    vi.stubGlobal("fetch", fetchMock);
    const { stub, dispose } = makeUserStub();

    const result = await checkXcityUsage(env(), stub);

    expect(result.allowed).toBe(true);
    expect(result.shouldUseByok).toBe(false);
    expect(result.withinLimits).toBe(true);
    expect(result.balance).toBe(250);
    expect(result.remaining).toBe(2.5);
    expect(result.hasUserToken).toBe(true);
    expect(stub.updateXcityWalletBalance).toHaveBeenCalledWith(250);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://wallet.xcity.ai/v1/wallet/balance",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "Bearer gotrue-token",
        }),
      }),
    );
    expect(dispose).toHaveBeenCalled();
  });

  it("blocks a turn when the wallet balance is zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ balance: 0 })));
    const { stub } = makeUserStub();

    const result = await checkXcityUsage(env(), stub);

    expect(result.allowed).toBe(false);
    expect(result.shouldUseByok).toBe(false);
    expect(result.withinLimits).toBe(false);
    expect(result.balance).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(0);
    expect(result.reason).toContain("Recharge at https://xcity.ai");
  });

  it("fails open when the wallet call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)));
    const { stub } = makeUserStub();

    const result = await checkXcityUsage(env(), stub);

    expect(result.allowed).toBe(true);
    expect(result.shouldUseByok).toBe(false);
    expect(result.withinLimits).toBe(true);
    expect(result.balance).toBeNull();
    expect(result.hasUserToken).toBe(true);
    expect(stub.updateXcityWalletBalance).not.toHaveBeenCalled();
  });

  it("fails open when no usable user token is available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { stub } = makeUserStub({ token: null });

    const result = await checkXcityUsage(env(), stub);

    expect(result.allowed).toBe(true);
    expect(result.balance).toBeNull();
    expect(result.hasUserToken).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses a fresh cached balance", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetchMock = vi.fn(async () => jsonResponse({ balance: 175 }));
    vi.stubGlobal("fetch", fetchMock);
    const { stub } = makeUserStub();

    await checkXcityUsage(env(), stub);
    const result = await checkXcityUsage(env(), stub);

    expect(result.allowed).toBe(true);
    expect(result.balance).toBe(175);
    expect(result.remaining).toBe(1.75);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stub.updateXcityWalletBalance).toHaveBeenCalledTimes(1);
  });
});
