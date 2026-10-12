/**
 * Regression tests — Super Admin login FK violation fix
 *
 * Covers the four code paths in oauth.service.ts that previously failed
 * when organization_id was 0 (super_admin has no real org):
 *
 *   1. issueTokens()           — inserts oauth_access_tokens + oauth_refresh_tokens
 *   2. refreshAccessToken()    — re-issues after rotation; must not crash on null org
 *   3. introspectToken()       — refresh-token branch with null organization_id
 *   4. createAuthorizationCode() — OIDC /authorize flow for super_admin
 *
 * All DB calls are mocked so these run without a live MySQL connection.
 * The tests focus on the DB insert values (organization_id = null vs 0)
 * and the conditional org-lookup + access-check logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeKeypair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

// ── Module-level mocks ────────────────────────────────────────────────────────

// Must be declared before the dynamic import so Vitest hoists them.
vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../services/audit/audit.service.js", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/auth/organization-access-policy.service.js", () => ({
  evaluateOrganizationAccess: vi.fn().mockResolvedValue({
    allowed: true,
    paymentRestricted: false,
  }),
}));

vi.mock("../services/permissions/permissions.service.js", () => ({
  resolveUserPermissions: vi.fn().mockResolvedValue(["attendance:view", "leave:apply"]),
}));

// ── Test setup ────────────────────────────────────────────────────────────────

const { privateKey: privPem, publicKey: pubPem } = makeKeypair();

/** Reset env and module state before each test. */
function setupEnv() {
  process.env.RSA_PRIVATE_KEY = privPem;
  process.env.RSA_PUBLIC_KEY = pubPem;
  // Point at non-existent files so loadKeys() falls through to env vars
  process.env.RSA_PRIVATE_KEY_PATH = "/no/such/private.pem";
  process.env.RSA_PUBLIC_KEY_PATH = "/no/such/public.pem";
  process.env.NODE_ENV = "test";
  process.env.BASE_URL = "http://localhost:3000";
  process.env.ACCESS_TOKEN_EXPIRY = "15m";
  process.env.REFRESH_TOKEN_EXPIRY = "7d";
  process.env.AUTH_CODE_EXPIRY = "10m";
  process.env.ID_TOKEN_EXPIRY = "1h";
  process.env.ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.DB_HOST = "localhost";
  process.env.DB_PORT = "3306";
  process.env.DB_USER = "root";
  process.env.DB_PASSWORD = "secret";
  process.env.DB_NAME = "empcloud";
}

/** Build a minimal knex mock that records every insert call. */
function makeDbMock() {
  let insertIdCounter = 100;
  const inserts: Record<string, object[]> = {};

  function tableFn(tableName: string) {
    return {
      insert: vi.fn().mockImplementation((row: object) => {
        inserts[tableName] = inserts[tableName] ?? [];
        inserts[tableName].push(row);
        return Promise.resolve([++insertIdCounter]);
      }),
      where: vi.fn().mockReturnThis(),
      whereNull: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(1),
    };
  }

  // Make tableFn callable as both db("table") and db.raw(...)
  const db: any = vi.fn().mockImplementation(tableFn);
  db.raw = vi.fn().mockResolvedValue([[]]);
  db._inserts = inserts;
  return db;
}

/** Load a fresh copy of oauth.service.ts with JWT keys loaded. */
async function freshOauthService(db: any) {
  vi.resetModules();
  setupEnv();

  const { getDB } = await import("../db/connection.js");
  (getDB as any).mockReturnValue(db);

  // Load JWT service so keys are available
  const jwt = await import("../services/oauth/jwt.service.js");
  jwt.loadKeys();

  const oauth = await import("../services/oauth/oauth.service.js");
  return oauth;
}

// ── 1. issueTokens() — super_admin stores NULL organization_id ────────────────

describe("issueTokens() — super_admin (org_id = 0)", () => {
  it("inserts oauth_access_tokens with organization_id = null, not 0", async () => {
    const db = makeDbMock();
    const { issueTokens } = await freshOauthService(db);

    await issueTokens({
      userId: 2,
      orgId: 0,                       // super_admin sentinel
      email: "superadmin@example.com",
      role: "super_admin" as any,
      firstName: "Super",
      lastName: "Admin",
      orgName: "EMP Cloud Platform",
      scope: "openid profile email",
      clientId: "empcloud-dashboard",
    });

    const atInserts = db._inserts["oauth_access_tokens"];
    expect(atInserts).toHaveLength(1);
    expect(atInserts[0]).toMatchObject({ organization_id: null });
    // Must NOT contain 0 — that's the FK violation
    expect((atInserts[0] as any).organization_id).not.toBe(0);
  });

  it("inserts oauth_refresh_tokens with organization_id = null, not 0", async () => {
    const db = makeDbMock();
    const { issueTokens } = await freshOauthService(db);

    await issueTokens({
      userId: 2,
      orgId: 0,
      email: "superadmin@example.com",
      role: "super_admin" as any,
      firstName: "Super",
      lastName: "Admin",
      orgName: "EMP Cloud Platform",
      scope: "openid profile email",
      clientId: "empcloud-dashboard",
    });

    const rtInserts = db._inserts["oauth_refresh_tokens"];
    expect(rtInserts).toHaveLength(1);
    expect((rtInserts[0] as any).organization_id).toBeNull();
  });

  it("preserves organization_id for regular org users (no regression)", async () => {
    const db = makeDbMock();
    const { issueTokens } = await freshOauthService(db);

    await issueTokens({
      userId: 10,
      orgId: 5,                       // real org
      email: "admin@technova.in",
      role: "org_admin" as any,
      firstName: "Org",
      lastName: "Admin",
      orgName: "TechNova",
      scope: "openid profile email",
      clientId: "empcloud-dashboard",
    });

    const atInserts = db._inserts["oauth_access_tokens"];
    expect((atInserts[0] as any).organization_id).toBe(5);
    const rtInserts = db._inserts["oauth_refresh_tokens"];
    expect((rtInserts[0] as any).organization_id).toBe(5);
  });

  it("returns access_token, refresh_token, and id_token for openid scope", async () => {
    const db = makeDbMock();
    const { issueTokens } = await freshOauthService(db);

    const result = await issueTokens({
      userId: 2,
      orgId: 0,
      email: "superadmin@example.com",
      role: "super_admin" as any,
      firstName: "Super",
      lastName: "Admin",
      orgName: "EMP Cloud Platform",
      scope: "openid profile email",
      clientId: "empcloud-dashboard",
    });

    expect(result.access_token).toBeTruthy();
    expect(result.refresh_token).toBeTruthy();
    expect(result.id_token).toBeTruthy();
    expect(result.token_type).toBe("Bearer");
  });
});

// ── 2. refreshAccessToken() — super_admin null org path ──────────────────────

describe("refreshAccessToken() — super_admin (null organization_id)", () => {
  /**
   * Build a db mock that simulates an existing super_admin refresh token
   * with organization_id = null.
   */
  function makeDbWithToken(tokenOverride: Partial<object> = {}) {
    const db = makeDbMock();
    const base = {
      id: 1,
      token_hash: "hashed",
      client_id: "empcloud-dashboard",
      user_id: 2,
      organization_id: null,           // <-- super_admin: no real org
      scope: "openid profile email",
      family_id: "fam-1",
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      revoked_at: null,
    };
    const storedToken = { ...base, ...tokenOverride };

    // Simulate: oauth_refresh_tokens.where(hash).first() → storedToken
    const rtMock = {
      where: vi.fn().mockReturnThis(),
      whereNull: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(storedToken),
      update: vi.fn().mockResolvedValue(1),
      insert: vi.fn().mockResolvedValue([200]),
    };

    const superAdminUser = {
      id: 2,
      email: "superadmin@example.com",
      role: "super_admin",
      first_name: "Super",
      last_name: "Admin",
      organization_id: null,
      status: 1,
    };

    // users table returns super_admin row
    const usersMock = {
      where: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(superAdminUser),
    };

    // organizations table should NOT be called for super_admin
    const orgsMock = {
      where: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    };

    const atMock = {
      insert: vi.fn().mockResolvedValue([201]),
    };

    db.mockImplementation((table: string) => {
      if (table === "oauth_refresh_tokens") return rtMock;
      if (table === "users") return usersMock;
      if (table === "organizations") return orgsMock;
      if (table === "oauth_access_tokens") return atMock;
      return {
        where: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        insert: vi.fn().mockResolvedValue([999]),
        update: vi.fn().mockResolvedValue(0),
      };
    });

    return { db, storedToken, orgsMock, atMock, rtMock };
  }

  it("does not throw when organization_id is null (super_admin)", async () => {
    const { db } = makeDbWithToken();
    const { refreshAccessToken } = await freshOauthService(db);

    // Should resolve without throwing OAuthError("User or organization not found")
    await expect(
      refreshAccessToken({ refreshToken: "raw-token", clientId: "empcloud-dashboard" }),
    ).resolves.toMatchObject({ access_token: expect.any(String) });
  });

  it("does not query organizations table for super_admin token", async () => {
    const { db, orgsMock } = makeDbWithToken();
    const { refreshAccessToken } = await freshOauthService(db);

    await refreshAccessToken({ refreshToken: "raw-token", clientId: "empcloud-dashboard" });

    // organizations table must NOT be queried — super_admin has no real org
    expect(orgsMock.where).not.toHaveBeenCalled();
  });

  it("stores null organization_id in new tokens on refresh", async () => {
    const newAtInserts: object[] = [];
    const newRtInserts: object[] = [];

    const { db } = makeDbWithToken();
    db.mockImplementation((table: string) => {
      if (table === "oauth_refresh_tokens") {
        return {
          where: vi.fn().mockReturnThis(),
          whereNull: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: 1,
            token_hash: "hashed",
            client_id: "empcloud-dashboard",
            user_id: 2,
            organization_id: null,
            scope: "openid profile email",
            family_id: "fam-1",
            expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
            revoked_at: null,
          }),
          update: vi.fn().mockResolvedValue(1),
          insert: vi.fn().mockImplementation((row: object) => {
            newRtInserts.push(row);
            return Promise.resolve([202]);
          }),
        };
      }
      if (table === "users") {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: 2,
            email: "superadmin@example.com",
            role: "super_admin",
            first_name: "Super",
            last_name: "Admin",
            organization_id: null,
            status: 1,
          }),
        };
      }
      if (table === "oauth_access_tokens") {
        return {
          insert: vi.fn().mockImplementation((row: object) => {
            newAtInserts.push(row);
            return Promise.resolve([203]);
          }),
        };
      }
      if (table === "organizations") {
        return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
      }
      return {
        where: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        insert: vi.fn().mockResolvedValue([999]),
        update: vi.fn().mockResolvedValue(0),
      };
    });

    const { refreshAccessToken } = await freshOauthService(db);
    await refreshAccessToken({ refreshToken: "raw-token", clientId: "empcloud-dashboard" });

    expect(newAtInserts).toHaveLength(1);
    expect((newAtInserts[0] as any).organization_id).toBeNull();
    expect(newRtInserts).toHaveLength(1);
    expect((newRtInserts[0] as any).organization_id).toBeNull();
  });

  it("throws for expired refresh token", async () => {
    const { db } = makeDbWithToken({
      expires_at: new Date(Date.now() - 1000), // already expired
    });
    const { refreshAccessToken } = await freshOauthService(db);

    await expect(
      refreshAccessToken({ refreshToken: "raw-token", clientId: "empcloud-dashboard" }),
    ).rejects.toMatchObject({ errorType: "invalid_grant" });
  });

  it("throws for revoked refresh token (family-wide revocation)", async () => {
    const { db } = makeDbWithToken({ revoked_at: new Date() });
    const { refreshAccessToken } = await freshOauthService(db);

    await expect(
      refreshAccessToken({ refreshToken: "raw-token", clientId: "empcloud-dashboard" }),
    ).rejects.toMatchObject({ errorType: "invalid_grant" });
  });

  it("still applies org access checks for regular org user on refresh", async () => {
    const { evaluateOrganizationAccess } = await import(
      "../services/auth/organization-access-policy.service.js"
    );

    const db = makeDbMock();
    const orgRow = { id: 5, name: "TechNova", is_active: true };

    db.mockImplementation((table: string) => {
      if (table === "oauth_refresh_tokens") {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: 10,
            token_hash: "hashed",
            client_id: "empcloud-dashboard",
            user_id: 99,
            organization_id: 5,        // real org
            scope: "openid",
            family_id: "fam-2",
            expires_at: new Date(Date.now() + 86400000),
            revoked_at: null,
          }),
          update: vi.fn().mockResolvedValue(1),
          insert: vi.fn().mockResolvedValue([210]),
        };
      }
      if (table === "users") {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: 99,
            email: "admin@technova.in",
            role: "org_admin",
            first_name: "Org",
            last_name: "Admin",
            organization_id: 5,
            status: 1,
          }),
        };
      }
      if (table === "organizations") {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(orgRow),
        };
      }
      if (table === "oauth_access_tokens") {
        return { insert: vi.fn().mockResolvedValue([211]) };
      }
      return {
        where: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        insert: vi.fn().mockResolvedValue([999]),
        update: vi.fn().mockResolvedValue(0),
      };
    });

    const { refreshAccessToken } = await freshOauthService(db);
    await refreshAccessToken({ refreshToken: "raw-token", clientId: "empcloud-dashboard" });

    // evaluateOrganizationAccess must have been called with the real org_id
    expect(evaluateOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 5 }),
    );
  });
});

// ── 3. introspectToken() — refresh token branch with null org ─────────────────

describe("introspectToken() — refresh token with null organization_id", () => {
  it("returns active:true for super_admin refresh token without calling evaluateOrganizationAccess", async () => {
    const { evaluateOrganizationAccess } = await import(
      "../services/auth/organization-access-policy.service.js"
    );
    vi.mocked(evaluateOrganizationAccess).mockClear();

    const db = makeDbMock();
    const refreshTokenRow = {
      id: 50,
      token_hash: "some-hash",
      client_id: "empcloud-dashboard",
      user_id: 2,
      organization_id: null,           // super_admin: no org
      scope: "openid",
      revoked_at: null,
      expires_at: new Date(Date.now() + 86400000),
    };

    db.mockImplementation((table: string) => {
      if (table === "oauth_refresh_tokens") {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(refreshTokenRow),
        };
      }
      if (table === "oauth_access_tokens") {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        };
      }
      return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
    });

    const { introspectToken } = await freshOauthService(db);
    // Pass a token that will fail JWT verify (triggers refresh-token fallback)
    const result = await introspectToken({
      token: "not-a-jwt",
      tokenTypeHint: "refresh_token",
    });

    expect(result).toMatchObject({ active: true, sub: "2", token_type: "refresh_token" });
    // evaluateOrganizationAccess must NOT have been called (null org_id skips it)
    expect(evaluateOrganizationAccess).not.toHaveBeenCalled();
  });

  it("still calls evaluateOrganizationAccess for regular org refresh token", async () => {
    const { evaluateOrganizationAccess } = await import(
      "../services/auth/organization-access-policy.service.js"
    );
    vi.mocked(evaluateOrganizationAccess).mockClear();
    vi.mocked(evaluateOrganizationAccess).mockResolvedValue({
      allowed: true,
      paymentRestricted: false,
    } as any);

    const db = makeDbMock();
    const refreshTokenRow = {
      id: 51,
      token_hash: "some-hash-2",
      client_id: "empcloud-dashboard",
      user_id: 10,
      organization_id: 5,              // real org
      scope: "openid",
      revoked_at: null,
      expires_at: new Date(Date.now() + 86400000),
    };

    db.mockImplementation((table: string) => {
      if (table === "oauth_refresh_tokens") {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(refreshTokenRow),
        };
      }
      if (table === "oauth_access_tokens") {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        };
      }
      return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
    });

    const { introspectToken } = await freshOauthService(db);
    await introspectToken({ token: "not-a-jwt", tokenTypeHint: "refresh_token" });

    expect(evaluateOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 5 }),
    );
  });
});

// ── 4. createAuthorizationCode() — super_admin OIDC flow ─────────────────────

describe("createAuthorizationCode() — super_admin (org_id = 0)", () => {
  it("stores organization_id = null for super_admin", async () => {
    const db = makeDbMock();
    const { createAuthorizationCode } = await freshOauthService(db);

    await createAuthorizationCode({
      clientId: "empcloud-dashboard",
      userId: 2,
      organizationId: 0,              // super_admin sentinel
      redirectUri: "http://localhost:5173/callback",
      scope: "openid profile email",
    });

    const codeInserts = db._inserts["oauth_authorization_codes"];
    expect(codeInserts).toHaveLength(1);
    expect((codeInserts[0] as any).organization_id).toBeNull();
  });

  it("preserves real organization_id for normal org users", async () => {
    const db = makeDbMock();
    const { createAuthorizationCode } = await freshOauthService(db);

    await createAuthorizationCode({
      clientId: "empcloud-dashboard",
      userId: 10,
      organizationId: 5,
      redirectUri: "http://localhost:5173/callback",
      scope: "openid profile email",
    });

    const codeInserts = db._inserts["oauth_authorization_codes"];
    expect((codeInserts[0] as any).organization_id).toBe(5);
  });
});
