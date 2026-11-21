// =============================================================================
// EMP CLOUD — Vercel Cron: Daily Attendance Report
// -----------------------------------------------------------------------------
// Delivers the previous day's attendance report over Telegram to every org
// that has enabled it in Attendance Settings.
//
// Schedule (set in vercel.json): daily at midnight UTC  "0 0 * * *"
// =============================================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { initDB } from "../../src/db/connection.js";
import { sendDailyAttendanceReports } from "../../src/services/attendance/attendance-report.service.js";
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

    // Optional: allow override date via query string for manual testing
    // e.g. GET /api/cron/attendance-report?date=2026-10-01
    const url = new URL(req.url ?? "/", "http://localhost");
    const dateOverride = url.searchParams.get("date") ?? undefined;

    await sendDailyAttendanceReports(dateOverride);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, ran_at: new Date().toISOString() }));
  } catch (err) {
    logger.error("Cron attendance-report failed", { error: (err as Error).message });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}
