// The end-to-end servers write outgoing email to files (Django filebased backend, EMAIL_FILE_PATH). linkFor(to)
// waits for the newest message to that address and returns the HALQA link inside (#/invite?… or #/reset?…).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.EMAIL_FILE_PATH || '/tmp/halqa-mail';

function decode(body, enc) {
  if (/base64/i.test(enc)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/quoted-printable/i.test(enc)) {
    const bytes = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return body;
}

/** Every message as { to, subject, text } (text/plain parts decoded), oldest first. */
export function messages() {
  let files = [];
  try { files = readdirSync(DIR).map((f) => join(DIR, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs); } catch { return []; }
  const out = [];
  for (const f of files) {
    for (const raw of readFileSync(f, 'utf8').split(/\n-{79}\n/)) {
      const to = /^To: (.+)$/m.exec(raw)?.[1]?.trim(); if (!to) continue;
      const subject = /^Subject: (.+)$/m.exec(raw)?.[1] ?? '';
      let text = '';
      for (const part of raw.split(/\n--[^\n]+\n/)) {
        if (!/Content-Type: text\/plain/i.test(part)) continue;
        const [head, ...rest] = part.split(/\r?\n\r?\n/);
        text += decode(rest.join('\n\n'), /Content-Transfer-Encoding: (\S+)/i.exec(head)?.[1] ?? '');
      }
      out.push({ to, subject, text });
    }
  }
  return out;
}

export async function linkFor(to, { timeout = 10000 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const m = messages().filter((x) => x.to.toLowerCase().includes(to.toLowerCase())).at(-1);
    const link = m && /https?:\/\/\S*#\/(?:invite|reset)\?\S+/.exec(m.text)?.[0];
    if (link) return { link, subject: m.subject, text: m.text };
    if (Date.now() > until) throw new Error(`no email with a link for ${to} in ${DIR}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
