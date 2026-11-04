import { connect } from "cloudflare:sockets";
import { smtpSend } from "./_smtp.js";
import { resolveMailboxImap } from "./_mailbox-resolve.js";

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))]);
}

// Sends an email *from* the shop's already-connected Gmail account (the same
// app password the OTP reader uses), so no separate mail service is needed.
// Returns { ok:true } or { ok:false, error }.
export async function sendViaShopGmail(env, { to, subject, text, html }) {
  try {
    const raw = await env.STATE_KV.get("mailbox_creds");
    const store = raw ? JSON.parse(raw) : {};
    const gmailId = Object.keys(store).filter((id) => store[id] && store[id].provider === "GMAIL")[0];
    if (!gmailId) return { ok: false, error: "no_gmail_account" };
    const r = await resolveMailboxImap(store, gmailId, env.ADMIN_SECRET);
    if (r.error) return { ok: false, error: r.error };
    const socket = connect({ hostname: "smtp.gmail.com", port: 465 }, { secureTransport: "on", allowHalfOpen: false });
    try {
      await withTimeout(socket.opened, 8000, "smtp_connect_timeout");
      await withTimeout(
        smtpSend(socket, { user: r.email, pass: r.appPassword, to, subject, text, html, fromName: "CATBYTE PREHUB" }),
        15000,
        "smtp_timeout"
      );
      return { ok: true };
    } finally {
      try {
        await socket.close();
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}
