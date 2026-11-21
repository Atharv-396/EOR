// =============================================================================
// EMP CLOUD — Express Application Factory
// -----------------------------------------------------------------------------
// Exports `createApp()` which builds and returns a fully configured Express
// application WITHOUT starting a listener, running migrations, or launching
// background workers.  This is the form consumed by both:
//
//   • packages/server/src/index.ts  — traditional long-running server (dev + PM2)
//   • packages/server/src/api/index.ts — Vercel serverless handler
//
// IMPORTANT: Keep this file side-effect-free at import time.  Any code that
// runs at module-level here runs on every cold start of a serverless function.
// DB initialisation is deferred to the first call of `createApp()`.
// =============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { loadKeys } from "./services/oauth/jwt.service.js";
import { errorHandler } from "./api/middleware/error.middleware.js";
import { requestIdMiddleware } from "./api/middleware/request-id.middleware.js";
import { sendSuccess } from "./utils/response.js";

// Docs
import { swaggerUIHandler, openapiHandler } from "./api/docs/index.js";
import { recordMounts } from "./api/docs/route-recorder.js";

// Self-hosted Swagger UI assets
const swaggerUiAssetPath = createRequire(import.meta.url)(
  "swagger-ui-dist",
).getAbsoluteFSPath();

// Route imports
import authRoutes from "./api/routes/auth.routes.js";
import oauthRoutes from "./api/routes/oauth.routes.js";
import orgRoutes from "./api/routes/org.routes.js";
import userRoutes from "./api/routes/user.routes.js";
import moduleRoutes from "./api/routes/module.routes.js";
import subscriptionRoutes from "./api/routes/subscription.routes.js";
import auditRoutes from "./api/routes/audit.routes.js";
import employeeRoutes from "./api/routes/employee.routes.js";
import attendanceRoutes from "./api/routes/attendance.routes.js";
import leaveRoutes from "./api/routes/leave.routes.js";
import documentRoutes from "./api/routes/document.routes.js";
import announcementRoutes from "./api/routes/announcement.routes.js";
import emailTemplateRoutes from "./api/routes/email-template.routes.js";
import policyRoutes from "./api/routes/policy.routes.js";
import notificationRoutes from "./api/routes/notification.routes.js";
import dashboardRoutes from "./api/routes/dashboard.routes.js";
import billingWebhookRoutes from "./api/routes/billing-webhook.routes.js";
import moduleWebhookRoutes from "./api/routes/module-webhook.routes.js";
import billingRoutes from "./api/routes/billing.routes.js";
import adminRoutes from "./api/routes/admin.routes.js";
import onboardingRoutes from "./api/routes/onboarding.routes.js";
import biometricLegacyRoutes from "./api/routes/biometric-legacy.routes.js";
import fieldLegacyRoutes from "./api/routes/field-legacy.routes.js";
import nasRoutes from "./api/routes/nas.routes.js";
import helpdeskRoutes from "./api/routes/helpdesk.routes.js";
import surveyRoutes from "./api/routes/survey.routes.js";
import assetRoutes from "./api/routes/asset.routes.js";
import positionRoutes from "./api/routes/position.routes.js";
import feedbackRoutes from "./api/routes/anonymous-feedback.routes.js";
import eventRoutes from "./api/routes/event.routes.js";
import whistleblowingRoutes from "./api/routes/whistleblowing.routes.js";
import chatbotRoutes from "./api/routes/chatbot.routes.js";
import chatRoutes from "./api/routes/chat.routes.js";
import forumRoutes from "./api/routes/forum.routes.js";
import wellnessRoutes from "./api/routes/wellness.routes.js";
import managerRoutes from "./api/routes/manager.routes.js";
import customFieldRoutes from "./api/routes/custom-field.routes.js";
import aiConfigRoutes from "./api/routes/ai-config.routes.js";
import logRoutes from "./api/routes/logs.routes.js";
import roleRoutes from "./api/routes/role.routes.js";
import apiKeyRoutes from "./api/routes/api-key.routes.js";
import locationLegacyRoutes from "./api/routes/location-legacy.routes.js";
import assistantRoutes from "./api/routes/assistant.routes.js";

// ---------------------------------------------------------------------------
// Singleton guard — createApp() is idempotent: calling it twice on a warm
// serverless instance returns the same app object instead of double-mounting
// all routes.
// ---------------------------------------------------------------------------
let _app: express.Application | null = null;

export function createApp(): express.Application {
  if (_app) return _app;

  // Load RSA keys at app-creation time (not inside main()) so they are
  // available on cold starts before the first request is served.
  loadKeys();

  const app = express();

  // Record route mounts for OpenAPI auto-discovery
  recordMounts(app);

  // Trust proxy (behind Nginx / Vercel edge)
  app.set("trust proxy", 1);

  // ---- Global middleware ----
  app.use(requestIdMiddleware);

  const helmetDefault = helmet();
  const helmetNoCSP = helmet({ contentSecurityPolicy: false });
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/docs")) return helmetNoCSP(req, res, next);
    return helmetDefault(req, res, next);
  });

  app.use(
    cors({
      origin: config.cors.allowedOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-EmpCloud-API-Key",
        "X-Device-API-Key",
        "X-Request-ID",
      ],
    }),
  );
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Static assets (email logos etc.)
  const publicDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../public",
  );
  app.use("/static", express.static(publicDir, { maxAge: "30d" }));

  // ---- Rate limiting ----
  const disabled = process.env.RATE_LIMIT_DISABLED === "true";
  const noop = (_req: any, _res: any, next: any) => next();

  const authLimiter = disabled
    ? noop
    : rateLimit({
        windowMs: config.rateLimit.auth.windowMs,
        max: config.rateLimit.auth.max,
        standardHeaders: true,
        legacyHeaders: false,
      });

  const apiLimiter = disabled
    ? noop
    : rateLimit({
        windowMs: config.rateLimit.api.windowMs,
        max: config.rateLimit.api.max,
        standardHeaders: true,
        legacyHeaders: false,
      });

  if (disabled) logger.info("Rate limiting DISABLED");

  // ---- Health check ----
  app.get("/health", (_req, res) => {
    const data: Record<string, string> = {
      status: "healthy",
      timestamp: new Date().toISOString(),
    };
    if (!config.isProd) data.version = "1.0.0";
    sendSuccess(res, data);
  });

  // ---- Routes ----
  app.use("/", oauthRoutes);

  app.use("/api/v1/webhooks", billingWebhookRoutes);
  app.use("/api/v1/webhooks", moduleWebhookRoutes);

  // Client error reporting
  app.post("/api/v1/logs/client-error", apiLimiter, (req, res) => {
    const { message, stack, url, component, userId, userAgent, timestamp, level } =
      req.body;
    if (!message) {
      res
        .status(400)
        .json({ success: false, error: { code: "VALIDATION_ERROR", message: "message is required" } });
      return;
    }
    logger.error(`CLIENT_ERROR: ${String(message).substring(0, 500)}`, {
      source: "frontend",
      errorMessage: String(message).substring(0, 1000),
      stack: stack ? String(stack).substring(0, 2000) : undefined,
      url: url || undefined,
      component: component || undefined,
      userId: userId || null,
      userAgent: userAgent || req.headers["user-agent"],
      clientTimestamp: timestamp || new Date().toISOString(),
      errorLevel: level || "error",
      ip: req.ip,
    });
    res.json({ success: true });
  });

  app.use("/api/v1/auth", authLimiter, authRoutes);
  app.use("/oauth", authLimiter, oauthRoutes);
  app.use("/api/v1/organizations", apiLimiter, orgRoutes);
  app.use("/api/v1/users", apiLimiter, userRoutes);
  app.use("/api/v1/modules", apiLimiter, moduleRoutes);
  app.use("/api/v1/subscriptions", apiLimiter, subscriptionRoutes);
  app.use("/api/v1/audit", apiLimiter, auditRoutes);
  app.use("/api/v1/employees", apiLimiter, employeeRoutes);
  app.use("/api/v1/attendance", apiLimiter, attendanceRoutes);
  app.use("/api/v1/leave", apiLimiter, leaveRoutes);
  app.use("/api/v1/documents", apiLimiter, documentRoutes);
  app.use("/api/v1/announcements", apiLimiter, announcementRoutes);
  app.use("/api/v1/email-templates", apiLimiter, emailTemplateRoutes);
  app.use("/api/v1/policies", apiLimiter, policyRoutes);
  app.use("/api/v1/notifications", apiLimiter, notificationRoutes);
  app.use("/api/v1/dashboard", apiLimiter, dashboardRoutes);
  app.use("/api/v1/billing", apiLimiter, billingRoutes);
  app.use("/api/v1/admin", apiLimiter, adminRoutes);
  app.use("/api/v1/admin/ai-config", apiLimiter, aiConfigRoutes);
  app.use("/api/v1/admin/logs", apiLimiter, logRoutes);
  app.use("/api/v1/onboarding", apiLimiter, onboardingRoutes);
  app.use("/api/v3/biometric", apiLimiter, biometricLegacyRoutes);
  app.use("/api/v3", apiLimiter, fieldLegacyRoutes);
  app.use("/api/v3/location", apiLimiter, locationLegacyRoutes);
  app.use("/api/v3/nas", apiLimiter, nasRoutes);
  app.use("/api/v1/helpdesk", apiLimiter, helpdeskRoutes);
  app.use("/api/v1/surveys", apiLimiter, surveyRoutes);
  app.use("/api/v1/assets", apiLimiter, assetRoutes);
  app.use("/api/v1/positions", apiLimiter, positionRoutes);
  app.use("/api/v1/feedback", apiLimiter, feedbackRoutes);
  app.use("/api/v1/events", apiLimiter, eventRoutes);
  app.use("/api/v1/whistleblowing", apiLimiter, whistleblowingRoutes);
  app.use("/api/v1/chatbot", apiLimiter, chatbotRoutes);
  app.use("/api/v1/chat", apiLimiter, chatRoutes);
  app.use("/api/v1/forum", apiLimiter, forumRoutes);
  app.use("/api/v1/wellness", apiLimiter, wellnessRoutes);
  app.use("/api/v1/manager", apiLimiter, managerRoutes);
  app.use("/api/v1/custom-fields", apiLimiter, customFieldRoutes);
  app.use("/api/v1/roles", apiLimiter, roleRoutes);
  app.use("/api/v1/api-keys", apiLimiter, apiKeyRoutes);
  app.use("/api/v1/assistant", apiLimiter, assistantRoutes);

  // API Docs
  app.use(
    "/api/docs/ui",
    express.static(swaggerUiAssetPath, { maxAge: "7d", immutable: true }),
  );
  app.get("/api/docs", swaggerUIHandler);
  app.get("/api/docs/openapi.json", openapiHandler);

  // JSON 404 for unmatched /api paths
  app.use("/api", (_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Endpoint not found" },
    });
  });

  // ---- SPA static serving (production traditional deploy only) ----
  // On Vercel the frontend is a separate project; this block only fires when
  // config.isProd is true AND the client dist directory actually exists on disk
  // (i.e. a combined single-server traditional deployment, not Vercel).
  if (config.isProd && !process.env.VERCEL) {
    const clientDistDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../client/dist",
    );
    app.use(
      express.static(clientDistDir, { maxAge: "1y", immutable: true, index: false }),
    );
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(clientDistDir, "index.html"));
    });
  }

  app.use(errorHandler);

  _app = app;
  return app;
}

/** Reset the singleton (used in tests). */
export function resetApp(): void {
  _app = null;
}
