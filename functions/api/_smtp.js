// Minimal SMTP client (implicit TLS, AUTH PLAIN) over any socket-like object
// with web-stream `readable` / `writable` — in production that is a
// cloudflare:sockets connection to smtp.gmail.com:465 (see _mailer.js).
// Kept free of Cloudflare imports so it can be unit-tested with a fake server.

const CRLF = "\r\n";

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function wrap76(s) {
  return s.replace(/(.{76})/g, "$1" + CRLF);
}

// RFC 2047 encoded-word for a header value that may hold Thai text.
export function encodeHeader(str) {
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  return "=?UTF-8?B?" + b64(str) + "?=";
}

function cleanAddr(a) {
  const s = String(a || "").trim();
  if (!/^[^\s<>"',;:()\[\]\\]+@[^\s<>"',;:()\[\]\\]+$/.test(s)) throw new Error("bad_address");
  return s;
}

export function buildMessage({ from, fromName, to, subject, text, html, date, messageId }) {
  const boundary = "=_catbyte_" + Math.random().toString(36).slice(2, 12);
  const head = [
    "From: " + (fromName ? encodeHeader(fromName) + " " : "") + "<" + cleanAddr(from) + ">",
    "To: <" + cleanAddr(to) + ">",
    "Subject: " + encodeHeader(String(subject).replace(/[\r\n]+/g, " ")),
    "Date: " + (date || new Date().toUTCString()),
    "Message-ID: <" + (messageId || Date.now() + "." + Math.random().toString(36).slice(2, 8)) + "@catbyte-prehub>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
  ].join(CRLF);
  const part = (type, body) =>
    "--" + boundary + CRLF + "Content-Type: " + type + "; charset=UTF-8" + CRLF + "Content-Transfer-Encoding: base64" + CRLF + CRLF + wrap76(b64(body)) + CRLF;
  return head + CRLF + CRLF + part("text/plain", text) + part("text/html", html || text) + "--" + boundary + "--" + CRLF;
}

class Io {
  constructor(socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.dec = new TextDecoder();
    this.buf = "";
  }
  async write(s) {
    await this.writer.write(new TextEncoder().encode(s));
  }
  // One complete (possibly multi-line) reply: lines "250-..." end with "250 ...".
  async reply() {
    for (;;) {
      const lines = this.buf.split(CRLF);
      // all lines but the last are complete
      for (let i = 0; i < lines.length - 1; i++) {
        const m = /^(\d{3})([ -])/.exec(lines[i]);
        if (m && m[2] === " ") {
          const text = lines.slice(0, i + 1).join("\n");
          this.buf = lines.slice(i + 1).join(CRLF);
          return { code: parseInt(m[1], 10), text };
        }
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("smtp_closed");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  async expect(codes, what) {
    const r = await this.reply();
    if (codes.indexOf(r.code) < 0) throw new Error("smtp_" + what + "_" + r.code);
    return r;
  }
  async cmd(line, codes, what) {
    await this.write(line + CRLF);
    return this.expect(codes, what);
  }
}

export async function smtpSend(socket, { user, pass, to, subject, text, html, fromName }) {
  const io = new Io(socket);
  try {
    await io.expect([220], "greeting");
    await io.cmd("EHLO catbyte-prehub", [250], "ehlo");
    await io.cmd("AUTH PLAIN " + b64("\u0000" + user + "\u0000" + pass), [235], "auth");
    await io.cmd("MAIL FROM:<" + cleanAddr(user) + ">", [250], "mailfrom");
    await io.cmd("RCPT TO:<" + cleanAddr(to) + ">", [250, 251], "rcpt");
    await io.cmd("DATA", [354], "data");
    const msg = buildMessage({ from: user, fromName, to, subject, text, html });
    // dot-stuffing: any line starting with "." gets one more
    const body = msg.replace(/(^|\r\n)\./g, "$1..");
    await io.write(body + "." + CRLF);
    await io.expect([250], "send");
    try {
      await io.cmd("QUIT", [221], "quit");
    } catch (e) {
      /* server may just close */
    }
    return true;
  } finally {
    try {
      io.reader.releaseLock();
      io.writer.releaseLock();
    } catch (e) {
      /* ignore */
    }
  }
}
