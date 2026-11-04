import { readState, exchangeCode, graphGet, saveGraphCreds, redirectUri } from "./_graph.js";

function back(origin, params) {
  return Response.redirect(origin + "/?" + new URLSearchParams(params).toString() + "#admin-mailboxes", 302);
}

// GET /api/ms-callback?code&state — Microsoft sends the browser here after
// the admin signs in to a Hotmail account and accepts. Stores its refresh
// token (encrypted) and returns to the mailbox page with a status flag.
export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const origin = u.origin;
  if (!env.STATE_KV || !env.ADMIN_SECRET || !env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return back(origin, { ms: "not_configured" });
  const st = await readState(env.ADMIN_SECRET, u.searchParams.get("state"));
  if (!st) return back(origin, { ms: "bad_state" });
  if (u.searchParams.get("error")) return back(origin, { ms: "denied", id: st.m });
  const code = u.searchParams.get("code");
  if (!code) return back(origin, { ms: "no_code", id: st.m });
  try {
    const tok = await exchangeCode(env, code, redirectUri(request));
    if (!tok.refresh_token) return back(origin, { ms: "no_refresh", id: st.m });
    const me = await graphGet(tok.access_token, "/me?$select=mail,userPrincipalName");
    const got = String(me.mail || me.userPrincipalName || "").toLowerCase();
    if (got && st.e && got !== st.e) return back(origin, { ms: "mismatch", id: st.m, got });
    await saveGraphCreds(env, st.m, st.e || got, tok.refresh_token);
    return back(origin, { ms: "ok", id: st.m });
  } catch (e) {
    return back(origin, { ms: (e && e.message) || "error", id: st.m });
  }
}
