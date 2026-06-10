const { google } = require('googleapis');

function buildOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return client;
}

async function fetchUnreadMessages(gmail) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread to:atlworkingfile@gmail.com',
    maxResults: 20,
  });
  return res.data.messages || [];
}

async function getMessageBody(gmail, messageId) {
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const payload = msg.data.payload;
  const headers = payload.headers || [];
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from = headers.find(h => h.name === 'From')?.value || '';
  const date = headers.find(h => h.name === 'Date')?.value || null;

  let body = '';
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
    }
  } else if (payload.body?.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  return { subject, from, body: body.trim(), date, messageId: msg.data.id };
}

async function markRead(gmail, messageId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

async function pollInbox(supabase) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    console.warn('Gmail OAuth env vars not set — skipping poll');
    return;
  }

  const auth = buildOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const messages = await fetchUnreadMessages(gmail);
  if (messages.length === 0) return;

  for (const { id } of messages) {
    const { subject, from, body, date, messageId } = await getMessageBody(gmail, id);

    if (!body) { await markRead(gmail, messageId); continue; }

    const acMatch = body.match(/(?:for|re:|about)\s+([A-Z][a-z]+ [A-Z][a-z]+)/i);
    const acName = acMatch ? acMatch[1] : null;

    const { error } = await supabase.from('email_followups').upsert(
      {
        gmail_message_id: messageId,
        subject,
        sender_email: from,
        note_text: body.substring(0, 1000),
        ac_name: acName,
        received_at: date ? new Date(date).toISOString() : new Date().toISOString(),
        done: false,
      },
      { onConflict: 'gmail_message_id', ignoreDuplicates: true }
    );

    if (error) {
      console.error('Insert error:', error.message);
    } else {
      await markRead(gmail, messageId);
    }
  }
}

module.exports = { pollInbox };
