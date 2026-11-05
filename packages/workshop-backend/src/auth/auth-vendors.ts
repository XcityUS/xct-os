// Helpers for resolving authentication-gatekeeper service bindings.
//
// The backend discovers gatekeepers from `GATEKEEPER_<NAME>` env bindings, where the vendor id is
// the suffix lowercased (e.g. GATEKEEPER_GOOGLE -> "google"). These helpers map between the two.

import { GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";

const GATEKEEPER_BINDING_PREFIX = "GATEKEEPER_";

/**
 * Suffix marking a binding that is an HTTP forwarding target rather than a gatekeeper vendor.
 *
 * The default `fetch()` handler in `server.ts` forwards `/gatekeeper/<name>/*` (the OAuth redirect
 * lands there) to a `GATEKEEPER_<NAME>_HTTP` binding, because the vendor RPC entrypoint these
 * helpers resolve has no fetch handler and so cannot serve those requests; that binding points at
 * the gatekeeper Worker's *default* entrypoint instead. See the comment on the forwarding block in
 * `server.ts` for the full rationale, and keep the two in sync.
 *
 * Those forwarding bindings share the `GATEKEEPER_` prefix, so vendor discovery has to exclude
 * them explicitly. Without this, `GATEKEEPER_XCITY_HTTP` registers a phantom `xcity_http` vendor
 * backed by a bare `{ fetch }` object, every describe() on it fails, and users see the gatekeeper
 * listed as unavailable. Every OAuth-based gatekeeper a deployment adds brings another one of
 * these bindings, so this exclusion is load-bearing, not a one-off workaround: do not remove it.
 */
const HTTP_FORWARDING_BINDING_SUFFIX = "_HTTP";

export function gatekeeperBindingName(vendorId: string): string {
  return GATEKEEPER_BINDING_PREFIX + vendorId.toUpperCase();
}

/** Return the gatekeeper vendor service binding for `vendorId`, or null if not bound. */
export function getAuthVendorBinding(
  env: Cloudflare.Env, vendorId: string,
): Service<GatekeeperVendor> | null {
  const binding = (env as unknown as Record<string, unknown>)[gatekeeperBindingName(vendorId)];
  return (binding as Service<GatekeeperVendor>) ?? null;
}

/**
 * Build a map of every bound gatekeeper, keyed by vendor id (the GATEKEEPER_<NAME> suffix,
 * lowercased). The set of gatekeepers is deployment-global (env bindings), so this is independent of
 * any particular user.
 *
 * `GATEKEEPER_<NAME>_HTTP` bindings are skipped: they are HTTP forwarding targets, not vendors.
 */
export function buildGatekeeperVendorMap(
  env: Cloudflare.Env,
): Map<string, Service<GatekeeperVendor>> {
  const vendors = new Map<string, Service<GatekeeperVendor>>();
  for (const bindingName in env) {
    if (!bindingName.startsWith(GATEKEEPER_BINDING_PREFIX)) continue;
    if (bindingName.endsWith(HTTP_FORWARDING_BINDING_SUFFIX)) continue;
    const vendorId = bindingName.slice(GATEKEEPER_BINDING_PREFIX.length).toLowerCase();
    vendors.set(vendorId, (env as unknown as Record<string, Service<GatekeeperVendor>>)[bindingName]);
  }
  return vendors;
}
