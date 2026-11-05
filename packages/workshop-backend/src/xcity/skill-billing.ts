import { createWorkshopLogger } from "../observability.js";
import { getXcityAgentMarketplaceConfig } from "./config.js";
import { getXcityAgentPersonaDetails } from "./agent-persona.js";
import type { XcityModelPlaneStorage, XcityUserIdentity } from "./model-plane.js";

const logger = createWorkshopLogger("workshop.xcity.skill-billing");

// Wallet credits are hundredths of a KWH (see usage-checker.ts, which renders credits / 100).
const CREDITS_PER_KWH = 100;

// Per-turn billing is best-effort: never let a slow wallet hold a turn's lifecycle hostage.
const DEBIT_TIMEOUT_MS = 5_000;

/** Wallet connection details for a skill-use debit (a subset of XcityConfig). */
export type XcitySkillDebitConfig = {
  walletUrl: string;
  walletServiceToken: string;
};

/** One per-turn skill-use charge for a priced marketplace persona. */
export type XcitySkillDebitRequest = {
  /** The marketplace agent slug whose skill is being used (sent as `agent_id`). */
  agentSlug: string;
  /** Per-use price in KWH; converted to integer credits (KWH * 100, rounded). */
  kwhPerUse: number;
  /**
   * Idempotency key, stable for one logical chat turn and distinct across turns; the wallet
   * dedupes on it so a retried delivery never double-charges.
   */
  requestId: string;
  /** Chat reference recorded in the debit's metadata (informational only). */
  chatId?: string;
};

/**
 * Debit the user's Xcity wallet for one use of a priced marketplace skill.
 *
 * Fail-open by design: 200 (charged) and 402 (out of balance) are both terminal — the seam-3
 * balance gate, not this debit, is what blocks chats — and any network error or 5xx is logged and
 * swallowed. This function never throws and must never block or fail the turn.
 */
export async function debitXcitySkillUse(
    config: XcitySkillDebitConfig,
    identity: XcityUserIdentity,
    request: XcitySkillDebitRequest): Promise<void> {
  let amountCredits = Math.round(request.kwhPerUse * CREDITS_PER_KWH);
  if (!Number.isFinite(amountCredits) || amountCredits <= 0) return;

  let logContext = {
    agentSlug: request.agentSlug,
    requestId: request.requestId,
    amountCredits,
  };

  let response: Response;
  try {
    response = await fetch(`${config.walletUrl}/v1/wallet/debit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.walletServiceToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        user_id: identity.userId,
        request_id: request.requestId,
        amount_credits: amountCredits,
        product: "workshop",
        meter: "skill_use",
        agent_id: request.agentSlug,
        ...(request.chatId ? { metadata: { chat_id: request.chatId } } : {}),
      }),
      signal: AbortSignal.timeout(DEBIT_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("xcity skill-use debit request failed", {
      event: "xcity.skill.debit.failed", ...logContext, error,
    });
    return;
  }

  response.body?.cancel().catch(() => {});

  if (response.ok) {
    logger.info("xcity skill-use debit succeeded", {
      event: "xcity.skill.debit.ok", ...logContext,
    });
    return;
  }

  if (response.status === 402) {
    // Out of balance. Terminal: the wallet recorded the refusal, and the seam-3 balance gate is
    // what stops further chats once the cached balance catches up.
    logger.info("xcity skill-use debit declined for insufficient balance", {
      event: "xcity.skill.debit.declined", ...logContext,
    });
    return;
  }

  logger.warn("xcity skill-use debit request failed", {
    event: "xcity.skill.debit.failed",
    ...logContext,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Per-turn skill-use billing entry point for the User Durable Object: resolves the persona's
 * current pricing (30-minute in-isolate cache, shared with persona injection) and debits the
 * wallet when the skill is priced. No-op — with zero side effects — when the Xcity agent
 * marketplace is unconfigured, the user has no Xcity identity, or the skill is free/unpriced.
 * Fail-open like debitXcitySkillUse; never throws.
 */
export async function debitXcitySkillUseForTurn(
    env: Cloudflare.Env,
    storage: XcityModelPlaneStorage,
    identity: XcityUserIdentity | null,
    slug: string,
    requestId: string,
    chatId?: string,
    email?: string): Promise<void> {
  let config = getXcityAgentMarketplaceConfig(env);
  if (!config || !identity) return;

  let details = await getXcityAgentPersonaDetails(env, config, storage, identity, slug, email);
  let kwhPerUse = details?.kwhPerUse;
  if (kwhPerUse === undefined) return;

  await debitXcitySkillUse(config, identity, {
    agentSlug: slug,
    kwhPerUse,
    requestId,
    ...(chatId ? { chatId } : {}),
  });
}
