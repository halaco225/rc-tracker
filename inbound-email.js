// ── Forwarded email → tracker inbox ──
// A mail provider (SendGrid Inbound Parse, a Cloudflare Worker, Zapier…) posts a
// forwarded email here. Pure helpers only; the route in server.js does the I/O.

const { PEOPLE } = require('./reminders');

// "Matt Hester <matt@x.com>" → matt@x.com
function emailAddress(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

// Real addresses that belong to a person, when the name guess isn't enough:
// EMAIL_SENDERS='{"mhester@ayvazpizza.com":"Matt Hester"}'
function knownSenders() {
  try { return JSON.parse(process.env.EMAIL_SENDERS || '{}'); } catch (e) { return {}; }
}

// Which of our people an address is for. An explicit entry wins; otherwise the part
// before the @ decides it, so matt@, matt.hester@ and mhester@ all reach Matt.
// Anything we can't place is left unrouted rather than guessed at.
function personForAddress(address, people = PEOPLE, known = knownSenders()) {
  const full = emailAddress(address);
  if (known[full] && people[known[full]]) return known[full];
  const local = full.split('@')[0].replace(/\+.*$/, '');
  if (!local) return null;
  const key = local.replace(/[^a-z]/g, '');
  const names = Object.keys(people);

  const exact = names.find(n => n.toLowerCase().replace(/[^a-z]/g, '') === key);
  if (exact) return exact;

  // first name, when only one person has it
  const byFirst = names.filter(n => n.split(' ')[0].toLowerCase() === key);
  if (byFirst.length === 1) return byFirst[0];

  // first initial + surname, e.g. mhester
  const byInitial = names.filter(n => {
    const [first, ...rest] = n.toLowerCase().split(' ');
    return rest.length && `${first[0]}${rest.join('')}`.replace(/[^a-z]/g, '') === key;
  });
  return byInitial.length === 1 ? byInitial[0] : null;
}

const FORWARD_MARKERS = [
  /^-+\s*forwarded message\s*-+$/i,
  /^-+\s*original message\s*-+$/i,
  /^begin forwarded message:?$/i,
];

// Pull the original sender, subject and body out of a forward. Gmail, Outlook and
// Apple Mail all quote the headers differently; we take whatever we can find and
// fall back to the forwarder's own subject and the whole body.
function parseForward(raw) {
  const body = String(raw || '').replace(/\r\n/g, '\n');
  const lines = body.split('\n');
  const start = lines.findIndex(l => FORWARD_MARKERS.some(re => re.test(l.trim())));
  const head = lines.slice(start + 1, start + 12);   // headers sit just under the marker

  const grab = re => {
    const line = head.find(l => re.test(l));
    return line ? line.replace(re, '').replace(/^\s*\*?\s*/, '').trim() : null;
  };
  const from = start === -1 ? null : grab(/^\s*\*?\s*from:\s*/i);
  const subject = start === -1 ? null : grab(/^\s*\*?\s*subject:\s*/i);
  const date = start === -1 ? null : grab(/^\s*\*?\s*(sent|date):\s*/i);

  // The message itself: after the quoted header block, or the whole thing.
  let text = body;
  if (start !== -1) {
    const afterHead = lines.slice(start + 1).findIndex((l, i) => i > 0 && l.trim() === '');
    if (afterHead > -1) text = lines.slice(start + 1 + afterHead + 1).join('\n');
  }
  return {
    from: from ? emailAddress(from) : null,
    fromName: from && from.includes('<') ? from.split('<')[0].trim().replace(/^"|"$/g, '') : null,
    subject: subject || null,
    date: date || null,
    text: cleanBody(text),
  };
}

// Trim signatures, legal footers and the long tail of quoted replies.
function cleanBody(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex(l =>
    /^--\s*$/.test(l) ||
    /^sent from my (iphone|ipad|android|mobile)/i.test(l.trim()) ||
    /^(this (e-?mail|message) (and any|is intended)|confidentiality notice)/i.test(l.trim()));
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).join('\n');
  return kept.replace(/\n{3,}/g, '\n\n').trim();
}

// Everything the inbox row needs, from whatever the provider posted.
// `to` decides whose inbox it lands in; the forwarder is the fallback.
function inboxRowFrom({ to, from, subject, text, html, messageId, attachments = [], people = PEOPLE }) {
  const fwd = parseForward(text || stripHtml(html));
  // Who it's addressed to wins; otherwise whoever forwarded it owns it.
  const owner = personForAddress(to, people) || personForAddress(from, people) || null;
  const title = (fwd.subject || subject || '(no subject)')
    .replace(/^\s*(fwd?|fw|re)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || '(no subject)';

  return {
    gmail_message_id: messageId || `email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    subject: title,
    sender_email: fwd.from || emailAddress(from) || 'unknown',
    note_text: (fwd.text || '').slice(0, 4000) || '(no message body)',   // the column is NOT NULL
    ac_name: owner,
    rc_name: owner && people[owner] ? people[owner].rc : null,
    attachments,
    received_at: new Date().toISOString(),
    done: false,
  };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

module.exports = { emailAddress, personForAddress, parseForward, cleanBody, inboxRowFrom, stripHtml };
