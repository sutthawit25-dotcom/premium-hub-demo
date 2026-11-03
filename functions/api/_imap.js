// A minimal IMAP4rev1 client built directly on Cloudflare Workers' TCP
// Sockets API (`cloudflare:sockets`), since no conventional Node IMAP
// library runs in the Workers runtime. Implements just enough of the
// protocol to log in, open INBOX, search for a sender, and fetch one
// message's raw source — including correct handling of IMAP's `{N}`
// literal-length syntax, which is required to read a real email body.
import { connect } from "cloudflare:sockets";

const CRLF = "\r\n";

class ImapClient {
  constructor(socket) {
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
    this.buf = new Uint8Array(0);
    this.decoder = new TextDecoder("utf-8", { fatal: false });
    this.tagN = 0;
  }

  nextTag() {
    this.tagN += 1;
    return "A" + this.tagN;
  }

  async _fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error("imap_connection_closed");
    const merged = new Uint8Array(this.buf.length + value.length);
    merged.set(this.buf, 0);
    merged.set(value, this.buf.length);
    this.buf = merged;
  }

  async readLine() {
    for (;;) {
      let idx = -1;
      for (let i = 0; i < this.buf.length - 1; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        const lineBytes = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        return this.decoder.decode(lineBytes);
      }
      await this._fill();
    }
  }

  async readExact(n) {
    while (this.buf.length < n) await this._fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async writeLine(s) {
    await this.writer.write(new TextEncoder().encode(s + CRLF));
  }

  // Reads lines (pulling out any `{N}` literal byte-blobs along the way)
  // until a line tagged with `tag` appears (e.g. "A3 OK FETCH completed").
  async readUntilTagged(tag) {
    const lines = [];
    const literals = [];
    const tagRe = new RegExp("^" + tag + "\\s");
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      const m = /\{(\d+)\}\s*$/.exec(line);
      if (m) {
        const n = parseInt(m[1], 10);
        const bytes = await this.readExact(n);
        literals.push(bytes);
      }
      if (tagRe.test(line)) return { lines, literals, tagLine: line };
    }
  }

  async command(cmd) {
    const tag = this.nextTag();
    await this.writeLine(tag + " " + cmd);
    const res = await this.readUntilTagged(tag);
    const ok = /^\S+\s+OK/i.test(res.tagLine);
    return { ok: ok, lines: res.lines, literals: res.literals, tagLine: res.tagLine };
  }

  async close() {
    try {
      await this.writer.close();
    } catch (e) {
      /* ignore */
    }
  }
}

function imapQuote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export async function connectImap(host, port) {
  const socket = connect({ hostname: host, port: port }, { secureTransport: "on", allowHalfOpen: false });
  await socket.opened;
  const client = new ImapClient(socket);
  await client.readLine(); // server greeting, e.g. "* OK ..."
  return client;
}

export async function imapLogin(client, email, password) {
  const res = await client.command("LOGIN " + imapQuote(email) + " " + imapQuote(password));
  if (!res.ok) throw new Error("imap_login_failed");
}

export async function imapSelectInbox(client) {
  const res = await client.command("SELECT INBOX");
  if (!res.ok) throw new Error("imap_select_failed");
}

function parseSearchUids(lines) {
  let uids = [];
  for (const line of lines) {
    const m = /^\*\s+SEARCH\s*(.*)$/i.exec(line.trim());
    if (m && m[1].trim()) {
      uids = m[1]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n));
    }
  }
  return uids;
}

// Finds the UID of the most recent email that looks like it's from Netflix.
// Tries a tighter sender match first, then a looser one, since different
// Netflix senders (account@, info@, etc.) all contain "netflix" somewhere.
export async function imapFindLatestNetflixUid(client) {
  const queries = ['FROM "netflix.com"', 'FROM "netflix"'];
  for (const q of queries) {
    const res = await client.command("UID SEARCH " + q);
    if (!res.ok) continue;
    const uids = parseSearchUids(res.lines);
    if (uids.length) return Math.max.apply(null, uids);
  }
  return null;
}

export async function imapFetchRaw(client, uid) {
  const res = await client.command("UID FETCH " + uid + " (BODY.PEEK[])");
  if (!res.ok) throw new Error("imap_fetch_failed");
  if (!res.literals.length) throw new Error("imap_fetch_empty");
  let best = res.literals[0];
  for (const l of res.literals) if (l.length > best.length) best = l;
  return best;
}

export async function imapLogout(client) {
  try {
    await client.command("LOGOUT");
  } catch (e) {
    /* ignore */
  }
  await client.close();
}
