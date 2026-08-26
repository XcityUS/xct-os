// Minimal OAuth 2.1 / OIDC (authorization-code + PKCE) client for Xcity auth. The token endpoint
// expects client credentials via HTTP Basic auth; PKCE binds the redeemed code to a short-lived
// verifier stored in the UserAccount DO.

const DEFAULT_AUTH_BASE = "https://auth.xcity.ai";

// Scopes for sign-in and the future Xcity capability flow. Xcity wallet/tokenhub authorization is
// not OAuth-scope gated in Phase 1, so auth and full grants intentionally match for now.
export const FULL_SCOPES = [
  "openid",
  "email",
  "profile",
];

export const AUTH_SCOPES = [
  "openid",
  "email",
  "profile",
];

export interface XcityOAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

export function getAuthBaseUrl(authBaseUrl: string | undefined): string {
  return (authBaseUrl || DEFAULT_AUTH_BASE).replace(/\/+$/, "");
}

// Build the OAuth config from the gatekeeper's env. `redirectUri` is the gatekeeper's own /oauth
// endpoint. Returns null if the client credentials aren't configured.
export function getOAuthConfig(
  clientId: string | undefined, clientSecret: string | undefined, baseUrl: string,
  authBaseUrl?: string,
): XcityOAuthConfig | null {
  if (!clientId || !clientSecret) return null;
  const authBase = getAuthBaseUrl(authBaseUrl);
  return {
    clientId,
    clientSecret,
    authUrl: `${authBase}/oauth/authorize`,
    tokenUrl: `${authBase}/oauth/token`,
    redirectUri: `${baseUrl}/oauth`,
  };
}

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Generate a PKCE verifier and its S256 challenge.
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64urlEncode(digest) };
}

export function buildAuthorizeUrl(
  config: XcityOAuthConfig, state: string, challenge: string, scopes: string[],
): string {
  const url = new URL(config.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType?: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

function basicAuth(config: XcityOAuthConfig): string {
  return "Basic " + btoa(`${config.clientId}:${config.clientSecret}`);
}

// Exchange an authorization code (with its PKCE verifier) for tokens.
export async function exchangeCode(
  config: XcityOAuthConfig, code: string, verifier: string,
): Promise<TokenResponse | null> {
  return redeem(config, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  }));
}

/** Refresh an access token using a refresh token. */
export async function refreshTokens(
  config: XcityOAuthConfig, refreshToken: string,
): Promise<TokenResponse | null> {
  return redeem(config, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
}

async function redeem(config: XcityOAuthConfig, body: URLSearchParams): Promise<TokenResponse | null> {
  const resp = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": basicAuth(config),
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body,
  });
  if (!resp.ok) {
    resp.body?.cancel();
    return null;
  }
  const data = await resp.json() as RawTokenResponse;
  if (!data.access_token) return null;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
    tokenType: data.token_type,
  };
}
