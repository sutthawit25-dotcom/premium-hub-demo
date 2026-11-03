import { json, verifyToken, bearerToken } from "./_utils.js";
import { encryptSecret } from "./_crypto.js";

// Mailbox IMAP app-password credentials, stored SEPARATELY from the public
// /api/state blob (which the storefront reads without logging in). Nothing
// here is ever returned over GET except a boolean "do we have creds for
// this mailbox" flag — the password itself is write-only from the client's
// point of view.
const KV_KEY = "mailbox_creds";

async function requireAuth(request, env) {
  if (!env.ADMIN_SECRET) return false;
  const token = bearerToken(request);
  return verifyToken(token, env.ADMIN_SECRET);
}

async function loadStore(env) {
  const raw = await env.STATE_KV.get(KV_KEY);
  return raw ? JSON.parse(raw) : {};
}

// POST /api/mailbox-creds { mailboxId, email, provider, appPassword }
export async function onRequestPost({ request, env }) {
  if (!env.STATE_KV || !env.ADMIN_SECRET) return json({ error: "server_not_configured" }, 500);
  if (!(await requireAuth(request, env))) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }
  const mailboxId = body && body.mailboxId;
  const email = body && body.email;
  const provider = body && body.provider;
  const appPassword = body && body.appPassword;
  if (!mailboxId || !email || !appPassword) return json({ error: "missing_fields" }, 400);
  if (provider !== "GMAIL" && provider !== "OUTLOOK") return json({ error: "invalid_provider" }, 400);

  const store = await loadStore(env);
  store[mailboxId] = {
    email,
    provider,
    enc: await encryptSecret(appPassword, env.ADMIN_SECRET),
    savedAt: Date.now(),
  };
  await env.STATE_KV.put(KV_KEY, JSON.stringify(store));
  return json({ ok: true });
}

// DELETE /api/mailbox-creds?mailboxId=... — called when a mailbox is removed
// from the admin UI, so its app-password doesn't linger in KV.
export async function onRequestDelete({ request, env }) {
  if (!env.STATE_KV || !env.ADMIN_SECRET) return json({ error: "server_not_configured" }, 500);
  if (!(await requireAuth(request, env))) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const mailboxId = url.searchParams.get("mailboxId");
  if (!mailboxId) return json({ error: "missing_mailboxId" }, 400);

  const store = await loadStore(env);
  delete store[mailboxId];
  await env.STATE_KV.put(KV_KEY, JSON.stringify(store));
  return json({ ok: true });
}

// GET /api/mailbox-creds?mailboxId=... -> { hasCreds: true|false }
// GET /api/mailbox-creds -> { mailboxIds: [...] } (which mailboxes have creds on file)
// Never returns the password itself.
export async function onRequestGet({ request, env }) {
  if (!env.STATE_KV || !env.ADMIN_SECRET) return json({ error: "server_not_configured" }, 500);
  if (!(await requireAuth(request, env))) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const mailboxId = url.searchParams.get("mailboxId");
  const store = await loadStore(env);
  if (mailboxId) return json({ hasCreds: !!store[mailboxId] });
  return json({ mailboxIds: Object.keys(store) });
}
