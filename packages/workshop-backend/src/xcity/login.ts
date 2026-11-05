import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type { XcityGatekeeperUser } from "@gadgets/workshop-shared/xcity-gatekeeper";
import type { UserDurableObject } from "../user.js";
import { createWorkshopLogger } from "../observability";
import { XCITY_VENDOR_ID } from "./model-plane.js";

const logger = createWorkshopLogger("workshop.auth");

/**
 * Xcity's post-sign-in step (seam #6), run by `LoginConnectCallbackImpl` after the account has been
 * linked like Cloudflare's: records the GoTrue `sub` on the user DO and prewarms the model plane
 * and agent catalog off the login path, so the first listing after sign-in hits a warm cache.
 */
export async function completeXcityLogin(
    account: Fetcher<GatekeeperUser>,
    userStub: DurableObjectStub<UserDurableObject>,
    email: string,
    ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  const loginLogger = logger.with({ operation: "gatekeeper.login", vendorId: XCITY_VENDOR_ID });
  const xcityUserId = await (account as Fetcher<XcityGatekeeperUser>).getXcityUserId();
  if (!xcityUserId) {
    loginLogger.warn("xcity login had no user id", { event: "xcity.login.user.id.missing" });
    return;
  }
  await userStub.setXcityIdentity({ userId: xcityUserId, email });
  // Best-effort fire-and-forget.
  ctx.waitUntil(userStub.prewarmXcityModelPlane().catch((err: unknown) => {
    loginLogger.warn("xcity login prewarm failed", {
      event: "xcity.login.prewarm.failed", error: err,
    });
  }));
}
