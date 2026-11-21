// =============================================================================
// AUTH LOGIN TESTS
// Tests for login success, wrong password, unknown email, DB failure, JWT failure.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { login } from "../services/auth/auth.service.js";
import {
  UnauthorizedError,
  OrganizationLoginBlockedError,
} from "../utils/errors.js";

// Mock all dependencies at module level
vi.mock("../db/connection.js");
vi.mock("../utils/crypto.js", () => ({
  verifyPassword: vi.fn(async (pwd, hash) => pwd === "correct_password"),
}));
vi.mock("../services/oauth/oauth.service.js");
vi.mock("../services/auth/organization-access-policy.service.js");
vi.mock("../services/audit/audit.service.js");
vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("Auth Login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successfully logs in user and returns tokens", async () => {
    const { getDB } = require("../db/connection.js");
    const { verifyPassword } = require("../utils/crypto.js");
    const { issueTokens } = require("../services/oauth/oauth.service.js");
    const { evaluateOrganizationAccess } = require("../services/auth/organization-access-policy.service.js");
    const { logger } = require("../utils/logger.js");

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: null,
      role: "employee",
      organization_id: 5,
      first_name: "John",
      last_name: "Doe",
      password_changed_at: new Date(),
      created_at: new Date(),
    };

    const mockOrg = {
      id: 5,
      name: "Test Company",
      is_active: true,
      password_expiry_days: 0,
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
      organizations: { where: () => ({ first: async () => mockOrg }) },
    });

    evaluateOrganizationAccess.mockResolvedValue({
      allowed: true,
      paymentRestricted: false,
    });

    issueTokens.mockResolvedValue({
      access_token: "eyJ...",
      refresh_token: "rt...",
      expires_in: 900,
      token_type: "Bearer",
      scope: "openid profile email",
    });

    const result = await login({
      email: "user@example.com",
      password: "correct_password",
    });

    expect(result.user).toMatchObject({
      id: 101,
      email: "user@example.com",
    });
    expect(result.user).not.toHaveProperty("password");
    expect(result.org).toEqual(mockOrg);
    expect(result.tokens).toHaveProperty("access_token");
    expect(result.password_expired).toBe(false);
    expect(result.payment_restricted).toBe(false);

    expect(logger.info).toHaveBeenCalledWith(
      "User logged in successfully",
      expect.objectContaining({
        email: "user@example.com",
        userId: 101,
      })
    );
  });

  it("returns 401 for unknown email", async () => {
    const { getDB } = require("../db/connection.js");
    const { logger } = require("../utils/logger.js");

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => null }) },
    });

    await expect(
      login({
        email: "unknown@example.com",
        password: "anypassword",
      })
    ).rejects.toThrow(UnauthorizedError);

    expect(logger.error).toHaveBeenCalledWith(
      "Login failed",
      expect.objectContaining({
        email: "unknown@example.com",
      })
    );
  });

  it("returns 401 for wrong password", async () => {
    const { getDB } = require("../db/connection.js");
    const { logAudit } = require("../services/audit/audit.service.js");

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: null,
      role: "employee",
      organization_id: 5,
      first_name: "John",
      last_name: "Doe",
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
    });

    await expect(
      login({
        email: "user@example.com",
        password: "wrong_password",
      })
    ).rejects.toThrow(UnauthorizedError);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 101,
        action: "LOGIN_FAILED",
        details: { email: "user@example.com", reason: "invalid_password" },
      })
    );
  });

  it("returns 401 for deactivated user (status != 1)", async () => {
    const { getDB } = require("../db/connection.js");

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 0, // Deactivated
      date_of_exit: null,
      role: "employee",
      organization_id: 5,
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
    });

    await expect(
      login({
        email: "user@example.com",
        password: "correct_password",
      })
    ).rejects.toThrow("Account is deactivated");
  });

  it("returns 401 for user past exit date", async () => {
    const { getDB } = require("../db/connection.js");

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1); // Yesterday

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: pastDate.toISOString().slice(0, 10),
      role: "employee",
      organization_id: 5,
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
    });

    await expect(
      login({
        email: "user@example.com",
        password: "correct_password",
      })
    ).rejects.toThrow("Account is deactivated");
  });

  it("returns 401 for inactive organization", async () => {
    const { getDB } = require("../db/connection.js");

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: null,
      role: "employee",
      organization_id: 5,
      first_name: "John",
      last_name: "Doe",
    };

    const mockOrg = {
      id: 5,
      name: "Test Company",
      is_active: false,
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
      organizations: { where: () => ({ first: async () => mockOrg }) },
    });

    await expect(
      login({
        email: "user@example.com",
        password: "correct_password",
      })
    ).rejects.toThrow("Organization is inactive");
  });

  it("returns 403 when organization login is blocked", async () => {
    const { getDB } = require("../db/connection.js");
    const { evaluateOrganizationAccess } = require("../services/auth/organization-access-policy.service.js");

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: null,
      role: "employee",
      organization_id: 5,
      first_name: "John",
      last_name: "Doe",
      password_changed_at: new Date(),
    };

    const mockOrg = {
      id: 5,
      name: "Test Company",
      is_active: true,
      password_expiry_days: 0,
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
      organizations: { where: () => ({ first: async () => mockOrg }) },
    });

    evaluateOrganizationAccess.mockResolvedValue({
      allowed: false,
      code: "LOGIN_BLOCKED",
      message: "Login disabled for payment reasons",
    });

    await expect(
      login({
        email: "user@example.com",
        password: "correct_password",
      })
    ).rejects.toThrow(OrganizationLoginBlockedError);
  });

  it("logs database error during user lookup and rethrows", async () => {
    const { getDB } = require("../db/connection.js");
    const { logger } = require("../utils/logger.js");

    getDB.mockReturnValue({
      users: {
        where: () => ({
          first: async () => {
            throw new Error("Connection timeout");
          },
        }),
      },
    });

    await expect(
      login({
        email: "user@example.com",
        password: "anypassword",
      })
    ).rejects.toThrow("Connection timeout");

    expect(logger.error).toHaveBeenCalledWith(
      "Database error during user lookup",
      expect.objectContaining({
        email: "user@example.com",
      })
    );
  });

  it("logs and rethrows token issuance failure", async () => {
    const { getDB } = require("../db/connection.js");
    const { issueTokens } = require("../services/oauth/oauth.service.js");
    const { evaluateOrganizationAccess } = require("../services/auth/organization-access-policy.service.js");
    const { logger } = require("../utils/logger.js");

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: null,
      role: "employee",
      organization_id: 5,
      first_name: "John",
      last_name: "Doe",
      password_changed_at: new Date(),
      created_at: new Date(),
    };

    const mockOrg = {
      id: 5,
      name: "Test Company",
      is_active: true,
      password_expiry_days: 0,
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
      organizations: { where: () => ({ first: async () => mockOrg }) },
    });

    evaluateOrganizationAccess.mockResolvedValue({
      allowed: true,
      paymentRestricted: false,
    });

    issueTokens.mockRejectedValue(
      new Error("RSA private key not loaded — check startup logs")
    );

    await expect(
      login({
        email: "user@example.com",
        password: "correct_password",
      })
    ).rejects.toThrow("RSA private key not loaded");

    expect(logger.error).toHaveBeenCalledWith(
      "Token issuance failed during login",
      expect.objectContaining({
        email: "user@example.com",
        userId: 101,
      })
    );
  });

  it("detects password expiry and returns flag", async () => {
    const { getDB } = require("../db/connection.js");
    const { issueTokens } = require("../services/oauth/oauth.service.js");
    const { evaluateOrganizationAccess } = require("../services/auth/organization-access-policy.service.js");

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 100); // 100 days ago

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: null,
      role: "employee",
      organization_id: 5,
      first_name: "John",
      last_name: "Doe",
      password_changed_at: pastDate,
      created_at: new Date(),
    };

    const mockOrg = {
      id: 5,
      name: "Test Company",
      is_active: true,
      password_expiry_days: 90,
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
      organizations: { where: () => ({ first: async () => mockOrg }) },
    });

    evaluateOrganizationAccess.mockResolvedValue({
      allowed: true,
      paymentRestricted: false,
    });

    issueTokens.mockResolvedValue({
      access_token: "eyJ...",
      refresh_token: "rt...",
      expires_in: 900,
      token_type: "Bearer",
      scope: "openid profile email",
    });

    const result = await login({
      email: "user@example.com",
      password: "correct_password",
    });

    expect(result.password_expired).toBe(true);
  });

  it("allows login with payment restriction flag", async () => {
    const { getDB } = require("../db/connection.js");
    const { issueTokens } = require("../services/oauth/oauth.service.js");
    const { evaluateOrganizationAccess } = require("../services/auth/organization-access-policy.service.js");

    const mockUser = {
      id: 101,
      email: "user@example.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: null,
      role: "org_admin",
      organization_id: 5,
      first_name: "John",
      last_name: "Doe",
      password_changed_at: new Date(),
      created_at: new Date(),
    };

    const mockOrg = {
      id: 5,
      name: "Test Company",
      is_active: true,
      password_expiry_days: 0,
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockUser }) },
      organizations: { where: () => ({ first: async () => mockOrg }) },
    });

    evaluateOrganizationAccess.mockResolvedValue({
      allowed: true,
      paymentRestricted: true, // Payment restricted but login allowed
      code: "PAYMENT_RESTRICTED",
    });

    issueTokens.mockResolvedValue({
      access_token: "eyJ...",
      refresh_token: "rt...",
      expires_in: 900,
      token_type: "Bearer",
      scope: "openid profile email",
    });

    const result = await login({
      email: "user@example.com",
      password: "correct_password",
    });

    expect(result.payment_restricted).toBe(true);
  });

  it("allows super_admin login without org check", async () => {
    const { getDB } = require("../db/connection.js");
    const { issueTokens } = require("../services/oauth/oauth.service.js");
    const { evaluateOrganizationAccess } = require("../services/auth/organization-access-policy.service.js");

    const mockSuperAdmin = {
      id: 999,
      email: "admin@platform.com",
      password: "hashed_password",
      status: 1,
      date_of_exit: null,
      role: "super_admin",
      organization_id: 0, // Sentinel value for super admins
      first_name: "Platform",
      last_name: "Admin",
      password_changed_at: new Date(),
      created_at: new Date(),
    };

    getDB.mockReturnValue({
      users: { where: () => ({ first: async () => mockSuperAdmin }) },
      organizations: { where: () => ({ first: async () => null }) }, // Should not be called
    });

    evaluateOrganizationAccess.mockResolvedValue({
      allowed: true,
      paymentRestricted: false,
    });

    issueTokens.mockResolvedValue({
      access_token: "eyJ...",
      refresh_token: "rt...",
      expires_in: 900,
      token_type: "Bearer",
      scope: "openid profile email",
    });

    const result = await login({
      email: "admin@platform.com",
      password: "correct_password",
    });

    expect(result.org).toBeNull();
    expect(result.user.role).toBe("super_admin");
  });
});
