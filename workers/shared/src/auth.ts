import { ApiError } from "./http";

interface AccessHeader {
  alg?: unknown;
  kid?: unknown;
}

interface AccessClaims {
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
}

interface JwkSet {
  keys?: AccessJwk[];
}

interface AccessJwk extends JsonWebKey {
  kid?: string;
}

export interface AccessIdentity {
  subject: string;
  email: string;
}

export interface AccessVerifierConfig {
  teamDomain: string;
  audience: string;
  now?: number;
  fetch?: typeof fetch;
}

const jwksCache = new Map<string, { expiresAt: number; keys: AccessJwk[] }>();

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ApiError(401, "invalid_access_token", "Access token is malformed");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "invalid_access_token", "Access token is malformed");
  }
}

function normalizeIssuer(teamDomain: string): string {
  const value = teamDomain.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9.-]+\.cloudflareaccess\.com$/.test(value)) {
    throw new ApiError(500, "invalid_access_configuration", "Access team domain is invalid");
  }
  return `https://${value}`;
}

async function getJwks(issuer: string, fetchImplementation: typeof fetch): Promise<AccessJwk[]> {
  const cached = jwksCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  let response: Response;
  try {
    response = await fetchImplementation(`${issuer}/cdn-cgi/access/certs`);
  } catch {
    throw new ApiError(503, "access_keys_unavailable", "Unable to load Access signing keys");
  }
  if (!response.ok) {
    throw new ApiError(503, "access_keys_unavailable", "Unable to load Access signing keys");
  }
  const body = (await response.json()) as JwkSet;
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) {
    throw new ApiError(503, "access_keys_unavailable", "Access signing keys are empty");
  }
  jwksCache.set(issuer, { expiresAt: Date.now() + 5 * 60_000, keys });
  return keys;
}

function validateClaims(claims: AccessClaims, issuer: string, audience: string, now: number): AccessIdentity {
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || !audiences.includes(audience)) {
    throw new ApiError(403, "access_audience_mismatch", "Access token audience is not allowed");
  }
  if (claims.iss !== issuer) {
    throw new ApiError(401, "invalid_access_token", "Access token issuer is invalid");
  }
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new ApiError(401, "access_token_expired", "Access token has expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) {
    throw new ApiError(401, "invalid_access_token", "Access token is not active yet");
  }
  if (typeof claims.iat === "number" && claims.iat > now + 60) {
    throw new ApiError(401, "invalid_access_token", "Access token issue time is invalid");
  }
  if (typeof claims.sub !== "string" || !claims.sub.trim() ||
      typeof claims.email !== "string" || !claims.email.trim()) {
    throw new ApiError(401, "invalid_access_token", "Access identity is incomplete");
  }
  return { subject: claims.sub, email: claims.email.toLowerCase() };
}

export async function verifyAccessAssertion(token: string, config: AccessVerifierConfig): Promise<AccessIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new ApiError(401, "invalid_access_token", "Access token is malformed");
  }
  const header = decodeJson<AccessHeader>(parts[0]);
  const claims = decodeJson<AccessClaims>(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new ApiError(401, "invalid_access_token", "Access token algorithm is not allowed");
  }
  const issuer = normalizeIssuer(config.teamDomain);
  const keys = await getJwks(issuer, config.fetch ?? fetch);
  const jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!jwk) throw new ApiError(401, "invalid_access_token", "Access signing key is unknown");
  let verified = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      new Uint8Array(decodeBase64Url(parts[2])).buffer,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new ApiError(401, "invalid_access_token", "Access token signature is invalid");
  return validateClaims(claims, issuer, config.audience, config.now ?? Math.floor(Date.now() / 1000));
}

export async function requireAccessIdentity(
  request: Request,
  config: AccessVerifierConfig,
): Promise<AccessIdentity> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (!assertion) throw new ApiError(401, "access_token_required", "Cloudflare Access token is required");
  return verifyAccessAssertion(assertion, config);
}

export async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function requireGptActionKey(request: Request, secret: string): Promise<void> {
  const authorization = request.headers.get("Authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!(await timingSafeEqual(supplied, secret))) {
    throw new ApiError(401, "invalid_api_key", "GPT Action API key is invalid or missing");
  }
}
