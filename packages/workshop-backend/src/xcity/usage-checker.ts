import type { CloudflareUsageInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "../observability.js";
import type { UserDurableObject } from "../user.js";
import type { UsageCheckResult } from "../ai-gateway-billing/limits/usage-checker.js";
import { getXcityUsageConfig } from "./config.js";

const BALANCE_CACHE_TTL_MS = 5 * 60 * 1000;
const CREDITS_PER_KWH = 100;

const logger = createWorkshopLogger("workshop.xcity.usage");

type UserStub = DurableObjectStub<UserDurableObject>;

type WalletBalanceResponse = {
  balance?: unknown;
};

function creditsToKwh(credits: number): number {
  return credits / CREDITS_PER_KWH;
}

function formatKwh(credits: number): string {
  return creditsToKwh(credits).toFixed(1);
}

function rechargeMessage(balance: number, homeUrl?: string): string {
  let destination = homeUrl ? ` at ${homeUrl}` : " in xct-home";
  return `Your Xcity wallet balance is ${formatKwh(balance)} KWH. Recharge${destination} to continue.`;
}

async function getUsableXcityAccessToken(userStub: UserStub): Promise<string | null> {
  using account = await userStub.getXcityGatekeeperAccount();
  if (!account) return null;
  return await account.getUsableAccessToken();
}

async function fetchWalletBalance(walletUrl: string, token: string): Promise<number | null> {
  let resp: Response;
  try {
    resp = await fetch(`${walletUrl}/v1/wallet/balance`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    });
  } catch (err) {
    logger.warn("xcity wallet balance request failed", {
      event: "xcity.wallet.balance.request.failed", error: err,
    });
    return null;
  }

  if (!resp.ok) {
    logger.warn("xcity wallet balance request failed", {
      event: "xcity.wallet.balance.request.failed",
      status: resp.status,
      statusText: resp.statusText,
    });
    resp.body?.cancel().catch(() => {});
    return null;
  }

  let body: WalletBalanceResponse;
  try {
    body = await resp.json() as WalletBalanceResponse;
  } catch (err) {
    logger.warn("xcity wallet balance response was invalid", {
      event: "xcity.wallet.balance.response.invalid", error: err,
    });
    return null;
  }

  if (typeof body.balance !== "number" || !Number.isFinite(body.balance)) {
    logger.warn("xcity wallet balance response was invalid", {
      event: "xcity.wallet.balance.response.invalid",
    });
    return null;
  }

  return Math.trunc(body.balance);
}

async function readCachedOrFreshBalance(
    walletUrl: string, userStub: UserStub, token: string): Promise<number | null> {
  let cached = await userStub.getXcityWalletBalance();
  let cacheAge = cached?.creditsUpdatedAt ? Date.now() - cached.creditsUpdatedAt : Infinity;
  if (cacheAge < BALANCE_CACHE_TTL_MS && cached?.creditsRemaining !== undefined) {
    return cached.creditsRemaining ?? null;
  }

  let fresh = await fetchWalletBalance(walletUrl, token);
  if (fresh !== null) {
    await userStub.updateXcityWalletBalance(fresh);
  }
  return fresh;
}

function allowedResult(balance: number | null, hasUserToken: boolean): UsageCheckResult {
  return {
    allowed: true,
    shouldUseByok: false,
    withinLimits: true,
    remaining: balance === null ? Infinity : creditsToKwh(balance),
    limit: Infinity,
    balance,
    hasUserToken,
  };
}

export async function checkXcityUsage(
  env: Cloudflare.Env,
  userStub: UserStub,
): Promise<UsageCheckResult> {
  let config = getXcityUsageConfig(env);
  if (!config) return allowedResult(null, false);

  let token: string | null;
  try {
    token = await getUsableXcityAccessToken(userStub);
  } catch (err) {
    logger.warn("xcity usable token lookup failed", {
      event: "xcity.token.lookup.failed", error: err,
    });
    token = null;
  }

  // Fail open because tokenhub/litellm wallet budgets are the enforcing billing boundary. This
  // preflight exists only to give a friendlier recharge prompt; a wallet or token outage must not
  // make the whole product unavailable.
  if (!token) {
    logger.warn("xcity usable token unavailable", {
      event: "xcity.token.unavailable",
    });
    return allowedResult(null, false);
  }

  let balance = await readCachedOrFreshBalance(config.walletUrl, userStub, token);
  if (balance === null) return allowedResult(null, true);

  if (balance > 0) return allowedResult(balance, true);

  return {
    allowed: false,
    reason: rechargeMessage(balance, config.homeUrl),
    shouldUseByok: false,
    withinLimits: false,
    remaining: 0,
    limit: 0,
    balance,
    hasUserToken: true,
  };
}

export async function getXcityUsageInfo(
  env: Cloudflare.Env,
  userStub: UserStub,
): Promise<CloudflareUsageInfo> {
  let config = getXcityUsageConfig(env);
  if (!config) {
    return {
      cloudflareLimitsEnabled: false,
      unlimited: true,
      dailyUsed: 0,
      dailyLimit: 0,
      remaining: 0,
      connected: false,
      balance: null,
    };
  }

  let token: string | null;
  try {
    token = await getUsableXcityAccessToken(userStub);
  } catch (err) {
    logger.warn("xcity usable token lookup failed", {
      event: "xcity.token.lookup.failed", error: err,
    });
    token = null;
  }

  let balance: number | null = null;
  if (token) {
    balance = await readCachedOrFreshBalance(config.walletUrl, userStub, token);
  }

  return {
    cloudflareLimitsEnabled: false,
    unlimited: false,
    dailyUsed: 0,
    dailyLimit: 0,
    remaining: balance === null ? 0 : creditsToKwh(balance),
    connected: token !== null,
    balance,
    billingMode: "xcity",
    balanceUnit: "credits",
    rechargeUrl: config.homeUrl,
  };
}
