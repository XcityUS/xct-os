import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
  type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-xcity",
  entrypoint: ".wrangler/validate/src/xcity.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  // Every var is deployment configuration (BASE_URL, XCITY_AUTH_URL, XCITY_TOKENHUB_URL,
  // XCITY_MEDIA_WORKER_URL, XCITY_WALLET_URL; secrets CLIENT_ID, CLIENT_SECRET,
  // WALLET_SERVICE_TOKEN), supplied by the deployment rather than committed here.
  observability: OBSERVABILITY,
});

export const wrangler = {
  ...DEFAULT_GATEKEEPER_WRANGLER,
  // A plain namespace binding for the account DO. GatekeeperUserImpl is a props-derived
  // entrypoint that the Workshop stores durably (allow_irrevocable_stub_storage); once the
  // creating request context is gone, dispatching through the revived instance's ctx.exports
  // hangs until the runtime cancels it ("code had hung"). `env` survives revival, so account
  // access goes through this binding, with ctx.exports kept only as a dev fallback.
  sameScriptDurableObjects: [{ name: "USER_ACCOUNT", class_name: "UserAccount" }],
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount"] },
  { tag: "v1", new_sqlite_classes: ["XcityMediaGatekeeperImpl"] },
  { tag: "v2", new_sqlite_classes: ["XcityContextGatekeeperImpl"] },
];
