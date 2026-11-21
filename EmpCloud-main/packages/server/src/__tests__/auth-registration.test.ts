// =============================================================================
// AUTH REGISTRATION TESTS
// Tests for registration success, duplicate email (409), and failure cases.
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import { register } from "../services/auth/auth.service.js";
import { ConflictError } from "../utils/errors.js";

// Mock all dependencies at module level
vi.mock("../db/connection.js");
vi.mock("../utils/crypto.js", () => ({
  hashPassword: vi.fn(async (pwd) => `hashed_${pwd}`),
}));
vi.mock("../services/oauth/oauth.service.js");
vi.mock("../services/document/document.service.js");
vi.mock("../services/email/email.service.js");
vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("Auth Registration", () => {
  it("successfully creates org, user, and returns tokens", async () => {
    const { getDB } = require("../db/connection.js");
    const { issueTokens } = require("../services/oauth/oauth.service.js");
    const { logger } = require("../utils/logger.js");

    const mockTrx = {
      users: {
        where: () => ({ first: async () => ({ id: 101, email: "test@example.com", first_name: "Test", last_name: "User", role: "org_admin", password: "hash" }) }),
        insert: async () => [101],
      },
      organizations: {
        where: () => ({ first: async () => ({ id: 1, name: "Test Org" }) }),
        insert: async () => [1],
      },
    };

    getDB.mockReturnValue({
      users: { where: () => ({ forUpdate: () => ({ first: async () => null }) }) },
      transaction: vi.fn(async (cb) => cb(mockTrx)),
    });

    issueTokens.mockResolvedValue({ access_token: "token", refresh_token: "rt", expires_in: 900, token_type: "Bearer", scope: "openid" });

    const result = await register({
      orgName: "Test Org",
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      password: "Pass123!",
    });

    expect(result.user).not.toHaveProperty("password");
    expect(result.tokens).toHaveProperty("access_token");
    expect(logger.info).toHaveBeenCalled();
  });

  it("returns 409 ConflictError for duplicate email", async () => {
    const { getDB } = require("../db/connection.js");
    const { logger } = require("../utils/logger.js");

    getDB.mockReturnValue({
      users: { where: () => ({ forUpdate: () => ({ first: async () => ({ id: 50, email: "existing@test.com" }) }) }) },
    });

    await expect(
      register({
        orgName: "Org",
        firstName: "F",
        lastName: "L",
        email: "existing@test.com",
        password: "Pass123!",
      })
    ).rejects.toThrow(ConflictError);

    expect(logger.warn).toHaveBeenCalledWith(
      "Registration attempt with duplicate email",
      expect.any(Object)
    );
  });

  it("logs and propagates database errors", async () => {
    const { getDB } = require("../db/connection.js");
    const { logger } = require("../utils/logger.js");

    getDB.mockReturnValue({
      users: { where: () => ({ forUpdate: () => ({ first: async () => null }) }) },
      transaction: vi.fn(async () => { throw new Error("DB constraint failed"); }),
    });

    await expect(
      register({
        orgName: "Org",
        firstName: "F",
        lastName: "L",
        email: "test@test.com",
        password: "Pass123!",
      })
    ).rejects.toThrow("DB constraint failed");

    expect(logger.error).toHaveBeenCalledWith(
      "Registration failed",
      expect.objectContaining({
        email: "test@test.com",
        orgName: "Org",
        errorMessage: expect.stringContaining("DB constraint failed"),
      })
    );
  });
});
