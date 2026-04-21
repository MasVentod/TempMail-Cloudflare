import {
  DEFAULT_INBOX_TTL_HOURS,
  DEFAULT_MAX_BODY_CHARS,
  WIB_OFFSET_MS,
} from "./constants.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function json(value, init = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function apiError(error, status) {
  return json({ ok: false, error }, { status });
}

export function requireMailDomain(env) {
  const domains = getAllowedMailDomains(env);
  if (domains.length === 0) {
    throw new Error("MAIL_DOMAIN belum dikonfigurasi.");
  }

  return domains[0];
}

export function getAllowedMailDomains(env) {
  const values = [];
  const rawPrimary = String(env.MAIL_DOMAIN ?? "").trim().toLowerCase();
  if (rawPrimary) {
    values.push(rawPrimary);
  }

  const rawDomains = String(env.MAIL_DOMAINS ?? "").trim().toLowerCase();
  if (rawDomains) {
    const splitValues = rawDomains.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean);
    values.push(...splitValues);
  }

  const seen = new Set();
  const domains = [];
  for (const value of values) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    domains.push(value);
  }

  return domains;
}

export function getInboxTtlHours(env) {
  const value = Number.parseInt(String(env.INBOX_TTL_HOURS ?? DEFAULT_INBOX_TTL_HOURS), 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INBOX_TTL_HOURS;
}

export function getMaxBodyChars(env) {
  const value = Number.parseInt(String(env.MAX_BODY_CHARS ?? DEFAULT_MAX_BODY_CHARS), 10);
  return Number.isFinite(value) && value > 256 ? value : DEFAULT_MAX_BODY_CHARS;
}

export function getRequestedTtlHours(value, env) {
  if (value === undefined || value === null || value === "") {
    return getInboxTtlHours(env);
  }

  const ttlHours = Number.parseInt(String(value), 10);
  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 168) {
    throw new ApiError(400, "ttl_hours_must_be_1_to_168");
  }

  return ttlHours;
}

export function normalizeAlias(rawValue, domain) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) {
    throw new Error("Alias kosong.");
  }

  if (value.includes("@")) {
    const parsed = parseEmailAddress(value);
    if (!parsed || parsed.domain !== domain) {
      throw new Error(`Gunakan domain ${domain}.`);
    }

    return splitSubaddress(parsed.localPart).alias;
  }

  const routed = splitSubaddress(value);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(routed.alias)) {
    throw new Error("Alias hanya boleh huruf kecil, angka, titik, underscore, atau dash (3-32 karakter).");
  }

  return routed.alias;
}

export function normalizeApiAlias(rawAlias, domain) {
  try {
    return normalizeAlias(rawAlias, domain);
  } catch {
    throw new ApiError(400, "invalid_alias");
  }
}

export function parseEmailAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  const index = value.lastIndexOf("@");
  if (index <= 0 || index === value.length - 1) {
    return null;
  }

  return {
    address: value,
    localPart: value.slice(0, index),
    domain: value.slice(index + 1),
  };
}

export function parseMailbox(input) {
  if (!input) {
    return null;
  }

  if (typeof input === "string") {
    const parsed = parseEmailAddress(input);
    return parsed ? { address: parsed.address, name: null } : null;
  }

  if (typeof input === "object" && input.address) {
    return {
      address: String(input.address).toLowerCase(),
      name: input.name ? String(input.name) : null,
    };
  }

  return null;
}

export function splitSubaddress(localPart) {
  const value = String(localPart || "").trim().toLowerCase();
  const plusIndex = value.indexOf("+");
  if (plusIndex < 0) {
    return { alias: value, tag: null };
  }

  return {
    alias: value.slice(0, plusIndex),
    tag: value.slice(plusIndex + 1) || null,
  };
}

export function buildEmailAddress(alias, domain) {
  return `${alias}@${domain}`;
}

export function isInboxActive(inbox) {
  return Number(inbox?.is_active) === 1;
}

export function generateAlias() {
  return `tmp-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

export function createShortId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

export function createApiKey() {
  return `tm_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function addHours(timestamp, hours) {
  const date = new Date(timestamp);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

export function addDays(timestamp, days) {
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function getWibDateKey(date = new Date()) {
  return new Date(date.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

export function getNextWibResetLabel(date = new Date()) {
  const currentWib = new Date(date.getTime() + WIB_OFFSET_MS);
  const next = new Date(Date.UTC(
    currentWib.getUTCFullYear(),
    currentWib.getUTCMonth(),
    currentWib.getUTCDate() + 1,
    0,
    0,
    0,
  ));
  return `${next.toISOString().slice(0, 10)} 00:00 WIB`;
}

export function formatTimestamp(timestamp) {
  return timestamp.replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"");
}

export function compactWhitespace(value) {
  return String(value || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

export function truncate(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function splitTelegramText(value, maxChars) {
  const text = compactWhitespace(value);
  if (!text) {
    return [];
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitIndex = remaining.lastIndexOf("\n", maxChars);
    if (splitIndex < Math.floor(maxChars * 0.5)) {
      splitIndex = remaining.lastIndexOf(" ", maxChars);
    }
    if (splitIndex < Math.floor(maxChars * 0.5)) {
      splitIndex = maxChars;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

export function trimTrailingBlankLines(lines) {
  const copy = [...lines];
  while (copy.length > 0 && copy.at(-1) === "") {
    copy.pop();
  }
  return copy;
}

export function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(String(left));
  const rightBytes = new TextEncoder().encode(String(right));
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    result |= leftBytes[index] ^ rightBytes[index];
  }

  return result === 0;
}

export function getHeaderValue(headers, key) {
  return headers.get(key) ?? headers.get(key.toLowerCase()) ?? null;
}

export function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { value: String(error) };
}

export async function readJsonBody(request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return {};
  }

  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

export function parseApiRoute(pathname) {
  return pathname
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
}
