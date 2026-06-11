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

function extractParts(payload, parts = []) {
  if (payload.parts) {
    for (const part of payload.parts) extractParts(part, parts);
  } else {
    parts.push(payload);
  }
  return parts;
}

async function getMessageBody(gmail, messageId, supabaseService) {
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
  const allParts = extractParts(payload);

  const textPart = allParts.find(p => p.mimeType === 'text/plain');
  if (textPart?.body?.data) {
    body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
  } else if (payload.body?.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  // Fetch attachments
  const attachments = [];
  if (supabaseService) {
    const attachParts = allParts.filter(p => p.filename && p.body?.attachmentId);
    for (const part of attachParts) {
      try {
        const attRes = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: part.body.attachmentId,
        });
        const buffer = Buffer.from(attRes.data.data, 'base64');
        const safeName = part.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${msg.data.id}_${safeName}`;
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

  return { subject, from, body: body.trim(), date, messageId: msg.data.id, attachments };
}

async function markRead(gmail, messageId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

async function pollInbox(supabase, supabaseService) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    console.warn('Gmail OAuth env vars not set — skipping poll');
    return;
  }

  const auth = buildOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const messages = await fetchUnreadMessages(gmail);
  if (messages.length === 0) return;

  for (const { id } of messages) {
    const { subject, from, body, date, messageId, attachments } = await getMessageBody(gmail, id, supabaseService);

    if (!body && attachments.length === 0) { await markRead(gmail, messageId); continue; }

    const acMatch = body.match(/(?:for|re:|about)\s+([A-Z][a-z]+ [A-Z][a-z]+)/i);
    const acName = acMatch ? acMatch[1] : null;

    const { error } = await supabase.from('email_followups').upsert(
      {
        gmail_message_id: messageId,
        subject,
        sender_email: from,
        note_text: body.substring(0, 1000),
        ac_name: acName,
        attachments,
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
