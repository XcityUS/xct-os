import { describe, expect, it } from "vitest";
import { buildGatekeeperVendorMap } from "../src/auth/auth-vendors.js";

// The map is built by scanning env bindings, so the tests only need plain objects standing in for
// the service bindings; identity is enough to tell which binding was registered.
function envWith(bindings: Record<string, unknown>): Cloudflare.Env {
  return bindings as unknown as Cloudflare.Env;
}

describe("buildGatekeeperVendorMap", () => {
  it("registers a vendor for each GATEKEEPER_<NAME> binding", () => {
    const foo = { kind: "vendor" };
    const vendors = buildGatekeeperVendorMap(envWith({ GATEKEEPER_FOO: foo, OTHER: {} }));

    expect([...vendors.keys()]).toEqual(["foo"]);
    expect(vendors.get("foo")).toBe(foo);
  });

  // GATEKEEPER_<NAME>_HTTP bindings exist so server.ts can forward /gatekeeper/<name>/* OAuth
  // redirects to the gatekeeper's default entrypoint. They are not vendor entrypoints, and
  // registering one produces a phantom vendor whose every describe() fails.
  it("ignores GATEKEEPER_<NAME>_HTTP forwarding bindings", () => {
    const vendors = buildGatekeeperVendorMap(envWith({ GATEKEEPER_FOO_HTTP: { fetch: () => {} } }));

    expect([...vendors.keys()]).toEqual([]);
  });

  it("registers exactly one vendor when a gatekeeper has both bindings", () => {
    const foo = { kind: "vendor" };
    const vendors = buildGatekeeperVendorMap(envWith({
      GATEKEEPER_FOO: foo,
      GATEKEEPER_FOO_HTTP: { fetch: () => {} },
    }));

    expect([...vendors.keys()]).toEqual(["foo"]);
    expect(vendors.get("foo")).toBe(foo);
  });
});
