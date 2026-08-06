import { GatekeeperUser } from "./gatekeeper.js";

/** Xcity-specific extension to the generic GatekeeperUser contract. */
export interface XcityGatekeeperUser extends GatekeeperUser {
  /**
   * Returns a currently usable GoTrue access token for the connected account, or null if the
   * connection is broken or expired. Workshop-only; never exposed to gadgets or agents.
   */
  getUsableAccessToken(): Promise<string | null>;

  /**
   * Returns the connected account's GoTrue user id, the UUID in the OIDC userinfo `sub` claim.
   */
  getXcityUserId(): Promise<string | null>;
}
