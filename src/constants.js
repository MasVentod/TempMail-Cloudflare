export const DEFAULT_INBOX_TTL_HOURS = 24;
export const DEFAULT_MAX_BODY_CHARS = 12000;
export const TELEGRAM_MESSAGE_LIMIT = 3900;
export const MESSAGE_LIST_LIMIT = 10;
export const ADMIN_API_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
export const API_DAILY_QUOTA = 1500;
export const API_ACCESS_DAYS = 30;
export const API_CHAT_PREFIX = "api:";
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export function getAdminIds(env) {
  return String(env?.ADMIN_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getPrimaryAdminId(env) {
  return getAdminIds(env)[0] ?? "";
}

export function getAdminContact(env) {
  return String(env?.ADMIN_CONTACT ?? "").trim() || "@admin";
}
