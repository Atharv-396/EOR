// =============================================================================
// EMP CLOUD — Vercel Function: Telegram Webhook
// -----------------------------------------------------------------------------
// Telegram sends a POST request to this URL for every update (message,
// command, etc.) when the bot is in webhook mode.
//
// Security:
//   • Telegram sends a secret token in the X-Telegram-Bot-Api-Secret-Token
//     header when TELEGRAM_WEBHOOK_SECRET is configured via setWebhook().
//   • We validate that header before processing any update.
//   • If TELEGRAM_WEBHOOK_SECRET is not set we still accept (less secure —
//     set it in production).
//
// Setup:
//   Set TELEGRAM_WEBHOOK_URL=https://<your-backend>.vercel.app/api/telegram/webhook
//   and optionally TELEGRAM_WEBHOOK_SECRET=<random-string> in Vercel env vars.
//   The bot auto-registers the URL on cold start when TELEGRAM_WEBHOOK_URL is set
//   (see telegram.service.ts → initTelegramBot).
// =============================================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { initDB } from "../../src/db/connection.js";
import {
  initTelegramBot,
  handleTelegramWebhook,
} from "../../src/services/telegram/telegram.service.js";
import { logger } from "../../src/utils/logger.js";

let initialised = false;

async function ensureInitialised(): Promise<void> {
  if (initialised) return;
  await initDB();
  initTelegramBot();
  initialised = true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Only POST is used by Telegram
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end();
    return;
  }

  // Validate Telegram's secret token header (if configured)
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const incomingSecret =
      req.headers["x-telegram-bot-api-secret-token"] ?? "";
    if (incomingSecret !== expectedSecret) {
      res.statusCode = 401;
      res.end();
      return;
    }
  }

  try {
    await ensureInitialised();

    const rawBody = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    await handleTelegramWebhook(body);

    // Telegram expects a 200 OK to acknowledge the update — no body required.
    res.statusCode = 200;
    res.end();
  } catch (err) {
    logger.error("Telegram webhook handler failed", {
      error: (err as Error).message,
    });
    // Return 200 anyway — a non-2xx causes Telegram to retry indefinitely
    res.statusCode = 200;
    res.end();
  }
}
