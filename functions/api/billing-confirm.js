import { safeEqual } from "./_billing.js";
import { loadBilling, saveBilling, checkSig, renewedExpiry, esc, thaiDate } from "./_billing.js";

function page(title, inner) {
  return new Response(
    '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' +
      esc(title) + '</title><style>body{font-family:system-ui,sans-serif;background:#0f0f10;color:#f2f2f2;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}' +
      '.c{background:#1b1b1d;border:1px solid #2c2c2f;border-radius:14px;padding:24px;max-width:420px;width:100%}h1{font-size:19px;margin:0 0 12px}p{line-height:1.6;color:#cfcfd2}' +
      'button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:13px 18px;cursor:pointer;width:100%;margin-top:8px}.ok{background:#e50914;color:#fff}.no{background:#2c2c2f;color:#ddd}</style></head><body><div class="c">' +
      inner + "</div></body></html>",
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

// GET shows the confirm page (safe against email link scanners); POST applies it.
async function handle(request, env, method) {
  if (!env.STATE_KV || !env.ADMIN_SECRET) return page("ผิดพลาด", "<h1>ระบบยังไม่พร้อม</h1>");
  const u = new URL(request.url);
  const id = u.searchParams.get("id") || "";
  const sig = u.searchParams.get("sig") || "";
  if (!(await checkSig(env.ADMIN_SECRET, id, sig))) return page("ลิงก์ไม่ถูกต้อง", "<h1>ลิงก์ไม่ถูกต้อง</h1><p>ลิงก์ยืนยันนี้ไม่ถูกต้องหรือหมดอายุ</p>");
  const b = await loadBilling(env);
  const n = b.notices.filter((x) => x.id === id)[0];
  if (!n) return page("ไม่พบรายการ", "<h1>ไม่พบรายการแจ้งโอน</h1>");
  if (n.status !== "pending") {
    return page("ดำเนินการแล้ว", "<h1>รายการนี้ดำเนินการแล้ว</h1><p>สถานะ: " + (n.status === "confirmed" ? "ยืนยันแล้ว" : "ปฏิเสธแล้ว") +
      (b.expiresAt ? "<br>หมดอายุ: " + esc(thaiDate(b.expiresAt)) : "") + "</p>");
  }
  if (method === "POST") {
    const form = await request.formData();
    if (!env.PROVIDER_USER || !env.PROVIDER_PASSWORD) return page("ผิดพลาด", "<h1>ยังไม่ได้ตั้งรหัสผู้ให้บริการ</h1><p>ตั้ง PROVIDER_USER และ PROVIDER_PASSWORD ใน Cloudflare</p>");
    if (!safeEqual(form.get("user"), env.PROVIDER_USER) || !safeEqual(form.get("pass"), env.PROVIDER_PASSWORD))
      return page("รหัสไม่ถูกต้อง", "<h1>ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง</h1><p>กดย้อนกลับแล้วลองใหม่</p>");
    const decision = form.get("decision");
    const now = Date.now();
    if (decision === "confirm") {
      const from = b.expiresAt;
      b.expiresAt = renewedExpiry(b.expiresAt, b.periodDays, now);
      n.status = "confirmed";
      n.decidedAt = now;
      b.history.push({ at: now, noticeId: n.id, amount: n.amount, from: from == null ? null : from, to: b.expiresAt });
    } else if (decision === "reject") {
      n.status = "rejected";
      n.decidedAt = now;
    } else {
      return page("ผิดพลาด", "<h1>คำสั่งไม่ถูกต้อง</h1>");
    }
    try {
      await saveBilling(env, b);
    } catch (e) {
      return page("ผิดพลาด", "<h1>บันทึกไม่สำเร็จ</h1><p>ลองกดใหม่อีกครั้ง</p>");
    }
    return page("เสร็จแล้ว", decision === "confirm"
      ? "<h1>ต่ออายุเรียบร้อย ✓</h1><p>หมดอายุใหม่: <b>" + esc(thaiDate(b.expiresAt)) + "</b></p>"
      : "<h1>ปฏิเสธรายการแล้ว</h1>");
  }
  return page("ยืนยันการชำระเงิน", "<h1>ยืนยันการชำระเงิน</h1><p>ยอด <b>" + esc(n.amount) + " บาท</b><br>เวลาที่โอน: " +
    esc(n.paidAt ? thaiDate(n.paidAt) : "ไม่ระบุ") + (n.note ? "<br>หมายเหตุ: " + esc(n.note) : "") +
    "</p><p>ตรวจยอดเข้าบัญชีแล้วจึงกดยืนยัน (ล็อกอินผู้ให้บริการ)</p>" +
    '<form method="post"><input name="user" placeholder="ชื่อผู้ใช้" autocomplete="username" required style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #3a3a3e;background:#111;color:#fff;margin-bottom:8px;font:inherit">' +
    '<input name="pass" type="password" placeholder="รหัสผ่าน" autocomplete="current-password" required style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #3a3a3e;background:#111;color:#fff;font:inherit;margin-bottom:6px"><button class="ok" name="decision" value="confirm">ยืนยัน — ต่ออายุ ' + esc(b.periodDays || 30) + ' วัน</button>' +
    '<button class="no" name="decision" value="reject">ยังไม่พบยอด / ปฏิเสธ</button></form>');
}

export const onRequestGet = ({ request, env }) => handle(request, env, "GET");
export const onRequestPost = ({ request, env }) => handle(request, env, "POST");
