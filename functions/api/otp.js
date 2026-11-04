import { json, verifyToken, bearerToken } from "./_utils.js";
import {
  connectImap,
  imapLogin,
  imapSelectInbox,
  imapFetchRaw,
  imapLogout,
} from "./_imap.js";
import { parseNetflixOtpEmail } from "./_mime.js";
import { resolveMailboxImap } from "./_mailbox-resolve.js";
import { findNetflixUids } from "./_otp-find.js";
import { graphAccessToken, graphNetflixMessages } from "./_graph.js";

const CREDS_KEY = "mailbox_creds";

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// POST /api/otp { mailboxId } -> connects to the real mailbox via IMAP
// (app-password auth) and returns the latest Netflix sign-in/verification
// code found in INBOX. Admin-auth required. Always 200s with { ok, ... } so
// the frontend can show a specific reason rather than a generic failure.
export async function onRequestPost({ request, env }) {
  if (!env.STATE_KV || !env.ADMIN_SECRET) return json({ error: "server_not_configured" }, 500);
  const token = bearerToken(request);
  if (!(await verifyToken(token, env.ADMIN_SECRET))) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }
  const mailboxId = body && body.mailboxId;
  if (!mailboxId) return json({ error: "missing_mailboxId" }, 400);

  const raw = await env.STATE_KV.get(CREDS_KEY);
  const store = raw ? JSON.parse(raw) : {};
  const creds = store[mailboxId];
  if (creds && creds.provider === "OUTLOOK_GRAPH") {
    try {
      const at = await graphAccessToken(env, creds, mailboxId);
      const m = (await graphNetflixMessages(at, 1))[0];
      if (!m) return json({ ok: false, error: "no_netflix_email" });
      if (!m.code) return json({ ok: false, error: "no_code_found", subject: m.subject });
      return json({ ok: true, code: m.code, subject: m.subject, date: m.date });
    } catch (e) {
      return json({ ok: false, error: (e && e.message) || "graph_error", detail: e && e.detail });
    }
  }
  const resolved = await resolveMailboxImap(store, mailboxId, env.ADMIN_SECRET);
  if (resolved.error) return json({ ok: false, error: resolved.error });
  const { host, email, appPassword, toTag } = resolved;

  let client = null;
  try {
    client = await withTimeout(connectImap(host.host, host.port), 10000, "connect_timeout");
    await withTimeout(imapLogin(client, email, appPassword), 10000, "login_failed");
    const exists = await withTimeout(imapSelectInbox(client), 10000, "select_failed");
    const uid = (await withTimeout(findNetflixUids(client, exists, toTag, 1), 20000, "search_failed"))[0];
    if (!uid) {
      await imapLogout(client);
      return json({ ok: false, error: "no_netflix_email" });
    }
    const rawMsg = await withTimeout(imapFetchRaw(client, uid), 15000, "fetch_failed");
    await imapLogout(client);
    const parsed = parseNetflixOtpEmail(rawMsg);
    if (!parsed.code) return json({ ok: false, error: "no_code_found", subject: parsed.subject });
    return json({ ok: true, code: parsed.code, subject: parsed.subject, date: parsed.date });
  } catch (e) {
    if (client) {
      try {
        await client.close();
      } catch (e2) {
        /* ignore */
      }
    }
    return json({ ok: false, error: (e && e.message) || "imap_error" });
  }
}
