import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

export interface XcityConfig {
  tokenhubUrl: string;
  walletUrl: string;
  walletServiceToken: string;
  quickModel?: string;
}

export interface XcityUsageConfig {
  walletUrl: string;
  homeUrl?: string;
}

export interface XcityAgentMarketplaceConfig {
  homeUrl: string;
  tokenhubUrl: string;
  walletUrl: string;
  walletServiceToken: string;
  quickModel?: string;
}

function getEnvString(env: Cloudflare.Env, name: keyof Cloudflare.Env): string | undefined {
  let value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getXcityWalletUrl(env: Cloudflare.Env): string | undefined {
  let walletUrl = getEnvString(env, "XCITY_WALLET_URL");
  return walletUrl ? stripTrailingSlashes(walletUrl) : undefined;
}

export function getXcityHomeUrl(env: Cloudflare.Env): string | undefined {
  let homeUrl = getEnvString(env, "XCITY_HOME_URL");
  return homeUrl ? stripTrailingSlashes(homeUrl) : undefined;
}

export function getXcityUsageConfig(env: Cloudflare.Env): XcityUsageConfig | null {
  let walletUrl = getXcityWalletUrl(env);
  if (!walletUrl) return null;

  let homeUrl = getXcityHomeUrl(env);
  return {
    walletUrl,
    ...(homeUrl ? { homeUrl } : {}),
  };
}

/**
 * Parse Xcity model-plane configuration. Returns null unless all required model-plane
 * variables are present, keeping non-Xcity deployments on the upstream model path.
 */
export function getXcityConfig(env: Cloudflare.Env): XcityConfig | null {
  let tokenhubUrl = getEnvString(env, "XCITY_TOKENHUB_URL");
  let walletUrl = getXcityWalletUrl(env);
  let walletServiceToken = getEnvString(env, "WALLET_SERVICE_TOKEN");
  if (!tokenhubUrl || !walletUrl || !walletServiceToken) return null;

  let quickModel = getEnvString(env, "XCITY_QUICK_MODEL");
  return {
    tokenhubUrl: stripTrailingSlashes(tokenhubUrl),
    walletUrl,
    walletServiceToken,
    ...(quickModel ? { quickModel } : {}),
  };
}

export function getXcityAgentMarketplaceConfig(
    env: Cloudflare.Env): XcityAgentMarketplaceConfig | null {
  let homeUrl = getXcityHomeUrl(env);
  let modelPlane = getXcityConfig(env);
  if (!homeUrl || !modelPlane) return null;

  return {
    homeUrl,
    ...modelPlane,
  };
}
