// Subscription / package state for the shop owner who rents this site.
// KV key "billing" (separate from "state" so it never races the SPA autosave).
export const BILLING_KEY = "billing";
const DAY = 86400000;

export const DEFAULTS = { price: 359, periodDays: 30, warnDays: 5 };

export async function loadBilling(env) {
  const raw = await env.STATE_KV.get(BILLING_KEY);
  let b = {};
  try {
    b = raw ? JSON.parse(raw) : {};
  } catch (e) {
    b = {};
  }
  if (!Array.isArray(b.notices)) b.notices = [];
  if (!Array.isArray(b.history)) b.history = [];
  return b;
}

export async function saveBilling(env, b) {
  b.notices = b.notices.slice(-30);
  b.history = b.history.slice(-60);
  await env.STATE_KV.put(BILLING_KEY, JSON.stringify(b));
}

export function publicView(b, env) {
  const pending = b.notices.filter((n) => n.status === "pending").slice(-1)[0] || null;
  return {
    configured: b.expiresAt != null,
    expiresAt: b.expiresAt != null ? b.expiresAt : null,
    price: b.price || DEFAULTS.price,
    periodDays: b.periodDays || DEFAULTS.periodDays,
    warnDays: b.warnDays != null ? b.warnDays : DEFAULTS.warnDays,
    promptpayId: b.promptpayId || (env && env.PROMPTPAY_ID) || "",
    promptpayName: b.promptpayName || (env && env.PROMPTPAY_NAME) || "",
    contactUrl: b.contactUrl || (env && env.CONTACT_URL) || "",
    pending: pending ? { id: pending.id, createdAt: pending.createdAt, paidAt: pending.paidAt || null } : null,
    history: b.history.slice(-5).reverse(),
    serverNow: Date.now(),
  };
}

// New expiry after a confirmed payment: extend from the old expiry while it is
// still in the future (paying early never loses days), otherwise from now.
export function renewedExpiry(expiresAt, periodDays, now) {
  const base = expiresAt != null && expiresAt > now ? expiresAt : now;
  return base + (periodDays || DEFAULTS.periodDays) * DAY;
}

export async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return Array.from(sig).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function signNotice(secret, id) {
  return hmacHex(secret, "billing-confirm:" + id);
}

export async function checkSig(secret, id, sig) {
  const want = await signNotice(secret, id);
  if (!sig || sig.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function thaiDate(ms) {
  const d = new Date(ms + 7 * 3600 * 1000);
  const mo = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCDate() + " " + mo[d.getUTCMonth()] + " " + (d.getUTCFullYear()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}
