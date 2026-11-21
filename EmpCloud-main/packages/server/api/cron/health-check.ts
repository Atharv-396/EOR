// =============================================================================
// EMP CLOUD — Vercel Cron: Health Check
// -----------------------------------------------------------------------------
// Vercel invokes this route on the schedule defined in vercel.json.
// It runs the same performFullHealthCheck() logic used by the in-process
// interval on traditional deployments, caching the result in the DB.
//
// Security: Only Vercel's cron runner (and callers who know CRON_SECRET)
// can trigger this. Without the secret the route returns 401.
//
// Schedule (set in vercel.json): every 5 minutes  "*/5 * * * *"
// =============================================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { initDB } from "../../src/db/connection.js";
import { forceHealthCheck } from "../../src/services/admin/health-check.service.js";
import { logger } from "../../src/utils/logger.js";

let dbReady = false;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // ---- Authorization ----
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers["authorization"] ?? "";
    if (authHeader !== `Bearer ${secret}`) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // Only allow GET (Vercel cron uses GET by default)
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end();
    return;
  }

  try {
    if (!dbReady) {
      await initDB();
      dbReady = true;
    }

    const result = await forceHealthCheck();

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        overall_status: result.overall_status,
        healthy: result.healthy_count,
        degraded: result.degraded_count,
        down: result.down_count,
        checked_at: result.last_full_check,
      }),
    );
  } catch (err) {
    logger.error("Cron health-check failed", { error: (err as Error).message });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}
