import { json, verifyToken, bearerToken } from "./_utils.js";
import { connectImap, imapLogin, imapLogout } from "./_imap.js";
import { resolveMailboxImap } from "./_mailbox-resolve.js";

const CREDS_KEY = "mailbox_creds";

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// POST /api/mailbox-test { mailboxId } -> just logs in over IMAP and logs
// back out, to confirm the stored app-password actually works, without
// pulling any mail. Admin-auth required.
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
  const resolved = await resolveMailboxImap(store, mailboxId, env.ADMIN_SECRET);
  if (resolved.error) return json({ ok: false, error: resolved.error });
  const { host, email, appPassword } = resolved;

  let client = null;
  try {
    client = await withTimeout(connectImap(host.host, host.port), 10000, "connect_timeout");
    await withTimeout(imapLogin(client, email, appPassword), 10000, "login_failed");
    await imapLogout(client);
    return json({ ok: true });
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
