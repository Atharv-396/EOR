// =============================================================================
// EMP CLOUD — RSA Key Pair Verifier
// Run with: pnpm verify-keys
//
// Validates the configured RSA keypair and reports its status without
// printing any private key material. Use this to diagnose Railway
// configuration issues before deploying.
// =============================================================================

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env from repo root
dotenvConfig({ path: path.resolve(process.cwd(), ".env") });

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalisePem(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

function header(pem: string): string {
  return pem.split("\n")[0] ?? "(empty)";
}

function footer(pem: string): string {
  return pem.trim().split("\n").slice(-1)[0] ?? "(empty)";
}

function lineCount(pem: string): number {
  return pem.split("\n").length;
}

function pass(msg: string) { console.log("  ✓ " + msg); }
function fail(msg: string) { console.log("  ✗ " + msg); process.exitCode = 1; }
function info(msg: string) { console.log("  · " + msg); }

// ── Source detection ────────────────────────────────────────────────────────

const resolve = (p: string) => path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);

const privateKeyPath = process.env.RSA_PRIVATE_KEY_PATH ?? "./keys/private.pem";
const publicKeyPath  = process.env.RSA_PUBLIC_KEY_PATH  ?? "./keys/public.pem";

const privFilePath = resolve(privateKeyPath);
const pubFilePath  = resolve(publicKeyPath);

const privFileExists = fs.existsSync(privFilePath);
const pubFileExists  = fs.existsSync(pubFilePath);

const hasEnvPriv = !!(process.env.RSA_PRIVATE_KEY?.trim());
const hasEnvPub  = !!(process.env.RSA_PUBLIC_KEY?.trim());

console.log("\n=== EMP Cloud RSA Key Verifier ===\n");
console.log("Source detection:");
info(`RSA_PRIVATE_KEY_PATH resolves to: ${privFilePath}`);
info(`RSA_PUBLIC_KEY_PATH resolves to:  ${pubFilePath}`);
info(`Key files on disk:  private=${privFileExists} public=${pubFileExists}`);
info(`Env vars set:       RSA_PRIVATE_KEY=${hasEnvPriv} RSA_PUBLIC_KEY=${hasEnvPub}`);

let privatePem: string;
let publicPem: string;
let source: string;

if (privFileExists && pubFileExists) {
  privatePem = fs.readFileSync(privFilePath, "utf-8");
  publicPem  = fs.readFileSync(pubFilePath,  "utf-8");
  source = "files on disk";
} else if (hasEnvPriv && hasEnvPub) {
  privatePem = normalisePem(process.env.RSA_PRIVATE_KEY!);
  publicPem  = normalisePem(process.env.RSA_PUBLIC_KEY!);
  source = "environment variables (after normalisePem)";
} else {
  fail("No RSA keys found — neither key files nor env vars are configured.");
  console.log("\nTo fix:");
  console.log("  Local dev: pnpm generate-keys");
  console.log("  Railway:   set RSA_PRIVATE_KEY and RSA_PUBLIC_KEY in Variables tab");
  process.exit(1);
}

console.log(`\nKey source: ${source}\n`);

// ── Private key checks ───────────────────────────────────────────────────────

console.log("Private key checks:");
info(`Header: "${header(privatePem)}"`);
info(`Footer: "${footer(privatePem)}"`);
info(`Lines:  ${lineCount(privatePem)}`);
info(`Has real newlines:     ${privatePem.includes("\n")}`);
info(`Has escaped newlines:  ${privatePem.includes("\\n")}`);
info(`Has CRLF:              ${privatePem.includes("\r\n")}`);

let privKey: crypto.KeyObject | null = null;

try {
  privKey = crypto.createPrivateKey(privatePem);
  pass(`Parsed by Node.js crypto (type=${privKey.type} algorithm=${privKey.asymmetricKeyType})`);
} catch (e: any) {
  fail(`Cannot parse: ${e.message}`);
  console.log("\n  Possible causes:");
  console.log("  1. RSA_PRIVATE_KEY contains the PUBLIC key (swap) — check the header above");
  console.log("  2. Key is truncated — should have ~28 lines for 2048-bit PKCS#8");
  console.log("  3. Key body is corrupted — copy-paste introduced extra characters");
  console.log("  4. Newlines not restored — Railway env may need the full PEM with real \\n");
}

if (privKey && privKey.type !== "private") {
  fail(`Key type is '${privKey.type}' — expected 'private'. RSA_PRIVATE_KEY contains the public key.`);
  privKey = null;
}

// ── Public key checks ────────────────────────────────────────────────────────

console.log("\nPublic key checks:");
info(`Header: "${header(publicPem)}"`);
info(`Footer: "${footer(publicPem)}"`);
info(`Lines:  ${lineCount(publicPem)}`);

let pubKey: crypto.KeyObject | null = null;

try {
  pubKey = crypto.createPublicKey(publicPem);
  pass(`Parsed by Node.js crypto (type=${pubKey.type} algorithm=${pubKey.asymmetricKeyType})`);
} catch (e: any) {
  fail(`Cannot parse: ${e.message}`);
}

// ── Keypair match ────────────────────────────────────────────────────────────

console.log("\nKeypair match:");

if (privKey && pubKey) {
  try {
    const derived = crypto.createPublicKey(privKey);
    const derivedDer = derived.export({ type: "spki", format: "der" }) as Buffer;
    const loadedDer  = pubKey.export({ type: "spki", format: "der" }) as Buffer;

    if (derivedDer.equals(loadedDer)) {
      pass("Private and public keys form a matching keypair");

      // Derive kid
      const kid = crypto.createHash("sha256")
        .update(loadedDer)
        .digest("base64url")
        .slice(0, 16);
      pass(`Key ID (kid): ${kid}`);
    } else {
      fail("Keys DO NOT match — they were generated from different keypairs");
      console.log("\n  Fix: regenerate both keys with 'pnpm generate-keys' and update both");
      console.log("  Railway vars RSA_PRIVATE_KEY and RSA_PUBLIC_KEY in the same operation.");
    }
  } catch (e: any) {
    fail(`Keypair check error: ${e.message}`);
  }
} else {
  info("Keypair match skipped — one or both keys failed to parse");
}

// ── Sign/verify smoke test ────────────────────────────────────────────────────

console.log("\nSign/verify smoke test:");

if (privKey && pubKey) {
  try {
    const jwt = await import("jsonwebtoken");
    const token = jwt.default.sign({ sub: 1, test: true }, privKey, {
      algorithm: "RS256",
      expiresIn: 60,
    });
    pass("jwt.sign() succeeded");

    const decoded = jwt.default.verify(token, pubKey, { algorithms: ["RS256"] }) as any;
    if (decoded.sub === 1) {
      pass("jwt.verify() succeeded — RS256 signing is fully operational");
    }
  } catch (e: any) {
    fail(`Sign/verify failed: ${e.message}`);
  }
} else {
  info("Sign/verify skipped — one or both keys failed to parse");
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n=== Summary ===");
if (process.exitCode === 1) {
  console.log("RESULT: Key configuration has problems — see ✗ items above.\n");
} else {
  console.log("RESULT: Keys are valid and ready for production use.\n");
}
