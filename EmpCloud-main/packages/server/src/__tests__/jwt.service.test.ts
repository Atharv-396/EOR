/**
 * JWT service tests — key loading, PEM normalisation, signing, verification.
 * Pure unit tests: no DB, no network, no real production keys.
 * Test keypairs are generated fresh for each relevant test.
 *
 * Isolation strategy: each test sets RSA_PRIVATE_KEY_PATH and
 * RSA_PUBLIC_KEY_PATH to guaranteed-nonexistent paths so loadKeys()
 * always falls through to the RSA_PRIVATE_KEY / RSA_PUBLIC_KEY env vars,
 * regardless of any .pem files that may exist on disk in CI or local dev.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeypair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

/** Convert real newlines to literal \n — what Railway stores in env vars. */
function escapedNewlines(pem: string): string {
  return pem.replace(/\n/g, "\\n");
}

/**
 * Force the config layer to use the env-var key path (no files on disk) by
 * pointing RSA_PRIVATE_KEY_PATH / RSA_PUBLIC_KEY_PATH at paths that cannot
 * exist. This ensures loadKeys() always reaches the env-var branch.
 */
function disableFilePaths() {
  process.env.RSA_PRIVATE_KEY_PATH = "/no/such/private.pem";
  process.env.RSA_PUBLIC_KEY_PATH = "/no/such/public.pem";
}

/** Fresh module import with full state reset — required because jwt.service
 *  keeps module-level key singletons. */
async function freshImport() {
  vi.resetModules();
  return import("../services/oauth/jwt.service.js");
}

// ---------------------------------------------------------------------------
// 1. normalisePem
// ---------------------------------------------------------------------------
describe("normalisePem", () => {
  it("is a no-op on PEM that already has real newlines", async () => {
    const { normalisePem } = await freshImport();
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n";
    expect(normalisePem(pem)).toBe(pem.trim());
  });

  it("converts escaped \\n sequences to real newlines", async () => {
    const { normalisePem } = await freshImport();
    const escaped = "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n";
    const result = normalisePem(escaped);
    expect(result).toContain("\n");
    expect(result).not.toContain("\\n");
  });

  it("trims surrounding whitespace", async () => {
    const { normalisePem } = await freshImport();
    expect(normalisePem("  abc\ndef  ")).toBe("abc\ndef");
  });

  it("restores a Railway-style escaped private key PEM to parseable form", async () => {
    const { normalisePem } = await freshImport();
    const { privateKey } = makeKeypair();
    const restored = normalisePem(escapedNewlines(privateKey));
    expect(() => crypto.createPrivateKey(restored)).not.toThrow();
  });

  it("restores a Railway-style escaped public key PEM to parseable form", async () => {
    const { normalisePem } = await freshImport();
    const { publicKey } = makeKeypair();
    const restored = normalisePem(escapedNewlines(publicKey));
    expect(() => crypto.createPublicKey(restored)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. loadKeys — success paths
// ---------------------------------------------------------------------------
describe("loadKeys — success", () => {
  beforeEach(() => {
    disableFilePaths();
  });

  afterEach(() => {
    delete process.env.RSA_PRIVATE_KEY;
    delete process.env.RSA_PUBLIC_KEY;
    delete process.env.RSA_PRIVATE_KEY_PATH;
    delete process.env.RSA_PUBLIC_KEY_PATH;
  });

  it("loads valid keys from env vars with real newlines", async () => {
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = privateKey;
    process.env.RSA_PUBLIC_KEY = publicKey;

    const { loadKeys, getPrivateKey, getPublicKey } = await freshImport();
    expect(() => loadKeys()).not.toThrow();
    expect(() => getPrivateKey()).not.toThrow();
    expect(() => getPublicKey()).not.toThrow();
  });

  it("loads valid keys from env vars with escaped newlines (Railway format)", async () => {
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = escapedNewlines(privateKey);
    process.env.RSA_PUBLIC_KEY = escapedNewlines(publicKey);

    const { loadKeys, getPrivateKey, getPublicKey } = await freshImport();
    expect(() => loadKeys()).not.toThrow();
    expect(() => getPrivateKey()).not.toThrow();
    expect(() => getPublicKey()).not.toThrow();
  });

  it("loads valid keys from PEM files on disk", async () => {
    const { privateKey, publicKey } = makeKeypair();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jwt-test-"));
    const privPath = path.join(dir, "private.pem");
    const pubPath = path.join(dir, "public.pem");
    fs.writeFileSync(privPath, privateKey);
    fs.writeFileSync(pubPath, publicKey);

    // Point at the real temp files (overrides disableFilePaths)
    process.env.RSA_PRIVATE_KEY_PATH = privPath;
    process.env.RSA_PUBLIC_KEY_PATH = pubPath;

    const { loadKeys, getPrivateKey } = await freshImport();
    expect(() => loadKeys()).not.toThrow();
    expect(() => getPrivateKey()).not.toThrow();

    fs.rmSync(dir, { recursive: true });
  });

  it("derives a stable 16-character kid from the public key", async () => {
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = privateKey;
    process.env.RSA_PUBLIC_KEY = publicKey;

    const { loadKeys, getKeyId } = await freshImport();
    loadKeys();
    const kid = getKeyId();
    expect(typeof kid).toBe("string");
    expect(kid.length).toBe(16);
  });

  it("produces the same kid regardless of escaped vs real newlines", async () => {
    const { privateKey, publicKey } = makeKeypair();

    process.env.RSA_PRIVATE_KEY = privateKey;
    process.env.RSA_PUBLIC_KEY = publicKey;
    const svcA = await freshImport();
    svcA.loadKeys();
    const kidA = svcA.getKeyId();

    disableFilePaths();
    process.env.RSA_PRIVATE_KEY = escapedNewlines(privateKey);
    process.env.RSA_PUBLIC_KEY = escapedNewlines(publicKey);
    const svcB = await freshImport();
    svcB.loadKeys();
    const kidB = svcB.getKeyId();

    expect(kidA).toBe(kidB);
  });
});

// ---------------------------------------------------------------------------
// 3. loadKeys — failure paths
// ---------------------------------------------------------------------------
describe("loadKeys — failure", () => {
  beforeEach(() => {
    disableFilePaths();
  });

  afterEach(() => {
    delete process.env.RSA_PRIVATE_KEY;
    delete process.env.RSA_PUBLIC_KEY;
    delete process.env.RSA_PRIVATE_KEY_PATH;
    delete process.env.RSA_PUBLIC_KEY_PATH;
  });

  it("throws when private key slot contains the public key (copy-paste swap)", async () => {
    const { publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = publicKey; // WRONG: public pasted into private slot
    process.env.RSA_PUBLIC_KEY = publicKey;

    const { loadKeys } = await freshImport();
    expect(() => loadKeys()).toThrow(/private key is invalid|unsupported/i);
  });

  it("throws when private key is truncated (copy-paste cut off)", async () => {
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = privateKey.slice(0, 100);
    process.env.RSA_PUBLIC_KEY = publicKey;

    const { loadKeys } = await freshImport();
    expect(() => loadKeys()).toThrow(/private key is invalid|malformed|unsupported/i);
  });

  it("throws when public key is truncated", async () => {
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = privateKey;
    process.env.RSA_PUBLIC_KEY = publicKey.slice(0, 80);

    const { loadKeys } = await freshImport();
    expect(() => loadKeys()).toThrow(/public key is invalid|malformed|unsupported/i);
  });

  it("throws when private and public keys are from different keypairs", async () => {
    const pair1 = makeKeypair();
    const pair2 = makeKeypair();
    process.env.RSA_PRIVATE_KEY = pair1.privateKey;
    process.env.RSA_PUBLIC_KEY = pair2.publicKey; // mismatched

    const { loadKeys } = await freshImport();
    expect(() => loadKeys()).toThrow(/matching keypair/i);
  });

  it("throws when private key is whitespace only", async () => {
    const { publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = "   ";
    process.env.RSA_PUBLIC_KEY = publicKey;

    const { loadKeys } = await freshImport();
    expect(() => loadKeys()).toThrow(/private key is invalid|malformed|unsupported/i);
  });

  it("throws when private key is a garbage non-PEM string", async () => {
    const { publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = "not-a-pem-at-all";
    process.env.RSA_PUBLIC_KEY = publicKey;

    const { loadKeys } = await freshImport();
    expect(() => loadKeys()).toThrow(/private key is invalid|malformed|unsupported/i);
  });

  it("warns but does not throw when neither file nor env vars are configured", async () => {
    // disableFilePaths() already set — just ensure no inline env vars are set
    delete process.env.RSA_PRIVATE_KEY;
    delete process.env.RSA_PUBLIC_KEY;

    const { loadKeys } = await freshImport();
    expect(() => loadKeys()).not.toThrow();
  });

  it("getPrivateKey() throws clearly when loadKeys() found no keys", async () => {
    delete process.env.RSA_PRIVATE_KEY;
    delete process.env.RSA_PUBLIC_KEY;

    const { loadKeys, getPrivateKey } = await freshImport();
    loadKeys(); // warns, no-op
    expect(() => getPrivateKey()).toThrow(/RSA private key not loaded/);
  });
});

// ---------------------------------------------------------------------------
// 4. Sign and verify round-trip
// ---------------------------------------------------------------------------
describe("signAccessToken / verifyAccessToken", () => {
  beforeEach(() => {
    disableFilePaths();
  });

  afterEach(() => {
    delete process.env.RSA_PRIVATE_KEY;
    delete process.env.RSA_PUBLIC_KEY;
    delete process.env.RSA_PRIVATE_KEY_PATH;
    delete process.env.RSA_PUBLIC_KEY_PATH;
  });

  async function loadTestKeys() {
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = privateKey;
    process.env.RSA_PUBLIC_KEY = publicKey;
    const svc = await freshImport();
    svc.loadKeys();
    return svc;
  }

  it("signs an access token and verifies it successfully", async () => {
    const svc = await loadTestKeys();
    const token = svc.signAccessToken({
      sub: 42,
      org_id: 1,
      email: "test@example.com",
      role: "employee" as any,
      first_name: "Test",
      last_name: "User",
      org_name: "Acme",
      scope: "openid profile",
      client_id: "empcloud-dashboard",
      jti: "test-jti",
      permissions: [],
    });
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(3);

    const decoded = svc.verifyAccessToken(token) as any;
    expect(decoded.sub).toBe(42);
    expect(decoded.email).toBe("test@example.com");
  });

  it("signs with RS256 algorithm and includes kid in token header", async () => {
    const svc = await loadTestKeys();
    const token = svc.signAccessToken({
      sub: 1,
      org_id: 1,
      email: "a@b.com",
      role: "employee" as any,
      first_name: "A",
      last_name: "B",
      org_name: "X",
      scope: "openid",
      client_id: "empcloud-dashboard",
      jti: "jti-1",
      permissions: [],
    });
    const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe(svc.getKeyId());
  });

  it("rejects a token signed with a different keypair", async () => {
    // Sign with keypair A
    const pairA = makeKeypair();
    process.env.RSA_PRIVATE_KEY = pairA.privateKey;
    process.env.RSA_PUBLIC_KEY = pairA.publicKey;
    const svcA = await freshImport();
    svcA.loadKeys();

    const token = svcA.signAccessToken({
      sub: 1,
      org_id: 1,
      email: "a@b.com",
      role: "employee" as any,
      first_name: "A",
      last_name: "B",
      org_name: "X",
      scope: "openid",
      client_id: "empcloud-dashboard",
      jti: "jti-cross",
      permissions: [],
    });

    // Verify with keypair B — must fail
    const pairB = makeKeypair();
    process.env.RSA_PRIVATE_KEY = pairB.privateKey;
    process.env.RSA_PUBLIC_KEY = pairB.publicKey;
    const svcB = await freshImport();
    svcB.loadKeys();

    expect(() => svcB.verifyAccessToken(token)).toThrow();
  });

  it("rejects a tampered token payload", async () => {
    const svc = await loadTestKeys();
    const token = svc.signAccessToken({
      sub: 1,
      org_id: 1,
      email: "a@b.com",
      role: "employee" as any,
      first_name: "A",
      last_name: "B",
      org_name: "X",
      scope: "openid",
      client_id: "empcloud-dashboard",
      jti: "jti-tamper",
      permissions: [],
    });

    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.sub = 9999;
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");

    expect(() => svc.verifyAccessToken(parts.join("."))).toThrow();
  });

  it("rejects an expired token", async () => {
    // Load the keys normally first so we have access to the private key
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = privateKey;
    process.env.RSA_PUBLIC_KEY = publicKey;
    const svc = await freshImport();
    svc.loadKeys();

    // Sign directly with the loaded private KeyObject so it verifies with
    // the same public key — but with a negative expiry
    const jwtLib = await import("jsonwebtoken");
    const expiredToken = jwtLib.default.sign(
      { sub: 1, jti: "expired-test" },
      svc.getPrivateKey(), // same KeyObject the service will verify with
      { algorithm: "RS256", expiresIn: -1 },
    );

    expect(() => svc.verifyAccessToken(expiredToken)).toThrow(/expired/i);
  });

  it("signs and verifies with Railway escaped-newline keys", async () => {
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = escapedNewlines(privateKey);
    process.env.RSA_PUBLIC_KEY = escapedNewlines(publicKey);
    const svc = await freshImport();
    svc.loadKeys();

    const token = svc.signAccessToken({
      sub: 7,
      org_id: 1,
      email: "railway@test.com",
      role: "org_admin" as any,
      first_name: "Rail",
      last_name: "Way",
      org_name: "RailCo",
      scope: "openid",
      client_id: "empcloud-dashboard",
      jti: "railway-jti",
      permissions: [],
    });
    const decoded = svc.verifyAccessToken(token) as any;
    expect(decoded.sub).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 5. parseExpiry
// ---------------------------------------------------------------------------
describe("parseExpiry", () => {
  it("parses seconds", async () => {
    const { parseExpiry } = await freshImport();
    expect(parseExpiry("30s")).toBe(30);
  });

  it("parses minutes", async () => {
    const { parseExpiry } = await freshImport();
    expect(parseExpiry("15m")).toBe(900);
  });

  it("parses hours", async () => {
    const { parseExpiry } = await freshImport();
    expect(parseExpiry("1h")).toBe(3600);
  });

  it("parses days", async () => {
    const { parseExpiry } = await freshImport();
    expect(parseExpiry("7d")).toBe(604800);
  });

  it("throws on invalid format", async () => {
    const { parseExpiry } = await freshImport();
    expect(() => parseExpiry("15")).toThrow(/Invalid expiry format/);
    expect(() => parseExpiry("abc")).toThrow(/Invalid expiry format/);
    expect(() => parseExpiry("")).toThrow(/Invalid expiry format/);
  });
});

// ---------------------------------------------------------------------------
// 6. getJWKS
// ---------------------------------------------------------------------------
describe("getJWKS", () => {
  beforeEach(() => disableFilePaths());

  afterEach(() => {
    delete process.env.RSA_PRIVATE_KEY;
    delete process.env.RSA_PUBLIC_KEY;
    delete process.env.RSA_PRIVATE_KEY_PATH;
    delete process.env.RSA_PUBLIC_KEY_PATH;
  });

  it("returns a JWKS with one RSA public key and no private-key components", async () => {
    const { privateKey, publicKey } = makeKeypair();
    process.env.RSA_PRIVATE_KEY = privateKey;
    process.env.RSA_PUBLIC_KEY = publicKey;

    const svc = await freshImport();
    svc.loadKeys();
    const jwks = svc.getJWKS() as any;

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kty).toBe("RSA");
    expect(jwks.keys[0].alg).toBe("RS256");
    expect(jwks.keys[0].use).toBe("sig");
    expect(jwks.keys[0].kid).toBe(svc.getKeyId());
    // Must NOT expose private key material
    expect(jwks.keys[0].d).toBeUndefined();
    expect(jwks.keys[0].p).toBeUndefined();
    expect(jwks.keys[0].q).toBeUndefined();
  });
});
