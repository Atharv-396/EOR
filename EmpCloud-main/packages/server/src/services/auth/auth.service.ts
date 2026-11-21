// =============================================================================
// EMP CLOUD — Auth Service
// Registration, login, password management.
// =============================================================================

import { getDB } from "../../db/connection.js";
import { hashPassword, verifyPassword, randomHex, hashToken } from "../../utils/crypto.js";
import {
  UnauthorizedError,
  ConflictError,
  NotFoundError,
  ValidationError,
  OrganizationLoginBlockedError,
} from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { logAudit } from "../audit/audit.service.js";
import { issueTokens } from "../oauth/oauth.service.js";
import { sendPasswordResetEmail, sendWelcomeEmail } from "../email/email.service.js";
import { seedDefaultCategories } from "../document/document.service.js";
import { TOKEN_DEFAULTS, AuditAction } from "@empcloud/shared";
import type { UserRole } from "@empcloud/shared";
import { evaluateOrganizationAccess } from "./organization-access-policy.service.js";

// Internal client_id used for direct auth (login/register via EMP Cloud itself)
const EMPCLOUD_CLIENT_ID = "empcloud-dashboard";

// ---------------------------------------------------------------------------
// Register (creates org + admin user)
// ---------------------------------------------------------------------------

export async function register(params: {
  orgName: string;
  orgLegalName?: string;
  orgCountry?: string;
  orgState?: string;
  orgTimezone?: string;
  orgEmail?: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}): Promise<{ user: object; org: object; tokens: object }> {
  const db = getDB();

  try {
    // Check if email already exists — use FOR UPDATE to prevent race conditions
    const existing = await db("users").where({ email: params.email }).forUpdate().first();
    if (existing) {
      logger.warn("Registration attempt with duplicate email", {
        email: params.email,
        existingUserId: existing.id,
      });
      throw new ConflictError("An account with this email already exists");
    }

    const passwordHash = await hashPassword(params.password);

    // Create organization within a transaction to ensure atomicity.
    // If any step fails, the entire registration rolls back.
    const result = await db.transaction(async (trx) => {
      // Create organization (org_id=0 is reserved for super_admin platform accounts)
      const [orgId] = await trx("organizations").insert({
        name: params.orgName,
        legal_name: params.orgLegalName || params.orgName,
        email: params.orgEmail || params.email,
        country: params.orgCountry || "IN",
        state: params.orgState || null,
        timezone: params.orgTimezone || "Asia/Kolkata",
        is_active: true,
        current_user_count: 1,
        total_allowed_user_count: 10, // default starter
        created_at: new Date(),
        updated_at: new Date(),
      });

      logger.debug("Organization created", { orgId, orgName: params.orgName });

      // Create admin user
      const now = new Date();
      const [userId] = await trx("users").insert({
        organization_id: orgId,
        first_name: params.firstName,
        last_name: params.lastName,
        email: params.email,
        password: passwordHash,
        password_changed_at: now,
        role: "org_admin",
        status: 1,
        date_of_joining: now.toISOString().slice(0, 10),
        created_at: now,
        updated_at: now,
      });

      logger.debug("User created", { userId, email: params.email, orgId });

      const user = await trx("users").where({ id: userId }).first();
      const org = await trx("organizations").where({ id: orgId }).first();

      if (!user || !org) {
        throw new Error("Failed to retrieve newly created user or organization");
      }

      return { user, org, orgId };
    });

    const { user, org, orgId } = result;

    // Seed default document categories — best-effort, non-blocking
    try {
      await seedDefaultCategories(orgId);
    } catch (err) {
      logger.error("Failed to seed default document categories", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue — document categories are nice-to-have, not required
    }

    // Issue tokens — if this fails, org+user are already created but will be orphaned
    let tokens: object;
    try {
      tokens = await issueTokens({
        userId: user.id,
        orgId: org.id,
        email: user.email,
        role: user.role as UserRole,
        firstName: user.first_name,
        lastName: user.last_name,
        orgName: org.name,
        scope: "openid profile email",
        clientId: EMPCLOUD_CLIENT_ID,
      });
      logger.debug("Tokens issued successfully", { userId: user.id, orgId: org.id });
    } catch (tokenErr) {
      logger.error("Token issuance failed after user registration", {
        userId: user.id,
        orgId: org.id,
        email: user.email,
        tokenError: tokenErr instanceof Error ? tokenErr.message : String(tokenErr),
      });
      throw tokenErr;
    }

    logger.info("New organization registered", {
      orgId: org.id,
      orgName: org.name,
      email: user.email,
      userId: user.id,
    });

    // Fire-and-forget welcome email — the service itself swallows errors
    void sendWelcomeEmail({
      to: user.email,
      firstName: user.first_name,
      orgName: org.name,
    }).catch((err) => {
      logger.warn("Welcome email failed (non-blocking)", {
        email: user.email,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Return sanitized user (no password)
    const { password: _, ...safeUser } = user;
    return { user: safeUser, org, tokens };
  } catch (err) {
    // Log all registration errors with useful context for debugging
    if (err instanceof ConflictError) {
      // 409 — duplicate email, already logged above
      throw err;
    }

    if (err instanceof Error) {
      logger.error("Registration failed", {
        email: params.email,
        orgName: params.orgName,
        errorMessage: err.message,
        errorCode: (err as any).code,
      });
    } else {
      logger.error("Registration failed (non-Error thrown)", {
        email: params.email,
        orgName: params.orgName,
        error: String(err),
      });
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function login(params: {
  email: string;
  password: string;
}): Promise<{
  user: object;
  org: object | null;
  tokens: object;
  password_expired?: boolean;
  payment_restricted: boolean;
}> {
  const db = getDB();

  try {
    // Look up user by email
    let user: any;
    try {
      user = await db("users").where({ email: params.email }).first();
    } catch (dbErr) {
      logger.error("Database error during user lookup", {
        email: params.email,
        errorMessage: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
      throw dbErr;
    }

    if (!user || !user.password) {
      throw new UnauthorizedError("Invalid email or password");
    }

    // Check if account is deactivated (inactive status or past exit date)
    if (user.status !== 1) {
      throw new UnauthorizedError("Account is deactivated");
    }
    if (user.date_of_exit) {
      const exitDate = new Date(user.date_of_exit);
      exitDate.setHours(23, 59, 59, 999);
      if (exitDate < new Date()) {
        throw new UnauthorizedError("Account is deactivated");
      }
    }

    // Verify password — bcrypt.compare() never throws on invalid hash, but catch
    // any unexpected errors (e.g., corrupted hash format, bcrypt library errors)
    let valid: boolean;
    try {
      valid = await verifyPassword(params.password, user.password);
    } catch (pwErr) {
      logger.error("Error during password verification", {
        email: params.email,
        userId: user.id,
        errorMessage: pwErr instanceof Error ? pwErr.message : String(pwErr),
      });
      throw pwErr;
    }

    if (!valid) {
      // #1049 — Record failed login attempt in audit log
      await logAudit({
        organizationId: user.organization_id,
        userId: user.id,
        action: AuditAction.LOGIN_FAILED,
        details: { email: params.email, reason: "invalid_password" },
      });
      throw new UnauthorizedError("Invalid email or password");
    }

    // Super admins live at organization_id=0 (a sentinel id reserved by
    // migration 036 — no real org has id=0, MySQL auto_increment starts at
    // 1). The convention keeps super admins out of every tenant's user
    // list, but it also means the standard "look up org row and check
    // is_active" gate would fail closed for every super_admin login since
    // there is no row at id=0. Skip the org-active gate for super_admins;
    // for everyone else the gate is unchanged.
    const isSuperAdmin = user.role === "super_admin";
    let org: any = null;
    if (!isSuperAdmin) {
      try {
        org = await db("organizations").where({ id: user.organization_id }).first();
      } catch (dbErr) {
        logger.error("Database error during org lookup", {
          email: params.email,
          userId: user.id,
          orgId: user.organization_id,
          errorMessage: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
        throw dbErr;
      }

      if (!org || !org.is_active) {
        throw new UnauthorizedError("Organization is inactive");
      }
    }

    // Evaluate organization access — catch unexpected errors
    let organizationAccess: any;
    try {
      organizationAccess = await evaluateOrganizationAccess({
        organizationId: org?.id ?? 0,
        organization: org,
        // Payment-restricted organizations must still be able to authenticate so
        // an authorized admin can reach the invoice and checkout screens.
        paymentResolutionRequest: true,
      });
    } catch (accessErr) {
      logger.error("Error during organization access evaluation", {
        email: params.email,
        userId: user.id,
        orgId: org?.id ?? 0,
        errorMessage: accessErr instanceof Error ? accessErr.message : String(accessErr),
      });
      throw accessErr;
    }

    if (!organizationAccess.allowed && organizationAccess.code === "LOGIN_BLOCKED") {
      throw new OrganizationLoginBlockedError(organizationAccess.message);
    }

    // --- Password expiry check ---
    // If the org has a password_expiry_days policy (> 0), check if the user's
    // password is older than that many days and flag it in the response.
    // Super admins have no org policy -- treat as no expiry.
    let passwordExpired = false;
    const expiryDays = org?.password_expiry_days ?? 0;
    if (expiryDays > 0) {
      const changedAt = user.password_changed_at
        ? new Date(user.password_changed_at)
        : new Date(user.created_at);
      const ageMs = Date.now() - changedAt.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays >= expiryDays) {
        passwordExpired = true;
      }
    }

    // Issue tokens — if this fails, the user authenticated but we cannot proceed.
    // Log with full context before throwing.
    let tokens: object;
    try {
      tokens = await issueTokens({
        userId: user.id,
        orgId: org?.id ?? 0,
        email: user.email,
        role: user.role as UserRole,
        firstName: user.first_name,
        lastName: user.last_name,
        orgName: org?.name ?? "EMP Cloud Platform",
        scope: "openid profile email",
        clientId: EMPCLOUD_CLIENT_ID,
      });
      logger.debug("Tokens issued successfully", { userId: user.id, orgId: org?.id ?? 0 });
    } catch (tokenErr) {
      logger.error("Token issuance failed during login", {
        email: user.email,
        userId: user.id,
        orgId: org?.id ?? 0,
        tokenError: tokenErr instanceof Error ? tokenErr.message : String(tokenErr),
      });
      throw tokenErr;
    }

    logger.info("User logged in successfully", {
      email: user.email,
      userId: user.id,
      orgId: org?.id ?? 0,
      orgName: org?.name ?? "Platform",
    });

    const { password: _, ...safeUser } = user;
    return {
      user: safeUser,
      org,
      tokens,
      password_expired: passwordExpired,
      payment_restricted: organizationAccess.paymentRestricted,
    };
  } catch (err) {
    // Log all login errors with context (no passwords, tokens, or secrets)
    if (err instanceof UnauthorizedError || err instanceof OrganizationLoginBlockedError) {
      // Expected auth errors, already logged above if applicable
      throw err;
    }

    if (err instanceof Error) {
      logger.error("Login failed", {
        email: params.email,
        errorMessage: err.message,
        errorCode: (err as any).code,
      });
    } else {
      logger.error("Login failed (non-Error thrown)", {
        email: params.email,
        error: String(err),
      });
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Change Password
// ---------------------------------------------------------------------------

export async function changePassword(params: {
  userId: number;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const db = getDB();

  const user = await db("users").where({ id: params.userId }).first();
  if (!user || !user.password) {
    throw new NotFoundError("User");
  }

  const valid = await verifyPassword(params.currentPassword, user.password);
  if (!valid) {
    throw new UnauthorizedError("Current password is incorrect");
  }

  const newHash = await hashPassword(params.newPassword);
  const now = new Date();
  await db("users").where({ id: params.userId }).update({
    password: newHash,
    password_changed_at: now,
    updated_at: now,
  });
}

// ---------------------------------------------------------------------------
// Forgot Password — create reset token
// ---------------------------------------------------------------------------

export async function forgotPassword(email: string): Promise<{ token: string } | null> {
  const db = getDB();

  const user = await db("users").where({ email, status: 1 }).first();
  if (!user) {
    // Don't reveal whether email exists
    return null;
  }

  const token = randomHex(32);
  const expiresAt = new Date(Date.now() + TOKEN_DEFAULTS.PASSWORD_RESET_EXPIRY * 1000);

  await db("password_reset_tokens").insert({
    user_id: user.id,
    token_hash: hashToken(token),
    expires_at: expiresAt,
    created_at: new Date(),
  });

  // Fire-and-forget reset email — the service swallows errors so we don't
  // leak whether the email exists via timing or response differences.
  void sendPasswordResetEmail({
    to: user.email,
    firstName: user.first_name || "",
    token,
  });

  return { token };
}

// ---------------------------------------------------------------------------
// Reset Password — consume reset token
// ---------------------------------------------------------------------------

export async function resetPassword(params: {
  token: string;
  newPassword: string;
}): Promise<void> {
  const db = getDB();

  const tokenRecord = await db("password_reset_tokens")
    .where({ token_hash: hashToken(params.token) })
    .whereNull("used_at")
    .first();

  if (!tokenRecord) {
    throw new ValidationError("Invalid or expired reset token");
  }

  if (new Date(tokenRecord.expires_at) < new Date()) {
    throw new ValidationError("Reset token has expired");
  }

  const newHash = await hashPassword(params.newPassword);

  const now = new Date();
  await db.transaction(async (trx) => {
    await trx("users").where({ id: tokenRecord.user_id }).update({
      password: newHash,
      password_changed_at: now,
      updated_at: now,
    });
    await trx("password_reset_tokens")
      .where({ id: tokenRecord.id })
      .update({ used_at: now });
  });
}
