const https = require('https');
const querystring = require('querystring');

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(refreshToken) {
  const body = querystring.stringify({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (!res.data.access_token) throw new Error('Token error: ' + JSON.stringify(res.data));
  return res.data.access_token;
}

function gmailGet(path, accessToken, params) {
  const qs = params ? '?' + querystring.stringify(params) : '';
  return httpsRequest({
    hostname: 'gmail.googleapis.com',
    path: `/gmail/v1/users/me${path}${qs}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

function gmailPost(path, accessToken, body) {
  const bodyStr = JSON.stringify(body);
  return httpsRequest({
    hostname: 'gmail.googleapis.com',
    path: `/gmail/v1/users/me${path}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  }, bodyStr);
}

function extractParts(payload, parts = []) {
  if (payload.parts) {
    for (const part of payload.parts) extractParts(part, parts);
  } else {
    parts.push(payload);
  }
  return parts;
}

async function getMessageBody(accessToken, messageId, supabaseService) {
  const { data: msg } = await gmailGet(`/messages/${messageId}`, accessToken, { format: 'full' });
  const payload = msg.payload;
  const headers = payload.headers || [];
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from = headers.find(h => h.name === 'From')?.value || '';
  const date = headers.find(h => h.name === 'Date')?.value || null;

  let body = '';
  const allParts = extractParts(payload);
  const textPart = allParts.find(p => p.mimeType === 'text/plain');
  const htmlPart = allParts.find(p => p.mimeType === 'text/html');
  if (textPart?.body?.data) {
    body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
  } else if (payload.body?.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  } else if (htmlPart?.body?.data) {
    body = Buffer.from(htmlPart.body.data, 'base64').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const attachments = [];
  if (supabaseService) {
    const attachParts = allParts.filter(p => p.filename && p.body?.attachmentId);
    for (const part of attachParts) {
      try {
        const { data: att } = await gmailGet(`/messages/${messageId}/attachments/${part.body.attachmentId}`, accessToken);
        const buffer = Buffer.from(att.data, 'base64');
        const safeName = part.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${msg.id}_${safeName}`;
        const { error } = await supabaseService.storage
          .from('note-images')
          .upload(filename, buffer, { contentType: part.mimeType, upsert: true });
        if (!error) {
          const { data } = supabaseService.storage.from('note-images').getPublicUrl(filename);
          attachments.push({ name: part.filename, url: data.publicUrl, type: part.mimeType });
        }
      } catch (e) {
        console.error('Attachment fetch error:', e.message);
      }
    }
  }

  return { subject, from, body: body.trim(), date, messageId: msg.id, attachments };
}

const INBOXES = [
  { refreshTokenEnv: 'GMAIL_REFRESH_TOKEN', email: 'atlworkingfile@gmail.com', rcName: 'Harold Lacoste', excludeEmails: ['harold.lacoste@gmail.com'] },
  { refreshTokenEnv: 'MATT_GMAIL_REFRESH_TOKEN', email: 'matt.workingfile@gmail.com', rcName: 'Matt Hester' },
];

async function pollOneInbox(supabase, supabaseService, inbox) {
  const refreshToken = process.env[inbox.refreshTokenEnv];
  if (!refreshToken) return;

  const accessToken = await getAccessToken(refreshToken);

  const excludeFilter = (inbox.excludeEmails || []).map(e => ` -from:${e}`).join('');
  const q = `(to:${inbox.email} OR deliveredto:${inbox.email})${excludeFilter} is:unread newer_than:30d`;

  const { data } = await gmailGet('/messages', accessToken, { q, maxResults: 50 });
  const messages = data.messages || [];
  if (messages.length === 0) return;

  for (const { id } of messages) {
    const { subject, from, body, date, messageId, attachments } = await getMessageBody(accessToken, id, supabaseService);

    const acMatch = (body || subject || '').match(/(?:for|re:|about)\s+([A-Z][a-z]+ [A-Z][a-z]+)/i);
    const acName = acMatch ? acMatch[1] : null;
    const isOwlOps = /owl/i.test(subject);
    const taggedSubject = isOwlOps ? `🦉 ${subject}` : subject;

    const { error } = await supabase.from('email_followups').upsert(
      {
        gmail_message_id: messageId,
        subject: taggedSubject,
        sender_email: from,
        note_text: body.substring(0, 1000),
        ac_name: acName,
        rc_name: inbox.rcName,
        attachments,
        received_at: date ? new Date(date).toISOString() : new Date().toISOString(),
        done: false,
      },
      { onConflict: 'gmail_message_id', ignoreDuplicates: true }
    );

    if (error) console.error('Insert error:', error.message);
  }
}

async function pollInbox(supabase, supabaseService) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    console.warn('Gmail OAuth env vars not set — skipping poll');
    return;
  }
  for (const inbox of INBOXES) {
    try {
      await pollOneInbox(supabase, supabaseService, inbox);
    } catch (e) {
      console.error(`Poll error for ${inbox.rcName}:`, e.message);
    }
  }
}

module.exports = { pollInbox };
