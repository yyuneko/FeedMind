import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccessAssertion } from "../../shared/src/auth";

const issuer = "https://auth-test.cloudflareaccess.com";
let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function token(audience: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const header = encodeJson({ alg: "RS256", kid: "test-key" });
  const payload = encodeJson({
    aud: [audience],
    email: "Owner@Example.com",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    iss: issuer,
    sub: "access-subject",
    ...overrides,
  });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

const fetchJwks: typeof fetch = async () =>
  new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key" }] }), {
    headers: { "Content-Type": "application/json" },
  });

describe("Cloudflare Access assertion verification", () => {
  it("accepts a correctly signed assertion for the configured audience", async () => {
    await expect(verifyAccessAssertion(await token("client-audience"), {
      teamDomain: "auth-test.cloudflareaccess.com",
      audience: "client-audience",
      now: 1_900_000_100,
      fetch: fetchJwks,
    })).resolves.toEqual({ subject: "access-subject", email: "owner@example.com" });
  });

  it("rejects an Admin assertion at the C audience boundary", async () => {
    await expect(verifyAccessAssertion(await token("admin-audience"), {
      teamDomain: "auth-test.cloudflareaccess.com",
      audience: "client-audience",
      now: 1_900_000_100,
      fetch: fetchJwks,
    })).rejects.toMatchObject({ status: 403, code: "access_audience_mismatch" });
  });

  it("rejects a token issued by another Access team", async () => {
    await expect(verifyAccessAssertion(await token("client-audience", { iss: "https://other.cloudflareaccess.com" }), {
      teamDomain: "auth-test.cloudflareaccess.com",
      audience: "client-audience",
      now: 1_900_000_100,
      fetch: fetchJwks,
    })).rejects.toMatchObject({ status: 401, code: "invalid_access_token" });
  });

  it("rejects an expired token", async () => {
    await expect(verifyAccessAssertion(await token("client-audience", { exp: 1_900_000_000 }), {
      teamDomain: "auth-test.cloudflareaccess.com",
      audience: "client-audience",
      now: 1_900_000_100,
      fetch: fetchJwks,
    })).rejects.toMatchObject({ status: 401, code: "access_token_expired" });
  });

  it("rejects a forged signature", async () => {
    const valid = await token("client-audience");
    const [header, payload, signature] = valid.split(".");
    const forgedSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const forged = `${header}.${payload}.${forgedSignature}`;
    await expect(verifyAccessAssertion(forged, {
      teamDomain: "auth-test.cloudflareaccess.com",
      audience: "client-audience",
      now: 1_900_000_100,
      fetch: fetchJwks,
    })).rejects.toMatchObject({ status: 401, code: "invalid_access_token" });
  });
});
