// =============================================================================
// EMP CLOUD — Telegram Bot Service
//
// One global platform bot (token from TELEGRAM_BOT_TOKEN). Two jobs:
//   1. Reply to /start with the chat's ID, so an admin can paste it into
//      Attendance Settings to receive the daily report (works in a private
//      chat OR a group the bot has been added to).
//   2. Deliver messages (the nightly attendance report) to configured chats.
//
// When no token is configured the bot stays inert — no polling, sends no-op —
// so a dev box without a token simply skips Telegram entirely.
//
// Execution modes:
//
//   TRADITIONAL (local dev / PM2 / Railway)
//     initTelegramBot() calls bot.launch() which starts long-polling.
//
//   VERCEL SERVERLESS
//     initTelegramBot() is called from app.ts but bot.launch() is NOT started
//     (a background process cannot survive a serverless function lifetime).
//     Instead, Telegram sends updates to POST /api/telegram/webhook.
//     The webhook URL is registered once — either automatically on first
//     request (when TELEGRAM_WEBHOOK_URL is set) or manually via the Telegram
//     Bot API: setWebhook({ url }).
//     handleTelegramWebhook(body) dispatches the update through the same
//     registered handlers.
// =============================================================================

import { Telegraf } from "telegraf";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

let bot: Telegraf | null = null;

const TELEGRAM_MAX = 4096;
// Leave headroom for the <pre></pre> wrapper we add per chunk.
const CHUNK_LIMIT = 3800;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Split already-formatted text into Telegram-sized chunks on line boundaries,
 * so a large org's report is never truncated. A single line longer than the
 * limit is hard-split as a last resort.
 */
function chunkOnLines(text: string, limit = CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > limit ? line.slice(0, limit) : line;
    if (current.length + piece.length + 1 > limit) {
      if (current) chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

/**
 * Register the bot's command handlers.
 * Called once regardless of execution mode (polling vs webhook).
 */
function registerHandlers(telegraf: Telegraf): void {
  telegraf.start(async (ctx) => {
    const chatId = ctx.chat?.id;
    const isGroup =
      ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    await ctx.reply(
      `👋 EMP Cloud Attendance Bot\n\n` +
        `This ${isGroup ? "group's" : "chat's"} ID is:\n` +
        `${chatId}\n\n` +
        `Add this ID under Attendance Settings → Telegram Report to receive the daily attendance report here.`,
    );
  });

  telegraf.command("chatid", async (ctx) => {
    await ctx.reply(`Chat ID: ${ctx.chat?.id}`);
  });

  telegraf.catch((err) => {
    logger.error("Telegram bot error", { error: (err as Error)?.message });
  });
}

/**
 * Initialise the bot instance and register command handlers.
 *
 * Traditional mode (non-Vercel): also starts long-polling via bot.launch().
 * Vercel mode: creates the bot instance for sending/webhook only —
 *   long-polling is NOT started.  Telegram must be configured to POST updates
 *   to the TELEGRAM_WEBHOOK_URL (set via setWebhook or automatically on first
 *   webhook invocation).
 *
 * Safe to call multiple times — a second call is a no-op.
 */
export function initTelegramBot(): void {
  if (bot) return;
  const token = config.telegram.botToken;
  if (!token) {
    logger.info("Telegram bot disabled (TELEGRAM_BOT_TOKEN not set)");
    return;
  }

  bot = new Telegraf(token);
  registerHandlers(bot);

  if (process.env.VERCEL) {
    // Webhook mode — Telegram pushes updates to our API route.
    // The bot instance is kept alive to handle incoming updates via
    // handleTelegramWebhook() and to send outbound messages.
    logger.info("Telegram bot initialised in webhook mode (Vercel)");

    // Auto-register the webhook URL if provided. This is a one-time
    // operation that only needs to run once per deployment.
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    if (webhookUrl) {
      bot.telegram
        .setWebhook(webhookUrl)
        .then(() => logger.info(`Telegram webhook registered: ${webhookUrl}`))
        .catch((err) =>
          logger.warn("Telegram webhook registration failed", {
            error: (err as Error)?.message,
          }),
        );
    } else {
      logger.warn(
        "Telegram bot in webhook mode but TELEGRAM_WEBHOOK_URL is not set. " +
          "Register the webhook manually: " +
          `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<your-vercel-url>/api/telegram/webhook`,
      );
    }
    return;
  }

  // Traditional mode: start long-polling.
  bot
    .launch()
    .then(() => logger.info("Telegram bot stopped"))
    .catch((err) => {
      logger.error("Telegram bot failed to launch", { error: err?.message });
      bot = null;
    });

  logger.info("Telegram bot started (long-polling)");
}

export function stopTelegramBot(): void {
  if (bot) {
    try {
      bot.stop("SIGTERM");
    } catch {
      /* already stopping */
    }
    bot = null;
  }
}

export function isTelegramConfigured(): boolean {
  return !!config.telegram.botToken;
}

/**
 * Process an incoming Telegram update (webhook mode only).
 * Called by the Vercel webhook route handler with the raw request body.
 * Returns true if the update was handled, false if no bot is initialised.
 */
export async function handleTelegramWebhook(
  body: Record<string, unknown>,
): Promise<boolean> {
  if (!bot) {
    logger.warn("handleTelegramWebhook called but bot is not initialised");
    return false;
  }
  try {
    await bot.handleUpdate(body as unknown as Parameters<Telegraf["handleUpdate"]>[0]);
    return true;
  } catch (err) {
    logger.error("Telegram webhook update handling failed", {
      error: (err as Error)?.message,
    });
    return false;
  }
}

/**
 * Send a (possibly long) message to one chat, as monospace HTML so tabular
 * reports stay column-aligned. Auto-chunks over Telegram's 4096-char limit.
 * Returns true on full success; logs and returns false on any failure so a
 * single bad chat id never aborts the whole broadcast.
 */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
): Promise<boolean> {
  if (!bot) {
    logger.warn("sendTelegramMessage called but Telegram bot is not running");
    return false;
  }
  const chunks = chunkOnLines(text);
  try {
    for (const chunk of chunks) {
      await bot.telegram.sendMessage(
        chatId,
        `<pre>${escapeHtml(chunk)}</pre>`,
        { parse_mode: "HTML" },
      );
    }
    return true;
  } catch (err: any) {
    logger.error("Failed to send Telegram message", {
      chatId: String(chatId),
      error: err?.message,
    });
    return false;
  }
}
