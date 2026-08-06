import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.xcity", vendorId: VENDOR_ID,
});

interface RawUserInfo {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  preferred_username?: unknown;
}

/** Verified identity returned by Xcity's OIDC userinfo endpoint. */
export interface XcityIdentity {
  /** GoTrue user id (UUID). */
  sub: string;
  /** Provider-verified account email. */
  email: string;
  /** Human-readable account label. */
  displayName: string;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Fetches the connected user's verified identity from Xcity userinfo. */
export async function fetchIdentity(base: string, token: string): Promise<XcityIdentity | null> {
  const path = "/oauth/userinfo";
  try {
    const resp = await fetch(`${stripTrailingSlashes(base)}${path}`, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    });
    if (!resp.ok) {
      logger.warn("xcity userinfo request failed", {
        event: "xcity.userinfo.failed",
        path, status: resp.status, statusText: resp.statusText,
      });
      resp.body?.cancel();
      return null;
    }

    const data = await resp.json() as RawUserInfo;
    if (data.email_verified !== true) return null;

    const sub = nonEmptyString(data.sub);
    const email = nonEmptyString(data.email);
    if (!sub || !email) return null;

    const displayName =
        nonEmptyString(data.name) ??
        nonEmptyString(data.preferred_username) ??
        email.split("@")[0];
    return { sub, email, displayName };
  } catch (err) {
    logger.warn("xcity userinfo request failed", {
      event: "xcity.userinfo.failed",
      path, error: err,
    });
    return null;
  }
}
