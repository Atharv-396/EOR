// =============================================================================
// EMP CLOUD — Vercel Cron: Trial Expiration
// -----------------------------------------------------------------------------
// Runs the trial expiration sweep — same logic as the hourly in-process
// interval used on traditional deployments.
//
// Schedule (set in vercel.json): every hour  "0 * * * *"
// =============================================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { initDB } from "../../src/db/connection.js";
import { expireTrials } from "../../src/services/subscription/trial-expiration.service.js";
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

    await expireTrials();

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, ran_at: new Date().toISOString() }));
  } catch (err) {
    logger.error("Cron trial-expiration failed", { error: (err as Error).message });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}
