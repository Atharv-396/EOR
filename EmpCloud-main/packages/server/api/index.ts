// =============================================================================
// EMP CLOUD — Vercel Serverless Entry Point
// -----------------------------------------------------------------------------
// Vercel picks this file up as the single catch-all function when
// `vercel.json` routes everything to `api/index.ts`.
//
// Responsibilities:
//   1. Initialise the database exactly once per cold start (lazy init).
//   2. Bootstrap module api_url values from env vars exactly once.
//   3. Delegate every request to the shared Express application from app.ts.
//
// What this file intentionally does NOT do:
//   • Start `app.listen()` — Vercel invokes the handler directly.
//   • Run DB migrations — migrations must be run as a one-off command before
//     deploying (see deployment guide).
//   • Start Socket.IO — not supported on Vercel serverless; use a separate
//     always-on service (Railway / Render) for real-time features.
//   • Start background intervals — handled by Vercel Cron (see cron routes).
//   • Start the Telegram bot — handled by webhook route (see telegram route).
// =============================================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app.js";
import { initDB, getDB } from "../src/db/connection.js";
import { logger } from "../src/utils/logger.js";

// ---------------------------------------------------------------------------
// One-time initialisation guard
// ---------------------------------------------------------------------------
// In a serverless function, module-level code runs once per cold start.
// Subsequent requests on a warm instance reuse the same module scope.
// We use a promise so concurrent requests on cold start don't double-init.
// ---------------------------------------------------------------------------
let initPromise: Promise<void> | null = null;

async function initialise(): Promise<void> {
  await initDB();

  // Sync module api_url values from env vars — same logic as index.ts, but
  // only runs once per cold start, not on every request.
  const db = getDB();

  const withPath = (
    baseUrl: string | undefined,
    apiPath: string,
  ): string | undefined =>
    baseUrl ? `${baseUrl.replace(/\/+$/, "")}${apiPath}` : undefined;

  const moduleUrls: Record<string, string | undefined> = {
    "emp-billing": withPath(process.env.BILLING_MODULE_URL, "/api/v1"),
    "emp-payroll": withPath(process.env.PAYROLL_MODULE_URL, "/api/v1"),
    "emp-recruit": withPath(process.env.RECRUIT_MODULE_URL, "/api/v1"),
    "emp-performance": withPath(process.env.PERFORMANCE_MODULE_URL, "/api/v1"),
    "emp-rewards": withPath(process.env.REWARDS_MODULE_URL, "/api/v1"),
    "emp-exit": withPath(process.env.EXIT_MODULE_URL, "/api/v1"),
    "emp-lms": withPath(process.env.LMS_MODULE_URL, "/api/v1"),
    "emp-field": withPath(process.env.FIELD_MODULE_URL, "/api/v1"),
    "emp-projects": withPath(process.env.PROJECT_MODULE_URL, "/v1"),
    "emp-monitor": withPath(process.env.MONITOR_MODULE_URL, "/api/v3"),
  };

  for (const [slug, apiUrl] of Object.entries(moduleUrls)) {
    if (!apiUrl) continue;
    try {
      const row = await db("modules").where({ slug }).first();
      if (!row || row.api_url === apiUrl) continue;
      await db("modules")
        .where({ slug })
        .update({ api_url: apiUrl, updated_at: new Date() });
      logger.info(`Module api_url set from env: ${slug} -> ${apiUrl}`);
    } catch {
      /* never block startup on this */
    }
  }
}

function ensureInitialised(): Promise<void> {
  if (!initPromise) {
    initPromise = initialise().catch((err) => {
      // Reset so the next request retries initialisation
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------
// Vercel calls the default export with (req, res) for every request.
// We ensure the DB is ready, then hand off to the Express app.
// ---------------------------------------------------------------------------
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await ensureInitialised();
  } catch (err) {
    logger.error("Serverless init failed", { error: (err as Error).message });
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "Service is starting up" },
      }),
    );
    return;
  }

  const app = createApp();
  // Express application is itself a request handler compatible with Node's
  // http.IncomingMessage / ServerResponse — cast is safe.
  app(req as any, res as any);
}
