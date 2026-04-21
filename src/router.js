import { handleApiRequest } from "./api.js";
import { handleTelegramUpdate } from "./telegram.js";
import {
  constantTimeEqual,
  getAllowedMailDomains,
  json,
  requireMailDomain,
  serializeError,
} from "./utils.js";

async function handleTelegramWebhook(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
  const actualSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expectedSecret || !actualSecret || !constantTimeEqual(actualSecret, expectedSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  try {
    await handleTelegramUpdate(update, env);
  } catch (error) {
    console.error("Telegram update failed", serializeError(error));
  }

  return json({ ok: true });
}

function rootResponse(request, env) {
  const url = new URL(request.url);
  const domain = requireMailDomain(env);
  const domains = getAllowedMailDomains(env);
  return json({
    ok: true,
    service: `${domain} temp mail`,
    mode: "cloudflare_native_storage",
    domain,
    domains,
    telegramWebhook: `${url.origin}/telegram/webhook`,
    api: {
      baseUrl: `${url.origin}/api`,
      auth: "per_user_api_key",
      quota: "1500 requests/day, reset 00:00 WIB",
      access: "Granted by Telegram admin; users check /api in bot.",
      webhook: "Use /api/webhook endpoints to configure API callbacks.",
    },
  });
}

export async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === "/" && request.method === "GET") {
    return rootResponse(request, env);
  }

  if (url.pathname === "/healthz" && request.method === "GET") {
    return json({ ok: true, time: new Date().toISOString() });
  }

  if (url.pathname === "/telegram/webhook") {
    return handleTelegramWebhook(request, env, ctx);
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return handleApiRequest(request, env, ctx);
  }

  return json({ ok: false, error: "not_found" }, { status: 404 });
}
