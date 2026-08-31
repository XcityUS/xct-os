import { WorkerEntrypoint, DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, GatekeeperUserVerifier, VendorDescription,
  GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription,
  ApprovalQueue, SupportedResource, ResourceConfiguratorFrame, ResourceDescription, stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import { XcityGatekeeperUser } from "@gadgets/workshop-shared/xcity-gatekeeper";
import {
  getOAuthConfig, getAuthBaseUrl, buildAuthorizeUrl, generatePkce, exchangeCode, refreshTokens,
  AUTH_SCOPES, FULL_SCOPES,
} from "./oauth";
import { fetchIdentity, type XcityIdentity } from "./xcity-api";
import {
  archiveImageOrTemporary,
  archiveVideoOrTemporary,
  createImage,
  createVideoJob,
  estimateSeedanceVideoCost,
  extractTokenhubCost,
  mintTokenhubKey,
  normalizeImageOptions,
  normalizeVideoOptions,
  pendingGeneratedMedia,
  readXcityMediaConfig,
  retrieveVideoJob,
  xcityMediaResourceUrl,
  XcityMediaApiError,
  type XcityMediaConfig,
  type XcityTokenhubVideoJob,
  type XcityVirtualKeyRecord,
  type XcityWalletConfig,
} from "./xcity-media";
import {
  createContextDocument,
  deleteContextDocument,
  getContextDocument,
  listContextDocuments,
  normalizeSaveContextOptions,
  normalizeUpdateContextOptions,
  pendingContextWrite,
  readXcityContextConfig,
  updateContextDocument,
  withContextKeyRetry,
  xcityContextResourceUrl,
  assertContextId,
  type XcityContextConfig,
} from "./xcity-context";
import { VENDOR_ID } from "./vendor.js";
import type {
  GeneratedMedia,
  GenerateImageOptions,
  GenerateVideoOptions,
  ListContextDocumentsOptions,
  MediaGenerationCost,
  SaveContextDocumentOptions,
  UpdateContextDocumentOptions,
  XcityContext,
  XcityContextDocument,
  XcityContextDocumentList,
  XcityContextWrite,
  XcityMedia,
} from "./types";
import type { XcityMediaConfiguratorRpc } from "./configurator/xcity-media-configurator-types";
import type { XcityContextConfiguratorRpc } from "./configurator/xcity-context-configurator-types";
import TYPES_CODE from "./types.txt";
import XCITY_LOGO_SVG from "./xcity-logo.svg";
import XCITY_MEDIA_CONFIGURATOR_HTML from "./generated/xcity-media-configurator-ui.txt";
import XCITY_CONTEXT_CONFIGURATOR_HTML from "./generated/xcity-context-configurator-ui.txt";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.xcity", vendorId: VENDOR_ID,
});

// A nonce stored in UserAccount KV to protect the OAuth flow. Only one is active at a time; `stage`
// tracks where we are. For the OAuth stage we also stash the PKCE verifier alongside the nonce.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  verifier?: string;
  scopes?: string[];
  // While at the "oauth" stage, the still-unexpired initiation link that started this flow. Auth
  // frontends can bounce the browser back to the initiation URL after their own login step; keeping
  // this lets that visit restart the authorize redirect instead of dead-ending on the "link
  // expired" page.
  initiation?: { value: string; expiresAt: number };
};

// A cached access token plus its absolute expiry (unix ms).
type StoredAccessToken = { token: string; expires: number };

// A short-lived userinfo result bound to the exact access token used to fetch it.
type StoredIdentity = { accessToken: string; identity: XcityIdentity; expires: number };

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;
const IDENTITY_CACHE_LIFETIME_MS = 60 * 1000;

const XCITY_LOGO_URL = "data:image/svg+xml," + encodeURIComponent(XCITY_LOGO_SVG);

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Optional env vars (may be omitted from wrangler.jsonc; secrets come from .dev.vars / dashboard).
type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  XCITY_AUTH_URL?: string;
  XCITY_TOKENHUB_URL?: string;
  XCITY_MEDIA_WORKER_URL?: string;
  XCITY_WALLET_URL?: string;
  WALLET_SERVICE_TOKEN?: string;
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/xcity");
}

// The UserAccount namespace for contexts that must survive stub revival. GatekeeperUserImpl and
// the media DO are reached through durably-stored stubs/facets; after the creating request dies,
// their revived ctx.exports dispatches hang until the runtime cancels them, while `env` bindings
// stay valid. ctx.exports remains as the fallback for dev configs without the binding.
function userAccountNamespace(
  env: Env, exports: { UserAccount: DurableObjectNamespace<UserAccount> },
): DurableObjectNamespace<UserAccount> {
  return (env as { USER_ACCOUNT?: DurableObjectNamespace<UserAccount> }).USER_ACCOUNT
      ?? exports.UserAccount;
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function getMediaResource(env: Env): SupportedResource | null {
  const config = readXcityMediaConfig(env);
  if (!config) return null;
  return {
    urlPattern: xcityMediaResourceUrl(config),
    title: "Xcity Media",
    description: "Generate Seedance videos and Seedream images, archived permanently to R2.",
    icon: { url: XCITY_LOGO_URL },
  };
}

function getContextResource(env: Env): SupportedResource | null {
  const config = readXcityContextConfig(env);
  if (!config) return null;
  return {
    urlPattern: xcityContextResourceUrl(config),
    title: "Xcity Context",
    description:
        "Read and write the user's Xcity context documents, shared across all Xcity products.",
    icon: { url: XCITY_LOGO_URL },
  };
}

function getXcityResources(env: Env): SupportedResource[] {
  return [getMediaResource(env), getContextResource(env)]
      .filter((resource): resource is SupportedResource => resource !== null);
}

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en"><body>
<script type="text/javascript">window.close();</script>
<p>Authorization complete. You may close this tab and return to Xcity OS.
</body></html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Authorization Link Expired</h1>
<p>This authorization link is invalid or has expired. Please return to Xcity OS and try again.</p>
<button onclick="window.close()">Close</button></body></html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Configuration Required</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Xcity Gatekeeper Not Configured</h1>
<p>Please see the README.md for instructions on configuring an OAuth client ID and secret.</p>
</body></html>`;

/** Main HTTP entrypoint — used only to initiate and complete the OAuth flow. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const config = getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, getBaseUrl(env), env.XCITY_AUTH_URL)!;
      const authUrl = buildAuthorizeUrl(config, `${doId}:${begun.oauthNonce}`, begun.challenge, begun.scopes);
      return Response.redirect(authUrl, 302);
    } else if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }
      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      const doId = state.slice(0, colonIdx);
      const oauthNonce = state.slice(colonIdx + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};

// =======================================================================================

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Xcity",
      url: "https://xcity.ai",
      logo: { url: XCITY_LOGO_URL },
      color: "#e8fff6",
      tagline: "Sign in, generate media, and bill usage to Xcity",
      description:
          "Sign in with your Xcity account. Model and media generation usage is billed in KWH " +
          "against your Xcity wallet balance.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const authOnly = options?.scopes === "auth";
    const scopes = authOnly ? AUTH_SCOPES : FULL_SCOPES;
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, scopes, authOnly);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return getXcityResources(this.env);
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  #config() {
    const config = getOAuthConfig(
      this.env.CLIENT_ID, this.env.CLIENT_SECRET, getBaseUrl(this.env), this.env.XCITY_AUTH_URL,
    );
    if (!config) throw new Error("The Xcity Gatekeeper is not configured.");
    return config;
  }

  #authBaseUrl() {
    return getAuthBaseUrl(this.env.XCITY_AUTH_URL);
  }

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    scopes?: string[], ephemeral?: boolean) {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    // Scopes to request (auth-only for sign-in, or the full capability set). Reused on reconnect.
    if (scopes) this.ctx.storage.kv.put<string[]>("scopes", scopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral ?? false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  /**
   * Verify the initiation nonce; mint a fresh OAuth nonce + PKCE pair. Returns the OAuth nonce
   * (for the `state`) and the PKCE challenge (for the authorize URL), or null if invalid. The
   * initiation link stays usable until it expires or the flow completes, so a browser bounced back
   * to it mid-flow just restarts the redirect rather than seeing the "link expired" page.
   */
  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; challenge: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    const initiation = stored?.stage === "initiation"
        ? { value: stored.value, expiresAt: stored.expiresAt }
        : stored?.initiation;
    if (!initiation || Date.now() >= initiation.expiresAt ||
        !constantTimeEqual(initiation.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    const { verifier, challenge } = await generatePkce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      verifier,
      initiation,
    });
    const scopes = this.ctx.storage.kv.get<string[]>("scopes") ?? FULL_SCOPES;
    return { oauthNonce, challenge, scopes };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || !stored.verifier ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete the authorization. Please try again.");
    }

    const tokens = await exchangeCode(this.#config(), code, stored.verifier);
    if (!tokens || !tokens.refreshToken) {
      throw new Error("Xcity OAuth exchange failed or returned no refresh token.");
    }

    this.ctx.storage.kv.put<string>("refreshToken", tokens.refreshToken);
    this.ctx.storage.kv.put<StoredAccessToken>("accessToken", {
      token: tokens.accessToken,
      expires: Date.now() + tokens.expiresIn * 1000,
    });
    this.ctx.storage.kv.delete("identity");

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props: { userObjectId: this.ctx.id.toString() } }));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }
      // Auth-only sign-in grants are transient: the caller read the email via complete(), so
      // schedule a prompt self-destruct. We do NOT call a provider revoke endpoint; we just drop
      // our local copy.
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
      }
    }
    return true;
  }

  hasRefreshToken() {
    return this.ctx.storage.kv.get<string>("refreshToken") !== undefined;
  }

  /**
   * Returns a usable access token (refreshing if needed), or null if the credentials are gone or
   * can no longer be refreshed (in which case the workshop is notified via credentialsExpired()).
   */
  async getAccessToken(): Promise<string | null> {
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) return null;

    const cached = this.ctx.storage.kv.get<StoredAccessToken>("accessToken");
    if (cached && cached.expires > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      return cached.token;
    }

    const refreshed = await refreshTokens(this.#config(), refreshToken);
    if (!refreshed) {
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      callback?.credentialsExpired().catch(err =>
        logger.warn("failed to notify credential expiry", {
          event: "credentials.expiry.notify.failed", error: err,
        }));
      return null;
    }
    if (refreshed.refreshToken) {
      this.ctx.storage.kv.put<string>("refreshToken", refreshed.refreshToken);
    }
    const token: StoredAccessToken = {
      token: refreshed.accessToken,
      expires: Date.now() + refreshed.expiresIn * 1000,
    };
    this.ctx.storage.kv.put<StoredAccessToken>("accessToken", token);
    this.ctx.storage.kv.delete("identity");
    return token.token;
  }

  async getIdentity(): Promise<XcityIdentity | null> {
    const token = await this.getAccessToken();
    if (!token) return null;

    const cached = this.ctx.storage.kv.get<StoredIdentity>("identity");
    if (cached && cached.accessToken === token && cached.expires > Date.now()) {
      return cached.identity;
    }

    const identity = await fetchIdentity(this.#authBaseUrl(), token);
    // Only successful lookups are cached. A transient userinfo failure during sign-in must not
    // pin this account to "no identity" for the whole TTL — the caller's retry has to be able to
    // reach the provider again.
    if (identity) {
      this.ctx.storage.kv.put<StoredIdentity>("identity", {
        accessToken: token,
        identity,
        expires: Date.now() + IDENTITY_CACHE_LIFETIME_MS,
      });
    }
    return identity;
  }

  async getTokenhubKey(config: XcityWalletConfig, forceMint = false): Promise<XcityVirtualKeyRecord | null> {
    const identity = await this.getIdentity();
    if (!identity) return null;

    if (!forceMint) {
      const cached = this.ctx.storage.kv.get<XcityVirtualKeyRecord>("tokenhubKey");
      if (cached && cached.walletUrl === config.walletUrl && cached.userId === identity.sub) {
        return cached;
      }
    }

    try {
      const minted = await mintTokenhubKey(config, identity);
      if (!minted) return null;
      this.ctx.storage.kv.put<XcityVirtualKeyRecord>("tokenhubKey", minted);
      return minted;
    } catch (error) {
      logger.warn("xcity wallet key mint request failed", {
        event: "xcity.wallet.key.mint.failed", error,
      });
      return null;
    }
  }

  async alarm(): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login).
    if (!this.hasRefreshToken() || this.ctx.storage.kv.get<boolean>("ephemeral")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
class XcityMediaConfiguratorUI extends RpcTarget implements XcityMediaConfiguratorRpc {
  #resourceUrl: string;

  constructor(resourceUrl: string) {
    super();
    this.#resourceUrl = resourceUrl;
  }

  async getResourceUrl(): Promise<string> {
    return this.#resourceUrl;
  }
}

@validateRpc()
class XcityContextConfiguratorUI extends RpcTarget implements XcityContextConfiguratorRpc {
  #resourceUrl: string;

  constructor(resourceUrl: string) {
    super();
    this.#resourceUrl = resourceUrl;
  }

  async getResourceUrl(): Promise<string> {
    return this.#resourceUrl;
  }
}

/**
 * Deliberately NOT @validateRpc(): the validator's runtime class decorator replaces the exported
 * class, and a durably-stored stub of the replaced class hangs on revival — dispatch never reaches
 * the method and the runtime cancels it ("code had hung"). Config-declared bindings resolve by
 * export name and are unaffected (GatekeeperVendor stays validated), but this class is exactly the
 * one the Workshop stores via allow_irrevocable_stub_storage. Its only caller is the Workshop over
 * typed RPC, so skipping arg validation here is the lesser evil. The Workshop's own undecorated
 * LoginConnectCallbackImpl is the working precedent: stored, revived and called on every sign-in.
 */
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements XcityGatekeeperUser {
  #account() {
    const ns = userAccountNamespace(this.env, this.ctx.exports);
    return ns.get(ns.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#account().getIdentity();
    return {
      displayName: identity?.displayName,
      uniqueName: identity?.email,
      avatar: { url: XCITY_LOGO_URL },
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    const identity = await this.#account().getIdentity();
    return identity?.email ?? null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getUsableAccessToken(): Promise<string | null> {
    return this.#account().getAccessToken();
  }

  async getXcityUserId(): Promise<string | null> {
    const identity = await this.#account().getIdentity();
    return identity?.sub ?? null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    const resources = getXcityResources(this.env);
    if (resources.length === 0) return [];
    // Every Xcity resource authenticates with the same per-user TokenHub virtual key, so one mint
    // check gates them all. Both configs carry the same wallet fields; use whichever is present.
    const keyConfig = readXcityMediaConfig(this.env) ?? readXcityContextConfig(this.env);
    if (!keyConfig) return [];
    const key = await this.#account().getTokenhubKey(keyConfig, false);
    return key ? resources : [];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<XcityMedia>> | DurableObjectClass<Gatekeeper<XcityContext>>;
    resource: SupportedResource;
  }> {
    const requested = stripTrailingSlashes(new URL(url).toString());
    const matchesResource = (resourceUrl: string) =>
      requested === resourceUrl || requested.startsWith(`${resourceUrl}/`);

    const contextConfig = readXcityContextConfig(this.env);
    const contextResource = getContextResource(this.env);
    if (contextConfig && contextResource && matchesResource(xcityContextResourceUrl(contextConfig))) {
      const key = await this.#account().getTokenhubKey(contextConfig, false);
      if (!key) {
        throw new Error("The Xcity context store is unavailable for this account. Reconnect Xcity and retry.");
      }
      return {
        class: this.ctx.exports.XcityContextGatekeeperImpl({ props: { userObjectId: this.ctx.props.userObjectId } }),
        resource: contextResource,
      };
    }

    const config = readXcityMediaConfig(this.env);
    const mediaResource = getMediaResource(this.env);
    if (!config || !mediaResource) {
      throw new Error(contextResource
        ? `Unsupported Xcity resource URL: ${url}`
        : "Xcity media generation is not configured on this deployment.");
    }
    if (!matchesResource(xcityMediaResourceUrl(config))) {
      throw new Error(`Unsupported Xcity resource URL: ${url}`);
    }
    const key = await this.#account().getTokenhubKey(config, false);
    if (!key) {
      throw new Error("Xcity media generation is unavailable for this account. Reconnect Xcity and retry.");
    }
    return {
      class: this.ctx.exports.XcityMediaGatekeeperImpl({ props: { userObjectId: this.ctx.props.userObjectId } }),
      resource: mediaResource,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const mediaResource = getMediaResource(this.env);
    if (mediaResource && resourceUrlPattern === mediaResource.urlPattern) {
      return {
        iframeHtml: XCITY_MEDIA_CONFIGURATOR_HTML,
        ui: new RpcStub(new XcityMediaConfiguratorUI(mediaResource.urlPattern)),
      };
    }
    const contextResource = getContextResource(this.env);
    if (contextResource && resourceUrlPattern === contextResource.urlPattern) {
      return {
        iframeHtml: XCITY_CONTEXT_CONFIGURATOR_HTML,
        ui: new RpcStub(new XcityContextConfiguratorUI(contextResource.urlPattern)),
      };
    }
    throw new Error(`Unsupported Xcity resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /**
   * Mint a verifier representing this account. Xcity media uses low-stakes observer handling:
   * generated URLs are public outputs, and there is no Xcity ACL oracle for generated media.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.XcityVerifier({});
  }
}

type XcityMediaGatekeeperProps = { userObjectId: string };

type StoredGenerateVideoAction = {
  kind: "video";
  mediaId: string;
  options: Required<GenerateVideoOptions>;
  cost?: MediaGenerationCost;
  submittedAt: number;
};

type StoredGenerateImageAction = {
  kind: "image";
  mediaId: string;
  options: Required<GenerateImageOptions>;
  cost?: MediaGenerationCost;
  submittedAt: number;
};

type StoredGenerateAction = StoredGenerateVideoAction | StoredGenerateImageAction;

type StoredVideoFlight = {
  action: StoredGenerateVideoAction;
  providerJobId: string;
  status: "queued" | "in_progress" | "completed";
  progress?: number;
  cost?: MediaGenerationCost;
  startedAt: number;
  updatedAt: number;
  deadlineAt: number;
};

const VIDEO_POLL_INTERVAL_MS = 10 * 1000;
const VIDEO_JOB_DEADLINE_MS = 30 * 60 * 1000;

function resultKey(mediaId: string): string {
  return `media:result:${mediaId}`;
}

function videoFlightKey(mediaId: string): string {
  return `media:video:${mediaId}`;
}

function truncate(value: string, max = 1200): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function formatCost(cost: MediaGenerationCost | undefined): string {
  if (!cost) return "Cost: unavailable.";
  const suffix = cost.source === "estimate" ? " (estimate)" : "";
  return `Cost: $${cost.totalUsd.toFixed(3)} USD${suffix}.`;
}

function videoErrorMessage(job: XcityTokenhubVideoJob): string {
  if (typeof job.error === "string" && job.error) return job.error;
  if (typeof job.error === "object" && job.error?.message) return job.error.message;
  return `Xcity video job ${job.id} failed.`;
}

class PendingMediaActionStore {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #actionKey(id: number): string {
    return `media:pending:action:${id}`;
  }

  #mediaKey(mediaId: string): string {
    return `media:pending:id:${mediaId}`;
  }

  submit(action: Omit<StoredGenerateAction, "mediaId">): { actionId: number; mediaId: string } {
    const actionId = this.#kv.get<number>("media:pending:nextActionId") ?? 1;
    const mediaId = `${action.kind}_${actionId}`;
    const stored = { ...action, mediaId } as StoredGenerateAction;
    this.#kv.put("media:pending:nextActionId", actionId + 1);
    this.#kv.put(this.#actionKey(actionId), stored);
    this.#kv.put(this.#mediaKey(mediaId), actionId);
    return { actionId, mediaId };
  }

  get(actionId: number): StoredGenerateAction | undefined {
    return this.#kv.get<StoredGenerateAction>(this.#actionKey(actionId));
  }

  getByMediaId(mediaId: string): StoredGenerateAction | undefined {
    const actionId = this.#kv.get<number>(this.#mediaKey(mediaId));
    return actionId === undefined ? undefined : this.get(actionId);
  }

  remove(actionId: number): void {
    const action = this.get(actionId);
    this.#kv.delete(this.#actionKey(actionId));
    if (action) this.#kv.delete(this.#mediaKey(action.mediaId));
  }
}

class XcityMediaSessionContext {
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #pending: PendingMediaActionStore;
  readonly #readMedia: (mediaId: string) => GeneratedMedia | undefined;

  constructor(
    approvalQueue: RpcStub<ApprovalQueue>,
    pending: PendingMediaActionStore,
    readMedia: (mediaId: string) => GeneratedMedia | undefined,
  ) {
    this.#approvalQueue = approvalQueue;
    this.#pending = pending;
    this.#readMedia = readMedia;
  }

  async generateVideo(options: GenerateVideoOptions): Promise<GeneratedMedia> {
    const normalized = normalizeVideoOptions(options);
    const cost = estimateSeedanceVideoCost(normalized);
    const submittedAt = Date.now();
    const { actionId, mediaId } = this.#pending.submit({
      kind: "video",
      options: normalized,
      ...(cost ? { cost } : {}),
      submittedAt,
    });
    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Generate Xcity video",
        description:
            "Generate a Seedance video through Xcity TokenHub and archive the finished MP4 to R2.\n\n" +
            `Model: \`${normalized.model}\`\n\n` +
            `Resolution: \`${normalized.resolution}\`, ratio: \`${normalized.ratio}\`, duration: ` +
            `\`${normalized.seconds}s\`\n\n` +
            `${formatCost(cost)}\n\n` +
            `Prompt:\n\n${truncate(normalized.prompt)}`,
        implementsRevert: false,
        awaitDecision: true,
        actionKind: { tag: "xcity.media.generate.video", label: "Generate Xcity video" },
      });
    } catch (error) {
      this.#pending.remove(actionId);
      throw error;
    }
    return pendingGeneratedMedia("video", mediaId, cost, () => submittedAt);
  }

  async generateImage(options: GenerateImageOptions): Promise<GeneratedMedia> {
    const normalized = normalizeImageOptions(options);
    const submittedAt = Date.now();
    const { actionId, mediaId } = this.#pending.submit({
      kind: "image",
      options: normalized,
      submittedAt,
    });
    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Generate Xcity image",
        description:
            "Generate a Seedream image through Xcity TokenHub and archive the image bytes to R2.\n\n" +
            `Model: \`${normalized.model}\`\n\n` +
            `Size: \`${normalized.size}\`\n\n` +
            "Cost: unavailable unless TokenHub reports it after generation.\n\n" +
            `Prompt:\n\n${truncate(normalized.prompt)}`,
        implementsRevert: false,
        awaitDecision: true,
        actionKind: { tag: "xcity.media.generate.image", label: "Generate Xcity image" },
      });
    } catch (error) {
      this.#pending.remove(actionId);
      throw error;
    }
    return pendingGeneratedMedia("image", mediaId, undefined, () => submittedAt);
  }

  async getGeneration(mediaId: string): Promise<GeneratedMedia> {
    const media = this.#readMedia(mediaId);
    if (!media) throw new Error(`Unknown Xcity media generation id: ${mediaId}`);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Xcity media generation",
      description: `Read status and output metadata for Xcity media generation \`${mediaId}\`.`,
    });
    return media;
  }
}

@validateRpc()
class XcityMediaSessionImpl extends RpcTarget implements XcityMedia {
  #context: XcityMediaSessionContext;

  constructor(context: XcityMediaSessionContext) {
    super();
    this.#context = context;
  }

  generateVideo(options: GenerateVideoOptions): Promise<GeneratedMedia> {
    return this.#context.generateVideo(options);
  }

  generateImage(options: GenerateImageOptions): Promise<GeneratedMedia> {
    return this.#context.generateImage(options);
  }

  getGeneration(id: string): Promise<GeneratedMedia> {
    return this.#context.getGeneration(id);
  }
}

@validateRpc()
export class XcityMediaGatekeeperImpl extends DurableObject<Env, XcityMediaGatekeeperProps>
    implements Gatekeeper<XcityMedia> {
  #userAccount() {
    const ns = userAccountNamespace(this.env, this.ctx.exports);
    return ns.get(ns.idFromString(this.ctx.props.userObjectId));
  }

  #mediaConfig(): XcityMediaConfig {
    const config = readXcityMediaConfig(this.env);
    if (!config) throw new Error("Xcity media generation is not configured on this deployment.");
    return config;
  }

  async #getTokenhubKey(forceMint = false): Promise<string> {
    const record = await this.#userAccount().getTokenhubKey(this.#mediaConfig(), forceMint);
    if (!record) {
      throw new Error("Xcity media generation is unavailable for this account. Reconnect Xcity and retry.");
    }
    const { key } = record;
    return key;
  }

  async #withTokenhubKey<T>(fn: (apiKey: string) => Promise<T>): Promise<T> {
    const initialKey = await this.#getTokenhubKey(false);
    try {
      return await fn(initialKey);
    } catch (error) {
      if (!(error instanceof XcityMediaApiError) || !error.isAuthError) throw error;
    }
    const freshKey = await this.#getTokenhubKey(true);
    return await fn(freshKey);
  }

  #pending(): PendingMediaActionStore {
    return new PendingMediaActionStore(this.ctx.storage.kv);
  }

  #storeResult(result: GeneratedMedia): void {
    this.ctx.storage.kv.put(resultKey(result.id), result);
  }

  #failedResult(action: StoredGenerateAction, error: unknown, providerJobId?: string): GeneratedMedia {
    return {
      id: action.mediaId,
      kind: action.kind,
      status: "failed",
      archived: false,
      ...(action.cost ? { cost: action.cost } : {}),
      ...(providerJobId ? { providerJobId } : {}),
      error: error instanceof Error ? error.message : String(error),
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(),
    };
  }

  #processingResult(flight: StoredVideoFlight): GeneratedMedia {
    return {
      id: flight.action.mediaId,
      kind: "video",
      status: "processing",
      archived: false,
      providerJobId: flight.providerJobId,
      ...(flight.progress !== undefined ? { progress: flight.progress } : {}),
      ...(flight.cost ?? flight.action.cost ? { cost: flight.cost ?? flight.action.cost } : {}),
      createdAt: new Date(flight.action.submittedAt),
      updatedAt: new Date(flight.updatedAt),
    };
  }

  #readMedia(mediaId: string): GeneratedMedia | undefined {
    const result = this.ctx.storage.kv.get<GeneratedMedia>(resultKey(mediaId));
    if (result) return result;
    const flight = this.ctx.storage.kv.get<StoredVideoFlight>(videoFlightKey(mediaId));
    if (flight) return this.#processingResult(flight);
    const action = this.#pending().getByMediaId(mediaId);
    if (action) return pendingGeneratedMedia(action.kind, mediaId, action.cost, () => action.submittedAt);
    return undefined;
  }

  #setVideoAlarm(): void {
    this.ctx.storage.setAlarm(Date.now() + VIDEO_POLL_INTERVAL_MS);
  }

  async #completeVideo(
    action: StoredGenerateVideoAction,
    apiKey: string,
    job: XcityTokenhubVideoJob,
    cost: MediaGenerationCost | undefined,
  ): Promise<void> {
    if (!job.output_url) {
      throw new Error(`Completed Xcity video job ${job.id} did not include output_url.`);
    }
    const result = await archiveVideoOrTemporary(
      this.#mediaConfig(),
      apiKey,
      action.mediaId,
      job.output_url,
      {
        id: action.mediaId,
        kind: "video",
        ...(cost ? { cost } : {}),
        providerJobId: job.id,
        createdAt: new Date(action.submittedAt),
      },
    );
    this.#storeResult(result);
    this.ctx.storage.kv.delete(videoFlightKey(action.mediaId));
  }

  async #startVideo(action: StoredGenerateVideoAction): Promise<void> {
    await this.#withTokenhubKey(async apiKey => {
      const created = await createVideoJob(this.#mediaConfig(), apiKey, action.options);
      const cost = extractTokenhubCost(created.raw) ?? created.cost ?? action.cost;
      if (created.status === "failed") throw new Error(videoErrorMessage(created));
      if (created.status === "completed" && created.output_url) {
        await this.#completeVideo(action, apiKey, created, cost);
        return;
      }

      const now = Date.now();
      const flight: StoredVideoFlight = {
        action,
        providerJobId: created.id,
        status: created.status === "completed" ? "completed" : created.status,
        ...(created.progress !== undefined ? { progress: created.progress } : {}),
        ...(cost ? { cost } : {}),
        startedAt: now,
        updatedAt: now,
        deadlineAt: now + VIDEO_JOB_DEADLINE_MS,
      };
      this.ctx.storage.kv.put(videoFlightKey(action.mediaId), flight);
      this.#setVideoAlarm();
    });
  }

  async #applyImage(action: StoredGenerateImageAction): Promise<void> {
    const created = await this.#withTokenhubKey(async apiKey => {
      const image = await createImage(this.#mediaConfig(), apiKey, action.options);
      return { apiKey, image };
    });
    const cost = created.image.cost;
    try {
      const result = await archiveImageOrTemporary(
        this.#mediaConfig(),
        created.apiKey,
        created.image.image,
        {
          id: action.mediaId,
          kind: "image",
          ...(cost ? { cost } : {}),
          createdAt: new Date(action.submittedAt),
        },
      );
      this.#storeResult(result);
    } catch (error) {
      this.#storeResult(this.#failedResult({ ...action, ...(cost ? { cost } : {}) }, error));
    }
  }

  async #pollVideoFlight(flight: StoredVideoFlight): Promise<boolean> {
    if (Date.now() >= flight.deadlineAt) {
      this.#storeResult(this.#failedResult(
        flight.action,
        new Error("Xcity video generation did not finish within the 30 minute polling window."),
        flight.providerJobId,
      ));
      this.ctx.storage.kv.delete(videoFlightKey(flight.action.mediaId));
      return false;
    }

    try {
      await this.#withTokenhubKey(async apiKey => {
        const job = await retrieveVideoJob(this.#mediaConfig(), apiKey, flight.providerJobId);
        const cost = extractTokenhubCost(job.raw) ?? job.cost ?? flight.cost ?? flight.action.cost;
        if (job.status === "failed") {
          this.#storeResult(this.#failedResult({ ...flight.action, ...(cost ? { cost } : {}) }, videoErrorMessage(job), job.id));
          this.ctx.storage.kv.delete(videoFlightKey(flight.action.mediaId));
          return;
        }
        if (job.status === "completed" && job.output_url) {
          await this.#completeVideo(flight.action, apiKey, job, cost);
          return;
        }
        const next: StoredVideoFlight = {
          ...flight,
          status: job.status === "completed" ? "completed" : job.status,
          ...(job.progress !== undefined ? { progress: job.progress } : {}),
          ...(cost ? { cost } : {}),
          updatedAt: Date.now(),
        };
        this.ctx.storage.kv.put(videoFlightKey(flight.action.mediaId), next);
      });
    } catch (error) {
      logger.warn("xcity video polling attempt failed", {
        event: "xcity.media.video.poll.failed",
        mediaId: flight.action.mediaId,
        providerJobId: flight.providerJobId,
        error,
      });
      const next: StoredVideoFlight = { ...flight, updatedAt: Date.now() };
      this.ctx.storage.kv.put(videoFlightKey(flight.action.mediaId), next);
    }
    return this.ctx.storage.kv.get<StoredVideoFlight>(videoFlightKey(flight.action.mediaId)) !== undefined;
  }

  async describe(): Promise<ResourceDescription> {
    const config = this.#mediaConfig();
    return {
      url: xcityMediaResourceUrl(config),
      title: "Xcity Media",
      snippet: "Generate videos and images through Xcity TokenHub with permanent R2 archival.",
      suggestedBindingName: "XCITY_MEDIA",
      tsType: "XcityMedia",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<XcityMedia> {
    return new XcityMediaSessionImpl(new XcityMediaSessionContext(
      approvalQueue.dup(),
      this.#pending(),
      mediaId => this.#readMedia(mediaId),
    ));
  }

  async applyAction(actionId: number): Promise<void> {
    const pending = this.#pending();
    const action = pending.get(actionId);
    if (!action) throw new Error(`Unknown pending Xcity media action: ${actionId}`);
    if (action.kind === "video") {
      await this.#startVideo(action);
    } else {
      await this.#applyImage(action);
    }
    pending.remove(actionId);
  }

  async rejectAction(actionId: number): Promise<void> {
    this.#pending().remove(actionId);
  }

  async revertAction(_action: number): Promise<{ message: string }> {
    return {
      message:
          "Generated Xcity media cannot be reverted automatically. Delete the archived R2 object " +
          "manually from the media worker storage if it must be removed.",
    };
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async alarm(): Promise<void> {
    let stillPolling = false;
    for (const [, flight] of this.ctx.storage.kv.list<StoredVideoFlight>({ prefix: "media:video:" })) {
      if (await this.#pollVideoFlight(flight)) stillPolling = true;
    }
    if (stillPolling) this.#setVideoAlarm();
  }
}

// =======================================================================================
// Xcity context store resource

type XcityContextGatekeeperProps = { userObjectId: string };

type StoredContextCreateAction = {
  kind: "create";
  writeId: string;
  options: SaveContextDocumentOptions;
  submittedAt: number;
};

type StoredContextUpdateAction = {
  kind: "update";
  writeId: string;
  contextId: string;
  options: UpdateContextDocumentOptions;
  submittedAt: number;
};

type StoredContextDeleteAction = {
  kind: "delete";
  writeId: string;
  contextId: string;
  submittedAt: number;
};

type StoredContextAction =
  | StoredContextCreateAction
  | StoredContextUpdateAction
  | StoredContextDeleteAction;

// Omit that distributes over the union so each member keeps its own fields (plain Omit would
// reduce the union to its common keys, dropping contextId/options).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function contextResultKey(writeId: string): string {
  return `context:result:${writeId}`;
}

class PendingContextActionStore {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #actionKey(id: number): string {
    return `context:pending:action:${id}`;
  }

  #writeKey(writeId: string): string {
    return `context:pending:id:${writeId}`;
  }

  submit(action: DistributiveOmit<StoredContextAction, "writeId">): { actionId: number; writeId: string } {
    const actionId = this.#kv.get<number>("context:pending:nextActionId") ?? 1;
    const writeId = `${action.kind}_${actionId}`;
    const stored = { ...action, writeId } as StoredContextAction;
    this.#kv.put("context:pending:nextActionId", actionId + 1);
    this.#kv.put(this.#actionKey(actionId), stored);
    this.#kv.put(this.#writeKey(writeId), actionId);
    return { actionId, writeId };
  }

  get(actionId: number): StoredContextAction | undefined {
    return this.#kv.get<StoredContextAction>(this.#actionKey(actionId));
  }

  getByWriteId(writeId: string): StoredContextAction | undefined {
    const actionId = this.#kv.get<number>(this.#writeKey(writeId));
    return actionId === undefined ? undefined : this.get(actionId);
  }

  remove(actionId: number): void {
    const action = this.get(actionId);
    this.#kv.delete(this.#actionKey(actionId));
    if (action) this.#kv.delete(this.#writeKey(action.writeId));
  }
}

class XcityContextSessionContext {
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #pending: PendingContextActionStore;
  readonly #readWrite: (writeId: string) => XcityContextWrite | undefined;
  readonly #withKey: <T>(fn: (apiKey: string) => Promise<T>) => Promise<T>;
  readonly #config: XcityContextConfig;

  constructor(
    approvalQueue: RpcStub<ApprovalQueue>,
    pending: PendingContextActionStore,
    readWrite: (writeId: string) => XcityContextWrite | undefined,
    withKey: <T>(fn: (apiKey: string) => Promise<T>) => Promise<T>,
    config: XcityContextConfig,
  ) {
    this.#approvalQueue = approvalQueue;
    this.#pending = pending;
    this.#readWrite = readWrite;
    this.#withKey = withKey;
    this.#config = config;
  }

  async listDocuments(options?: ListContextDocumentsOptions): Promise<XcityContextDocumentList> {
    await this.#approvalQueue.authorizeObservation({
      title: "List Xcity context documents",
      description:
          "Read document titles, content previews, and tags from the user's shared Xcity context store.",
    });
    return this.#withKey(apiKey => listContextDocuments(this.#config, apiKey, options));
  }

  async getDocument(contextId: string): Promise<XcityContextDocument> {
    const id = assertContextId(contextId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Xcity context document",
      description: `Read the full content of Xcity context document \`${id}\`.`,
    });
    return this.#withKey(apiKey => getContextDocument(this.#config, apiKey, id));
  }

  async #submitWrite(
    action: DistributiveOmit<StoredContextAction, "writeId">,
    description: { title: string; description: string; tag: string },
  ): Promise<XcityContextWrite> {
    const { actionId, writeId } = this.#pending.submit(action);
    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: description.title,
        description: description.description,
        implementsRevert: false,
        awaitDecision: true,
        actionKind: { tag: description.tag, label: description.title },
      });
    } catch (error) {
      this.#pending.remove(actionId);
      throw error;
    }
    return pendingContextWrite(
      action.kind,
      writeId,
      action.kind === "create" ? undefined : action.contextId,
      () => action.submittedAt,
    );
  }

  async saveDocument(options: SaveContextDocumentOptions): Promise<XcityContextWrite> {
    const normalized = normalizeSaveContextOptions(options);
    return this.#submitWrite(
      { kind: "create", options: normalized, submittedAt: Date.now() },
      {
        title: "Save Xcity context document",
        description:
            "Create a new document in the user's shared Xcity context store.\n\n" +
            `Title: ${normalized.title}\n\n` +
            (normalized.tags?.length ? `Tags: ${normalized.tags.join(", ")}\n\n` : "") +
            `Content:\n\n${truncate(normalized.content)}`,
        tag: "xcity.context.save",
      },
    );
  }

  async updateDocument(
    contextId: string, options: UpdateContextDocumentOptions,
  ): Promise<XcityContextWrite> {
    const id = assertContextId(contextId);
    const normalized = normalizeUpdateContextOptions(options);
    return this.#submitWrite(
      { kind: "update", contextId: id, options: normalized, submittedAt: Date.now() },
      {
        title: "Update Xcity context document",
        description:
            `Update Xcity context document \`${id}\`.\n\n` +
            `Changed fields: ${Object.keys(normalized).join(", ")}\n\n` +
            (normalized.title !== undefined ? `New title: ${normalized.title}\n\n` : "") +
            (normalized.content !== undefined ? `New content:\n\n${truncate(normalized.content)}` : ""),
        tag: "xcity.context.update",
      },
    );
  }

  async deleteDocument(contextId: string): Promise<XcityContextWrite> {
    const id = assertContextId(contextId);
    return this.#submitWrite(
      { kind: "delete", contextId: id, submittedAt: Date.now() },
      {
        title: "Delete Xcity context document",
        description: `Permanently delete Xcity context document \`${id}\` from the shared store.`,
        tag: "xcity.context.delete",
      },
    );
  }

  async getWrite(id: string): Promise<XcityContextWrite> {
    const write = this.#readWrite(id);
    if (!write) throw new Error(`Unknown Xcity context write id: ${id}`);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Xcity context write status",
      description: `Read the status and outcome of Xcity context write \`${id}\`.`,
    });
    return write;
  }
}

@validateRpc()
class XcityContextSessionImpl extends RpcTarget implements XcityContext {
  #context: XcityContextSessionContext;

  constructor(context: XcityContextSessionContext) {
    super();
    this.#context = context;
  }

  listDocuments(options?: ListContextDocumentsOptions): Promise<XcityContextDocumentList> {
    return this.#context.listDocuments(options);
  }

  getDocument(contextId: string): Promise<XcityContextDocument> {
    return this.#context.getDocument(contextId);
  }

  saveDocument(options: SaveContextDocumentOptions): Promise<XcityContextWrite> {
    return this.#context.saveDocument(options);
  }

  updateDocument(contextId: string, options: UpdateContextDocumentOptions): Promise<XcityContextWrite> {
    return this.#context.updateDocument(contextId, options);
  }

  deleteDocument(contextId: string): Promise<XcityContextWrite> {
    return this.#context.deleteDocument(contextId);
  }

  getWrite(id: string): Promise<XcityContextWrite> {
    return this.#context.getWrite(id);
  }
}

@validateRpc()
export class XcityContextGatekeeperImpl extends DurableObject<Env, XcityContextGatekeeperProps>
    implements Gatekeeper<XcityContext> {
  #userAccount() {
    const ns = userAccountNamespace(this.env, this.ctx.exports);
    return ns.get(ns.idFromString(this.ctx.props.userObjectId));
  }

  #contextConfig(): XcityContextConfig {
    const config = readXcityContextConfig(this.env);
    if (!config) throw new Error("The Xcity context store is not configured on this deployment.");
    return config;
  }

  async #getTokenhubKey(forceMint: boolean): Promise<string> {
    const record = await this.#userAccount().getTokenhubKey(this.#contextConfig(), forceMint);
    if (!record) {
      throw new Error("The Xcity context store is unavailable for this account. Reconnect Xcity and retry.");
    }
    const { key } = record;
    return key;
  }

  // Shared key mint/refresh with the media path (UserAccount.getTokenhubKey), but retries only on
  // 401: for the context store, 403 means "not your document" and a fresh key cannot fix it.
  #withTokenhubKey<T>(fn: (apiKey: string) => Promise<T>): Promise<T> {
    return withContextKeyRetry(forceMint => this.#getTokenhubKey(forceMint), fn);
  }

  #pending(): PendingContextActionStore {
    return new PendingContextActionStore(this.ctx.storage.kv);
  }

  #storeResult(result: XcityContextWrite): void {
    this.ctx.storage.kv.put(contextResultKey(result.id), result);
  }

  #failedWrite(action: StoredContextAction, error: unknown): XcityContextWrite {
    return {
      id: action.writeId,
      kind: action.kind,
      status: "failed",
      ...(action.kind !== "create" ? { contextId: action.contextId } : {}),
      error: error instanceof Error ? error.message : String(error),
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(),
    };
  }

  #readWrite(writeId: string): XcityContextWrite | undefined {
    const result = this.ctx.storage.kv.get<XcityContextWrite>(contextResultKey(writeId));
    if (result) return result;
    const action = this.#pending().getByWriteId(writeId);
    if (action) {
      return pendingContextWrite(
        action.kind,
        writeId,
        action.kind === "create" ? undefined : action.contextId,
        () => action.submittedAt,
      );
    }
    return undefined;
  }

  async #performWrite(action: StoredContextAction): Promise<XcityContextWrite> {
    const createdAt = new Date(action.submittedAt);
    switch (action.kind) {
      case "create": {
        const document = await this.#withTokenhubKey(apiKey =>
          createContextDocument(this.#contextConfig(), apiKey, action.options));
        return {
          id: action.writeId,
          kind: "create",
          status: "completed",
          contextId: document.contextId,
          document,
          createdAt,
          updatedAt: new Date(),
        };
      }
      case "update": {
        const document = await this.#withTokenhubKey(apiKey =>
          updateContextDocument(this.#contextConfig(), apiKey, action.contextId, action.options));
        return {
          id: action.writeId,
          kind: "update",
          status: "completed",
          contextId: action.contextId,
          ...(document ? { document } : {}),
          createdAt,
          updatedAt: new Date(),
        };
      }
      case "delete": {
        await this.#withTokenhubKey(apiKey =>
          deleteContextDocument(this.#contextConfig(), apiKey, action.contextId));
        return {
          id: action.writeId,
          kind: "delete",
          status: "completed",
          contextId: action.contextId,
          createdAt,
          updatedAt: new Date(),
        };
      }
    }
  }

  async describe(): Promise<ResourceDescription> {
    const config = this.#contextConfig();
    return {
      url: xcityContextResourceUrl(config),
      title: "Xcity Context",
      snippet: "Read and write the user's shared Xcity context documents (cross-product context store).",
      suggestedBindingName: "XCITY_CONTEXT",
      tsType: "XcityContext",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<XcityContext> {
    return new XcityContextSessionImpl(new XcityContextSessionContext(
      approvalQueue.dup(),
      this.#pending(),
      writeId => this.#readWrite(writeId),
      fn => this.#withTokenhubKey(fn),
      this.#contextConfig(),
    ));
  }

  async applyAction(actionId: number): Promise<void> {
    const pending = this.#pending();
    const action = pending.get(actionId);
    if (!action) throw new Error(`Unknown pending Xcity context action: ${actionId}`);
    try {
      this.#storeResult(await this.#performWrite(action));
    } catch (error) {
      // Store the failure as the write's outcome so the agent's getWrite() sees a clean message,
      // mirroring the media image path.
      this.#storeResult(this.#failedWrite(action, error));
    }
    pending.remove(actionId);
  }

  async rejectAction(actionId: number): Promise<void> {
    this.#pending().remove(actionId);
  }

  async revertAction(_action: number): Promise<{ message: string }> {
    return {
      message:
          "Xcity context writes cannot be reverted automatically. Edit or restore the document " +
          "through another update if the change must be undone.",
    };
  }

  /**
   * Context documents read into a shared gadget are already visible to its collaborators, and
   * tokenhub scopes documents to the connected user/team with no finer per-collaborator ACL to
   * consult, so this mirrors the media resource's low-stakes observer handling.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}
}

// Xcity media output URLs are public once generated, and there is no per-collaborator Xcity ACL to
// query for a generated output. Sharing uses the low-stakes observer strategy.
@validateRpc()
export class XcityVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}
