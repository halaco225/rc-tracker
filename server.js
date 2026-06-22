const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { pollInbox } = require('./gmail-poller');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(Object.assign(new Error('File type not allowed'), { status: 400 }));
    }
    cb(null, true);
  },
});
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseService = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Health check (also used by cron-job.org to keep server alive) ──
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Debug: check inbox config using pure axios ──
app.get('/api/poll-debug', async (req, res) => {
  const https = require('https');
  const qs = require('querystring');
  function httpsReq(options, body) {
    return new Promise((resolve, reject) => {
      const r = https.request(options, (resp) => {
        let d = '';
        resp.on('data', c => { d += c; });
        resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,200))); } });
      });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  }
  const results = [];
  const inboxes = [
    { name: 'Harold', tokenEnv: 'GMAIL_REFRESH_TOKEN', email: 'atlworkingfile@gmail.com' },
    { name: 'Matt', tokenEnv: 'MATT_GMAIL_REFRESH_TOKEN', email: 'matt.workingfile@gmail.com' },
  ];
  for (const inbox of inboxes) {
    const token = process.env[inbox.tokenEnv];
    if (!token) { results.push({ name: inbox.name, status: 'NO TOKEN' }); continue; }
    try {
      const body = qs.stringify({ client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET, refresh_token: token, grant_type: 'refresh_token' });
      const tokenData = await httpsReq({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (!tokenData.access_token) { results.push({ name: inbox.name, status: 'TOKEN_ERROR', error: JSON.stringify(tokenData) }); continue; }
      const auth = { Authorization: `Bearer ${tokenData.access_token}` };
      const q = qs.stringify({ q: `(to:${inbox.email} OR deliveredto:${inbox.email}) newer_than:7d`, maxResults: 10 });
      const msgs = await httpsReq({ hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages?${q}`, method: 'GET', headers: auth });
      const messageList = msgs.messages || [];
      const subjects = [];
      for (const m of messageList.slice(0, 5)) {
        const msg = await httpsReq({ hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject`, method: 'GET', headers: auth });
        subjects.push(msg.payload?.headers?.find(h => h.name === 'Subject')?.value || '(no subject)');
      }
      results.push({ name: inbox.name, found: messageList.length, subjects });
    } catch (e) {
      results.push({ name: inbox.name, status: 'ERROR', error: e.message });
    }
  }
  res.json(results);
});

// ── Trigger Gmail poll (called by cron-job.org every 5 min) ──
app.get('/api/poll', async (req, res) => {
  try {
    await pollInbox(supabase, supabaseService);
    res.json({ ok: true });
  } catch (e) {
    console.error('Poll error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Get all tracker data for a user ──
app.get('/api/data/:userId', async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { data, error } = await supabase
    .from('user_data')
    .select('data')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ? data.data : {});
});

// ── Save tracker data for a user ──
app.post('/api/data/:userId', async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const { error } = await supabase
    .from('user_data')
    .upsert({ user_id: userId, data: req.body, updated_at: new Date().toISOString() },
             { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Get unprocessed email follow-ups ──
app.get('/api/email-followups', async (req, res) => {
  const { data, error } = await supabase
    .from('email_followups')
    .select('*')
    .eq('done', false)
    .order('received_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── Mark email follow-up done ──
app.post('/api/email-followups/:id/done', async (req, res) => {
  const { error } = await supabase
    .from('email_followups')
    .update({ done: true })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Upload image to Supabase Storage ──
app.post('/api/upload-image', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const mimeToExt = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };
  const ext = mimeToExt[req.file.mimetype] || req.file.mimetype.split('/')[1] || 'bin';
  const filename = `${crypto.randomUUID()}.${ext}`;

  const { error } = await supabaseService.storage
    .from('note-images')
    .upload(filename, req.file.buffer, { contentType: req.file.mimetype });

  if (error) return res.status(500).json({ error: error.message });

  const { data } = supabaseService.storage.from('note-images').getPublicUrl(filename);
  res.json({ url: data.publicUrl });
});

// ── List follow-ups ──
app.get('/api/follow-ups', async (req, res) => {
  const { status, rc_name } = req.query;
  let query = supabase.from('follow_ups').select('*').order('created_at', { ascending: false });
  if (status === 'open' || status === 'done') query = query.eq('status', status);
  if (rc_name) query = query.eq('rc_name', rc_name);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── Create follow-up ──
app.post('/api/follow-ups', async (req, res) => {
  const { text, assigned_to, due_date, source = 'manual', rc_name = null, note_text = null } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const { data, error } = await supabase
    .from('follow_ups')
    .insert({ text, assigned_to, due_date: due_date || null, source, rc_name, note_text, notes: [] })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── Mark follow-up done ──
app.patch('/api/follow-ups/:id/done', async (req, res) => {
  const { error } = await supabase
    .from('follow_ups')
    .update({ status: 'done', updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Update follow-up fields ──
app.patch('/api/follow-ups/:id', async (req, res) => {
  const { text, assigned_to, due_date, status } = req.body;
  const updates = {};
  if (text !== undefined) updates.text = text;
  if (assigned_to !== undefined) updates.assigned_to = assigned_to;
  if (due_date !== undefined) updates.due_date = due_date;
  if (status !== undefined) updates.status = status;
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase.from('follow_ups').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Append note to follow-up ──
app.post('/api/follow-ups/:id/notes', async (req, res) => {
  const { text, images = [] } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const { data: row, error: fetchErr } = await supabase
    .from('follow_ups')
    .select('notes')
    .eq('id', req.params.id)
    .single();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const now = new Date();
  const newNote = {
    text,
    images,
    date: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    ts: now.toISOString(),
  };
  const updatedNotes = [newNote, ...(row.notes || [])];

  const { error } = await supabase
    .from('follow_ups')
    .update({ notes: updatedNotes, updated_at: now.toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(newNote);
});

// ── Telnyx SMS webhook ──
const RC_NUMBERS = {
  '+12296096809': 'Harold Lacoste',
  '+14704606626': 'Matt Hester',
  '+14707431991': 'Harold Lacoste',
  '+18334825113': 'Harold Lacoste', // Twilio toll-free
};

const AC_PHONES = {
  '4047912661': 'Darian Spikes',
  '4042591959': 'Ebony Simmons',
  '9174855679': 'Jadon McNeil',
  '9042503893': 'Jorge Garcia',
  '9312008109': 'Marc Gannon',
  '7707781599': 'Michelle Meehan',
  '2258101361': 'Harold Lacoste',
  '4074481963': 'Matt Hester',
};

app.post('/api/sms', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  let From, To, Body, MessageSid;

  let mediaAttachments = [];
  if (req.body?.From && req.body?.To) {
    // Twilio format
    From = req.body.From || '';
    To = req.body.To || '';
    Body = req.body.Body || '';
    MessageSid = req.body.MessageSid || `${From}-${Date.now()}`;
    // Handle MMS media — download from Twilio and re-upload to Supabase
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      const type = req.body[`MediaContentType${i}`] || 'image/jpeg';
      if (!mediaUrl) continue;
      try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const authedUrl = mediaUrl.replace('https://', `https://${accountSid}:${authToken}@`);
        const axios = require('axios');
        const response = await axios.get(authedUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        const ext = type.split('/')[1]?.split(';')[0] || 'jpg';
        const filename = `sms_${MessageSid}_${i}.${ext}`;
        const { error: upErr } = await supabaseService.storage.from('note-images').upload(filename, buffer, { contentType: type, upsert: true });
        if (!upErr) {
          const { data } = supabaseService.storage.from('note-images').getPublicUrl(filename);
          mediaAttachments.push({ url: data.publicUrl, type, name: filename });
        }
      } catch (e) {
        console.error('MMS media fetch error:', e.message);
      }
    }
  } else {
    // Telnyx format
    const payload = req.body?.data?.payload;
    if (!payload) return res.sendStatus(200);
    From = payload.from?.phone_number || '';
    To = payload.to?.[0]?.phone_number || '';
    Body = payload.text || '';
    MessageSid = payload.id || `${From}-${Date.now()}`;
  }

  const rcName = RC_NUMBERS[To] || null;
  const digits = From.replace(/\D/g, '').slice(-10);
  const acName = AC_PHONES[digits] || null;

  const { error } = await supabase.from('email_followups').upsert(
    {
      gmail_message_id: MessageSid,
      subject: `SMS from ${acName || From}`,
      sender_email: From,
      note_text: Body.substring(0, 1000),
      ac_name: acName,
      rc_name: rcName,
      attachments: mediaAttachments,
      received_at: new Date().toISOString(),
      done: false,
    },
    { onConflict: 'gmail_message_id', ignoreDuplicates: true }
  );

  if (error) console.error('SMS insert error:', error.message);

  res.sendStatus(200);
});

// ── Schedule SMS via Twilio ──
app.post('/api/schedule-sms', async (req, res) => {
  const { to, body, send_at } = req.body;
  if (!to || !body || !send_at) return res.status(400).json({ error: 'to, body, and send_at are required' });
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await twilio.messages.create({
      body,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SID,
      to,
      scheduleType: 'fixed',
      sendAt: new Date(send_at),
    });
    res.json({ ok: true, sid: msg.sid });
  } catch(e) {
    console.error('Schedule SMS error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Privacy Policy ──
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Privacy Policy</title></head><body>
<h1>Privacy Policy</h1>
<p><strong>Last updated: June 19, 2026</strong></p>
<p>This internal tool is operated by Harold Lacoste for business communication between Regional Coaches and Area Coaches.</p>
<h2>Information Collected</h2>
<p>SMS messages and phone numbers sent to this system are stored for internal business communication purposes only.</p>
<h2>Use of Information</h2>
<p>Messages are used solely for internal work follow-ups and reminders between coaching staff. No data is sold or shared with third parties.</p>
<h2>Opt-Out</h2>
<p>Reply STOP at any time to unsubscribe from messages. Reply HELP for assistance.</p>
<h2>Contact</h2>
<p>harold.lacoste@gmail.com</p>
</body></html>`);
});

// ── Terms of Service ──
app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Terms of Service</title></head><body>
<h1>Terms of Service</h1>
<p><strong>Last updated: June 19, 2026</strong></p>
<p>This service is an internal business communication tool operated by Harold Lacoste.</p>
<h2>Use</h2>
<p>This system is for internal employee communication only. Users must be authorized coaching staff.</p>
<h2>Messaging</h2>
<p>By texting this number, you consent to receive internal work-related SMS communications. Message and data rates may apply. Reply STOP to unsubscribe at any time.</p>
<h2>No Marketing</h2>
<p>This system does not send marketing messages. All communications are internal business use only.</p>
<h2>Contact</h2>
<p>harold.lacoste@gmail.com</p>
</body></html>`);
});

// ── Serve app for all other routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`RC Tracker running on port ${PORT}`);
    // Poll on startup
    setTimeout(() => pollInbox(supabase, supabaseService).catch(console.error), 5000);
  });
}

module.exports = app;
