import { json, verifyToken, bearerToken } from "./_utils.js";
import { loadBilling, saveBilling, publicView, signNotice, safeEqual, esc, thaiDate } from "./_billing.js";
import { sendViaShopGmail } from "./_mailer.js";

function notifyTo(env, b) {
  return env.NOTIFY_EMAIL || b.notifyEmail || "";
}

async function authed(request, env) {
  return !!(env.STATE_KV && env.ADMIN_SECRET && (await verifyToken(bearerToken(request), env.ADMIN_SECRET)));
}

export async function onRequestGet({ request, env }) {
  if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401);
  const b = await loadBilling(env);
  return json({ ok: true, billing: publicView(b, env) });
}

export async function onRequestPost({ request, env }) {
  if (!(await authed(request, env))) return json({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json" }, 400);
  }
  const action = body && body.action;
  const b = await loadBilling(env);
  const origin = new URL(request.url).origin;

  if (action === "notice") {
    // Customer says "I paid". One pending notice at a time.
    let n = b.notices.filter((x) => x.status === "pending").slice(-1)[0];
    let created = false;
    if (!n) {
      n = {
        id: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
        createdAt: Date.now(),
        paidAt: Number(body.paidAt) > 0 ? Number(body.paidAt) : null,
        amount: b.price || 359,
        note: String(body.note || "").slice(0, 200),
        status: "pending",
      };
      b.notices.push(n);
      created = true;
      try {
        await saveBilling(env, b);
      } catch (e) {
        return json({ ok: false, error: "kv_write_failed" }, 500);
      }
    }
    const to = notifyTo(env, b);
    let mail = { ok: false, error: "no_notify_email" };
    if (to && created) {
      const sig = await signNotice(env.ADMIN_SECRET, n.id);
      const link = origin + "/api/billing-confirm?id=" + n.id + "&sig=" + sig;
      const paid = n.paidAt ? thaiDate(n.paidAt) : "ไม่ระบุ";
      const text =
        "ลูกค้าแจ้งโอนค่าแพ็กเกจ Flixie House แล้ว\n\nยอด: " + n.amount + " บาท\nเวลาที่โอน: " + paid + "\n" +
        (n.note ? "หมายเหตุ: " + n.note + "\n" : "") +
        "\nตรวจยอดในแอปธนาคารแล้วกดยืนยันเพื่อต่ออายุ:\n" + link + "\n";
      const html =
        '<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#222"><p><b>ลูกค้าแจ้งโอนค่าแพ็กเกจ Flixie House แล้ว</b></p>' +
        "<p>ยอด: <b>" + esc(n.amount) + " บาท</b><br>เวลาที่โอน: " + esc(paid) + (n.note ? "<br>หมายเหตุ: " + esc(n.note) : "") + "</p>" +
        '<p>ตรวจยอดในแอปธนาคารแล้วกดปุ่มด้านล่างเพื่อต่ออายุ</p><p><a href="' + esc(link) +
        '" style="background:#e50914;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">เปิดหน้ายืนยันการชำระเงิน</a></p></div>';
      mail = await sendViaShopGmail(env, { to, subject: "[Flixie House] ลูกค้าแจ้งโอน " + n.amount + " บาท รอยืนยัน", text, html });
    } else if (!created) {
      mail = { ok: true, skipped: "already_pending" };
    }
    return json({ ok: true, created, emailOk: !!mail.ok, emailError: mail.ok ? undefined : mail.error, billing: publicView(b, env) });
  }

  if (action === "config" || action === "test-email") {
    if (!env.PROVIDER_USER || !env.PROVIDER_PASSWORD) return json({ ok: false, error: "provider_login_not_set" }, 403);
    if (!safeEqual(body.providerUser, env.PROVIDER_USER) || !safeEqual(body.providerPassword, env.PROVIDER_PASSWORD)) return json({ ok: false, error: "bad_provider_login" }, 403);
    if (action === "test-email") {
      const to = notifyTo(env, b);
      if (!to) return json({ ok: false, error: "no_notify_email" });
      const r = await sendViaShopGmail(env, { to, subject: "[Flixie House] ทดสอบอีเมลแจ้งเตือน", text: "ทดสอบการส่งอีเมลแจ้งเตือนสำเร็จ", html: "<p>ทดสอบการส่งอีเมลแจ้งเตือนสำเร็จ</p>" });
      return json({ ok: !!r.ok, error: r.ok ? undefined : r.error });
    }
    const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? undefined : Number(v));
    if (num(body.expiresAt) !== undefined) b.expiresAt = num(body.expiresAt);
    if (body.expiresAt === null) b.expiresAt = null;
    if (num(body.price) > 0) b.price = num(body.price);
    if (num(body.periodDays) > 0) b.periodDays = Math.round(num(body.periodDays));
    if (num(body.warnDays) >= 0) b.warnDays = Math.round(num(body.warnDays));
    for (const k of ["promptpayId", "promptpayName", "contactUrl", "notifyEmail"]) {
      if (typeof body[k] === "string") b[k] = body[k].replace(/[\s-]/g, k === "promptpayName" || k === "contactUrl" || k === "notifyEmail" ? "$&" : "").trim().slice(0, 200);
    }
    try {
      await saveBilling(env, b);
    } catch (e) {
      return json({ ok: false, error: "kv_write_failed" }, 500);
    }
    return json({ ok: true, billing: publicView(b, env) });
  }

  return json({ error: "unknown_action" }, 400);
}
