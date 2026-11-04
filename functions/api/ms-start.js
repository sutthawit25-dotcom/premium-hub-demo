import { json, verifyToken, bearerToken } from "./_utils.js";
import { MS_AUTHORITY, MS_SCOPE, makeState, redirectUri } from "./_graph.js";

// POST /api/ms-start { mailboxId, email } -> { ok, url }: the Microsoft
// sign-in URL to open for connecting one Hotmail/Outlook mailbox.
export async function onRequestPost({ request, env }) {
  if (!env.STATE_KV || !env.ADMIN_SECRET) return json({ error: "server_not_configured" }, 500);
  if (!(await verifyToken(bearerToken(request), env.ADMIN_SECRET))) return json({ error: "unauthorized" }, 401);
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return json({ ok: false, error: "ms_not_configured" });
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }
  const mailboxId = String((body && body.mailboxId) || "").slice(0, 80);
  const email = String((body && body.email) || "").trim().toLowerCase().slice(0, 120);
  if (!mailboxId || !email) return json({ error: "missing_fields" }, 400);
  const state = await makeState(env.ADMIN_SECRET, { m: mailboxId, e: email });
  const q = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(request),
    response_mode: "query",
    scope: MS_SCOPE,
    state,
    prompt: "select_account",
    login_hint: email,
  });
  return json({ ok: true, url: MS_AUTHORITY + "/authorize?" + q.toString() });
}
