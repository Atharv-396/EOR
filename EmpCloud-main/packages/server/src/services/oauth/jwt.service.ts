// =============================================================================
// EMP CLOUD — JWT Service (RS256)
// Signs and verifies JWTs using asymmetric RS256 keys.
// =============================================================================

import jwt from "jsonwebtoken";
import fs from "node:fs";
import path from "node:path";
import crypto, { KeyObject } from "node:crypto";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import type { AccessTokenPayload, IDTokenPayload } from "@empcloud/shared";

// ---------------------------------------------------------------------------
// Key storage — KeyObject instead of raw strings so Node.js crypto has
// already validated the key material before we ever call jwt.sign().
// ---------------------------------------------------------------------------
let privateKeyObj: KeyObject | null = null;
let publicKeyObj: KeyObject | null = null;
let keyId: string | null = null;

// ---------------------------------------------------------------------------
// PEM normalisation
//
// Railway and many CI/CD platforms serialise multiline env vars with literal
// backslash-n sequences (e.g. "-----BEGIN PRIVATE KEY-----\nMIIE...").
// We handle three forms:
//   1. Real newlines      — already correct, no-op.
//   2. Literal \n         — produced by Railway / shell quoting.
//   3. JSON-escaped \\n   — produced by double-serialisation.
// ---------------------------------------------------------------------------
export function normalisePem(raw: string): string {
  // Replace any literal backslash-n sequences with real newlines.
  // A correct PEM that already has real newlines is unaffected because
  // /\\n/ only matches the two-character sequence '\' + 'n', not '\n'.
  return raw.replace(/\\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// loadKeys — parse, validate, and cross-check the RSA keypair.
//
// Fails loudly at startup so a misconfigured Railway deployment surfaces
// immediately rather than handing users a 500 on their first login.
//
// Priority:
//   1. File paths (RSA_PRIVATE_KEY_PATH / RSA_PUBLIC_KEY_PATH) — local dev.
//   2. Inline PEM env vars (RSA_PRIVATE_KEY / RSA_PUBLIC_KEY) — Railway/cloud.
// ---------------------------------------------------------------------------
export function loadKeys(): void {
  let privatePem: string | null = null;
  let publicPem: string | null = null;

  // -- Source resolution -------------------------------------------------------
  const resolve = (p: string) =>
    path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);

  const privatePath = resolve(config.oauth.privateKeyPath);
  const publicPath = resolve(config.oauth.publicKeyPath);

  if (fs.existsSync(privatePath) && fs.existsSync(publicPath)) {
    privatePem = fs.readFileSync(privatePath, "utf-8");
    publicPem = fs.readFileSync(publicPath, "utf-8");
  } else if (process.env.RSA_PRIVATE_KEY && process.env.RSA_PUBLIC_KEY) {
    privatePem = normalisePem(process.env.RSA_PRIVATE_KEY);
    publicPem = normalisePem(process.env.RSA_PUBLIC_KEY);

    // Diagnostic metadata (no key material logged — headers only).
    // This appears in Railway logs and tells us exactly what went wrong
    // without exposing private key content.
    const privHeader = privatePem.split("\n")[0] ?? "(empty)";
    const pubHeader  = publicPem.split("\n")[0]  ?? "(empty)";
    const privLines  = privatePem.split("\n").length;
    const pubLines   = publicPem.split("\n").length;
    logger.info(
      `RSA env vars found — private header: "${privHeader}" (${privLines} lines), ` +
      `public header: "${pubHeader}" (${pubLines} lines)`,
    );
  } else {
    // Not a hard crash — let the server start so /health still responds.
    // Every signing/verification call will throw clearly if keys are absent.
    logger.warn(
      "RSA keys not found. " +
      "Provide key files or set RSA_PRIVATE_KEY / RSA_PUBLIC_KEY env vars. " +
      "Authentication will not work until keys are configured.",
    );
    return;
  }

  // -- Validation --------------------------------------------------------------
  // Parse via crypto so we catch malformed, truncated, or wrong-type material
  // (e.g. public key pasted into the private key slot) here at startup,
  // not later when a user tries to log in.
  let privKey: KeyObject;
  let pubKey: KeyObject;

  try {
    privKey = crypto.createPrivateKey(privatePem);
  } catch (err: any) {
    throw new Error(
      `RSA private key is invalid or malformed — check RSA_PRIVATE_KEY / RSA_PRIVATE_KEY_PATH. ` +
      `Node.js error: ${err.message}`,
    );
  }

  // Guard against the common copy-paste swap: public key pasted into
  // the RSA_PRIVATE_KEY slot.  createPrivateKey() would throw above if
  // the PEM header is "PUBLIC KEY", but some flows could produce a
  // private-key-shaped blob that is actually the public component.
  // An explicit asymmetricKeyType check is the clearest guard.
  if (privKey.type !== "private") {
    throw new Error(
      "RSA_PRIVATE_KEY contains a public key, not a private key. " +
      "Swap RSA_PRIVATE_KEY and RSA_PUBLIC_KEY in your Railway environment.",
    );
  }

  try {
    pubKey = crypto.createPublicKey(publicPem);
  } catch (err: any) {
    throw new Error(
      `RSA public key is invalid or malformed — check RSA_PUBLIC_KEY / RSA_PUBLIC_KEY_PATH. ` +
      `Node.js error: ${err.message}`,
    );
  }

  // -- Keypair match check -----------------------------------------------------
  // Derive the public key from the private key and compare exported DER bytes.
  // This catches: correct key formats but keys from different keypairs.
  const derivedPub = crypto.createPublicKey(privKey);
  const derivedDer = derivedPub.export({ type: "spki", format: "der" }) as Buffer;
  const loadedDer = pubKey.export({ type: "spki", format: "der" }) as Buffer;

  if (!derivedDer.equals(loadedDer)) {
    throw new Error(
      "RSA_PRIVATE_KEY and RSA_PUBLIC_KEY do not form a matching keypair. " +
      "Ensure both env vars contain keys generated from the same 'pnpm generate-keys' run.",
    );
  }

  // -- Commit ------------------------------------------------------------------
  privateKeyObj = privKey;
  publicKeyObj = pubKey;

  // Derive kid from the public key fingerprint (unchanged behaviour).
  keyId = crypto
    .createHash("sha256")
    .update(loadedDer)
    .digest("base64url")
    .slice(0, 16);

  logger.info(`RSA keys loaded (kid: ${keyId})`);
}

// ---------------------------------------------------------------------------
// Accessors — throw clearly if loadKeys() was never called or keys are absent.
// ---------------------------------------------------------------------------

export function getPublicKey(): KeyObject {
  if (!publicKeyObj) throw new Error("RSA public key not loaded — check startup logs");
  return publicKeyObj;
}

export function getPrivateKey(): KeyObject {
  if (!privateKeyObj) throw new Error("RSA private key not loaded — check startup logs");
  return privateKeyObj;
}

export function getKeyId(): string {
  if (!keyId) throw new Error("Key ID not available — RSA keys not loaded");
  return keyId;
}

// ---------------------------------------------------------------------------
// Token signing
// ---------------------------------------------------------------------------

export function signAccessToken(payload: Omit<AccessTokenPayload, "iat" | "exp" | "iss">): string {
  return jwt.sign(payload as object, getPrivateKey(), {
    algorithm: "RS256",
    expiresIn: parseExpiry(config.oauth.accessTokenExpiry),
    issuer: config.oauth.issuer,
    keyid: getKeyId(),
  });
}

export function signIDToken(payload: Omit<IDTokenPayload, "iat" | "exp" | "iss">): string {
  return jwt.sign(payload as object, getPrivateKey(), {
    algorithm: "RS256",
    expiresIn: parseExpiry(config.oauth.idTokenExpiry),
    issuer: config.oauth.issuer,
    keyid: getKeyId(),
  });
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, getPublicKey(), {
    algorithms: ["RS256"],
    issuer: config.oauth.issuer,
  }) as unknown as AccessTokenPayload;
}

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

export function getJWKS(): object {
  const keyObject = getPublicKey();
  const jwk = keyObject.export({ format: "jwk" }) as Record<string, unknown>;

  return {
    keys: [
      {
        ...jwk,
        kid: getKeyId(),
        alg: "RS256",
        use: "sig",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid expiry format: ${expiry}`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 3600;
    case "d": return value * 86400;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}
