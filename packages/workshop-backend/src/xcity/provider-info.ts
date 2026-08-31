// Builds the /providers-page description of the user's default Xcity TokenHub provider:
// connected identity, the user's tokenhub virtual key (the same key the xcity.ai dashboard
// shows — minted by wallet POST /v1/keys/for-user), and which model IDs come from tokenhub.

import type { XcityProviderInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "../observability.js";
import { getXcityConfig } from "./config.js";
import {
  XcityModelPlane,
  type XcityModelPlaneStorage,
  type XcityUserIdentity,
} from "./model-plane.js";

const logger = createWorkshopLogger("workshop.xcity.provider-info");

/**
 * Resolve the user's Xcity TokenHub provider info. Returns null when the Xcity model plane is
 * not configured or the user has no Xcity identity. Never throws: on internal failure it logs
 * and returns whatever is knowable (e.g. a minted key with an empty model list).
 *
 * `mintEmail` is the email forwarded to the wallet when the key still has to be minted (same
 * fallback the model plane uses elsewhere); the returned `email` is always the identity's own.
 */
export async function getXcityProviderInfoForUser(
    env: Cloudflare.Env,
    storage: XcityModelPlaneStorage,
    identity: XcityUserIdentity | null,
    mintEmail?: string,
): Promise<XcityProviderInfo | null> {
  let config = getXcityConfig(env);
  if (!config || !identity) return null;

  let modelIds: string[] = [];
  try {
    // forUser mints the per-user key if absent and loads the catalog through the resilient
    // cache; both are best-effort inside the plane itself.
    let plane = await XcityModelPlane.forUser(
        env, config, storage, identity.userId, mintEmail ?? identity.email);
    modelIds = plane.getModelList().map(model => model.id);
  } catch (error) {
    logger.warn("failed to resolve xcity provider info from the model plane", {
      event: "xcity.provider.info.failed", error,
    });
  }

  // Surface only a key minted for this user against the currently-configured wallet.
  let key = storage.get().key;
  let apiKey = key && key.userId === identity.userId && key.walletUrl === config.walletUrl
      ? key.key : undefined;

  return {
    tokenhubUrl: config.tokenhubUrl,
    ...(identity.email ? { email: identity.email } : {}),
    ...(apiKey ? { apiKey } : {}),
    modelIds,
  };
}
