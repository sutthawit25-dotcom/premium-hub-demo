import { json, verifyToken, bearerToken } from "./_utils.js";
import { connectImap, imapLogin, imapSelectInbox, imapSearchNetflixUids, imapFetchRaw, imapLogout } from "./_imap.js";
import { parseNetflixOtpEmail } from "./_mime.js";
import { resolveMailboxImap } from "./_mailbox-resolve.js";

const CREDS_KEY = "mailbox_creds";

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))]);
}

// POST /api/otp-list { mailboxId, limit? } -> the latest Netflix emails in a
// (shared Gmail) inbox, newest first, each with its code and the +tag it was
// forwarded to, so the admin can tell which Hotmail account a code belongs to
// even when several customers request codes at the same time.
export async function onRequestPost({ request, env }) {
  if (!env.STATE_KV || !env.ADMIN_SECRET) return json({ error: "server_not_configured" }, 500);
  if (!(await verifyToken(bearerToken(request), env.ADMIN_SECRET))) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }
  const mailboxId = body && body.mailboxId;
  if (!mailboxId) return json({ error: "missing_mailboxId" }, 400);
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 20);

  const raw = await env.STATE_KV.get(CREDS_KEY);
  const store = raw ? JSON.parse(raw) : {};
  const resolved = await resolveMailboxImap(store, mailboxId, env.ADMIN_SECRET);
  if (resolved.error) return json({ ok: false, error: resolved.error });
  const { host, email, appPassword } = resolved;

  let client = null;
  try {
    client = await withTimeout(connectImap(host.host, host.port), 10000, "connect_timeout");
    await withTimeout(imapLogin(client, email, appPassword), 10000, "login_failed");
    await withTimeout(imapSelectInbox(client), 10000, "select_failed");
    const uids = await withTimeout(imapSearchNetflixUids(client, null), 15000, "search_failed");
    const latest = uids.slice(-limit).reverse();
    const items = [];
    for (const uid of latest) {
      try {
        const rawMsg = await withTimeout(imapFetchRaw(client, uid), 10000, "fetch_failed");
        const p = parseNetflixOtpEmail(rawMsg);
        items.push({ uid, code: p.code, subject: p.subject, date: p.date, to: p.to, deliveredTo: p.deliveredTo, tag: p.tag });
      } catch (e) {
        items.push({ uid, error: (e && e.message) || "fetch_failed" });
      }
    }
    await imapLogout(client);
    return json({ ok: true, items });
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
