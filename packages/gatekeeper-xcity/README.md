# Gatekeeper Xcity

This package provides Xcity OAuth / OIDC sign-in for Gadgets via xct-auth
(`https://auth.xcity.ai` by default).

For Phase 1 it provides authentication only:

- **Sign-in:** when `xcity` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  Xcity" appears on the login page. Sign-in requests `openid email profile` and accepts only a
  provider-verified email from `/oauth/userinfo`.
- **Workshop-only account access:** the connected account exposes a refreshed GoTrue access token
  (`getUsableAccessToken`) and GoTrue user id (`getXcityUserId`) for later Xcity wallet/tokenhub
  integration. These are not exposed to gadgets or agents in Phase 1.

Resource capabilities for gadgets/agents will be added later.

## Setting Up Xcity OAuth Credentials

Register a GoTrue OAuth client in xct-auth with the gatekeeper redirect URI:

```
${PUBLIC_BASE_URL}/gatekeeper/xcity/oauth
```

For production at `https://os.xcity.ai`, register:

```
https://os.xcity.ai/gatekeeper/xcity/oauth
```

For local dev, the default redirect URI is:

```
http://localhost:8787/gatekeeper/xcity/oauth
```

## Gatekeeper Worker Configuration

Set these secrets on the **gatekeeper Worker**:

```bash
CLIENT_ID=your-xcity-oauth-client-id
CLIENT_SECRET=your-xcity-oauth-client-secret
```

Optional vars:

```bash
XCITY_AUTH_URL=https://auth.xcity.ai
BASE_URL=https://os.xcity.ai/gatekeeper/xcity
```

`XCITY_AUTH_URL` may point at a staging xct-auth deployment. If omitted, the gatekeeper uses
`https://auth.xcity.ai`.

## Enable Sign-In

On the backend deployment, allow Xcity as an authentication gatekeeper:

```bash
AUTH_GATEKEEPERS=xcity
```

To hide username/password login and offer only SSO:

```bash
DISABLE_PASSWORD_AUTH=true
```

## Local Dev

Set the shared OAuth credentials in your shell or root `.dev.vars` before running the dev server:

```bash
XCITY_CLIENT_ID=your-xcity-oauth-client-id
XCITY_CLIENT_SECRET=your-xcity-oauth-client-secret
AUTH_GATEKEEPERS=xcity
```

`run-dev-server.js` seeds those into the gatekeeper Worker as `CLIENT_ID` / `CLIENT_SECRET`.

## Logo

`src/xcity-logo.svg` is a hand-written vector placeholder: a clean X mark on a dark field. Replace
it with the final Xcity identity asset when the production brand mark is ready.
