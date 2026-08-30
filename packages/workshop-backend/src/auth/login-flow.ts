// Sign-in via authentication gatekeepers.
//
// Unlike the normal connect-account flow (which runs for an already-logged-in user), login happens
// before we know who the user is. The PublicApi starts a gatekeeper connect flow (in "auth" scope
// mode) with a `LoginConnectCallbackImpl` as the callback and a `PendingLogin` DO to bridge the
// result back to the waiting browser:
//
//   1. PublicApi.startGatekeeperLogin(vendorId) creates a PendingLogin DO (keyed by a random DO id),
//      hands the gatekeeper a LoginConnectCallbackImpl, and returns {url, attempt}, where `attempt`
//      is an RpcStub wrapping the DO (so the client awaits via a capability, never a guessable id).
//   2. The browser opens `url` (the gatekeeper's self-closing OAuth popup) and calls
//      `attempt.wait()`, which blocks on the PendingLogin DO.
//   3. When the gatekeeper finishes, it calls LoginConnectCallbackImpl.complete(user). We read the
//      verified email, resolve/create the email-keyed user DO, mint a session, and deliver the token
//      to the PendingLogin DO, which resolves the awaiting RPC.
//
// Sign-in usually requests minimal scopes and the gatekeeper grant is transient (it self-destructs
// shortly after we read the email), so login does not create a persistent connected account.
// Cloudflare and Xcity are exceptions because their billing gates need a reusable user token; the
// PublicApi requests their full non-transient scopes, and the callback persists the grant here.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { GatekeeperConnectCallback, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type { XcityGatekeeperUser } from "@gadgets/workshop-shared/xcity-gatekeeper";
import { createWorkshopLogger } from "../observability";
import { CLOUDFLARE_VENDOR_ID } from "../user.js";
import { readAdminConfig } from "../admin-config.js";
import { XCITY_VENDOR_ID } from "../xcity/model-plane.js";

const logger = createWorkshopLogger("workshop.auth");

type PendingResult = { token: string } | { error: string };

/**
 * Bridges a login result from the (separate) OAuth-callback invocation back to the waiting browser.
 *
 * This DO holds no durable storage: a login normally completes within seconds, and the in-flight
 * awaitResult() request keeps the DO alive so the in-memory waiter is reachable when deliver()/fail()
 * fire. If the attempt is abandoned, the client disposes the awaiting RPC (the `attempt` stub) and
 * the DO is simply evicted — no alarm or cleanup needed.
 */
export class PendingLogin extends DurableObject<Cloudflare.Env> {
  // Awaiters from in-flight awaitResult() calls, resolved/rejected when the result arrives.
  #waiters: { resolve: (token: string) => void; reject: (err: Error) => void }[] = [];
  // Stash for the rare case deliver()/fail() arrives before awaitResult() registers a waiter.
  #result?: PendingResult;

  /** Block until the login completes (or fails). */
  async awaitResult(): Promise<string> {
    if (this.#result) {
      const result = this.#result;
      this.#result = undefined;  // one-time use
      if ("token" in result) return result.token;
      throw new Error(result.error);
    }
    return await new Promise<string>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /**
   * Called by LoginConnectCallbackImpl on success: resolve the awaiter (or stash the token if none
   * is waiting yet).
   */
  async deliver(token: string): Promise<void> {
    if (this.#waiters.length > 0) {
      for (const w of this.#waiters) w.resolve(token);
      this.#waiters = [];
    } else {
      this.#result = { token };
    }
  }

  async fail(reason: string): Promise<void> {
    if (this.#waiters.length > 0) {
      for (const w of this.#waiters) w.reject(new Error(reason));
      this.#waiters = [];
    } else {
      this.#result = { error: reason };
    }
  }
}

type LoginCallbackProps = { pendingId: string; vendorId: string };

export class LoginConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, LoginCallbackProps>
    implements GatekeeperConnectCallback {
  #pending() {
    const id = this.ctx.exports.PendingLogin.idFromString(this.ctx.props.pendingId);
    return this.ctx.exports.PendingLogin.get(id);
  }

  async complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    const loginLogger = logger.with({
      operation: "gatekeeper.login",
      vendorId: this.ctx.props.vendorId,
    });
    const pending = this.#pending();
    // `account` is a call parameter, so Cap'n Web disposes it automatically when this method
    // returns — no explicit disposal needed. We read the verified email to resolve/create the user.
    // The email's local-part seeds the initial display name, like the Cloudflare Access flow.
    try {
      const email = await account.getAuthenticatedEmail();
      if (!email) {
        loginLogger.info("gatekeeper login finished", {
          event: "gatekeeper.login.finished", outcome: "no_email",
        });
        await pending.fail("This account has no verified email, so it can't be used to sign in.");
        return;
      }
      const userStub = this.ctx.exports.UserDurableObject.get(
          this.ctx.exports.UserDurableObject.idFromName(email));
      // Closed signups block first-time account creation here too (not just password signup); an
      // existing user signing in is unaffected.
      const signupsEnabled = (await readAdminConfig(this.env)).signupsEnabled;
      const secret = await userStub.loginOrCreateViaGatekeeper(email, signupsEnabled);
      if (secret === null) {
        loginLogger.info("gatekeeper login finished", {
          event: "gatekeeper.login.finished", outcome: "signups_disabled",
        });
        await pending.fail("New sign-ups are currently disabled on this deployment.");
        return;
      }
      // For billing-aware providers, signing in also links the account: startGatekeeperLogin
      // requested full (non-transient) scopes, so persist the grant before handing back the session.
      if (this.ctx.props.vendorId === CLOUDFLARE_VENDOR_ID) {
        await userStub.linkConnectedAccountFromLogin(account, this.ctx.props.vendorId, expiresAt);
      } else if (this.ctx.props.vendorId === XCITY_VENDOR_ID) {
        await userStub.linkConnectedAccountFromLogin(account, this.ctx.props.vendorId, expiresAt);
        const xcityUserId =
            await (account as unknown as Fetcher<XcityGatekeeperUser>).getXcityUserId();
        if (xcityUserId) {
          await userStub.setXcityIdentity({ userId: xcityUserId, email });
          // Prewarm the model plane and agent catalog off the login path, so the frontend's
          // first model/agent listing after sign-in is served from a warm cache instead of a
          // possibly cold-starting tokenhub/wallet. Best-effort fire-and-forget.
          this.ctx.waitUntil(userStub.prewarmXcityModelPlane().catch((err: unknown) => {
            loginLogger.warn("xcity login prewarm failed", {
              event: "xcity.login.prewarm.failed", error: err,
            });
          }));
        } else {
          loginLogger.warn("xcity login had no user id", {
            event: "xcity.login.user.id.missing",
          });
        }
      }
      // Session tokens are "<doName>:<secret>"; PublicApi.authenticate() routes via idFromName of
      // the first part. The user DO is keyed by email, so the prefix must be the email.
      await pending.deliver(`${email}:${secret}`);
      loginLogger.info("gatekeeper login finished", {
        event: "gatekeeper.login.finished", outcome: "ok",
      });
    } catch (err) {
      loginLogger.error("gatekeeper login failed", {
        event: "gatekeeper.login.failed", error: err,
      });
      loginLogger.info("gatekeeper login finished", {
        event: "gatekeeper.login.finished", outcome: "error",
      });
      await pending.fail("Sign-in failed. Please try again.");
    }
  }

  /**
   * No-ops: for transient sign-in grants there's nothing persisted to update. For the Cloudflare
   * billing connection (persisted on login) these would ideally flip the account's credential flag,
   * but the callback doesn't carry the user/account identity (it's only learned in complete()). The
   * billing path degrades gracefully regardless — getUsableAccessToken() returns null on expiry and
   * the user falls back to the free tier / a reconnect prompt.
   */
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(_expiresAt?: Date): Promise<void> {}
}
