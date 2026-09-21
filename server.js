const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { pollInbox } = require('./gmail-poller');
const { registerResumeRoutes } = require('./resume-routes');
const reminders = require('./reminders');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/heic',
  'application/pdf',
  'text/csv',
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

const reminderDeps = {
  store: reminders.createSupabaseStore(supabase, supabaseService),
  sms: reminders.createTwilioSender(),
  ai: reminders.createClaudeCaller(),
  now: () => new Date(),
};

function textAssignee(fu) {
  reminders.notifyAssignment(reminderDeps, fu).catch(e => console.error('Assignment text error:', e.message));
}

// ── Health check (also used by cron-job.org to keep server alive) ──
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Debug: check inbox config using pure axios ──
app.get('/api/token-check', (req, res) => {
  res.json({
    GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID ? '✅ set' : '❌ missing',
    GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET ? '✅ set' : '❌ missing',
    GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN ? `✅ set (ends: ...${process.env.GMAIL_REFRESH_TOKEN.slice(-8)})` : '❌ missing',
    MATT_GMAIL_REFRESH_TOKEN: process.env.MATT_GMAIL_REFRESH_TOKEN ? `✅ set (ends: ...${process.env.MATT_GMAIL_REFRESH_TOKEN.slice(-8)})` : '❌ missing',
    PRESTON_GMAIL_REFRESH_TOKEN: process.env.PRESTON_GMAIL_REFRESH_TOKEN ? `✅ set (ends: ...${process.env.PRESTON_GMAIL_REFRESH_TOKEN.slice(-8)})` : '❌ missing',
  });
});

app.get('/api/whoami', async (req, res) => {
  const https = require('https');
  const qs = require('querystring');
  function post(body) {
    return new Promise((resolve, reject) => {
      const r = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)} }, resp => {
        let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>resolve(JSON.parse(d)));
      }); r.on('error',reject); r.write(body); r.end();
    });
  }
  function get(path) {
    return new Promise((resolve, reject) => {
      const r = https.request({ hostname:'oauth2.googleapis.com', path, method:'GET' }, resp => {
        let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>resolve(JSON.parse(d)));
      }); r.on('error',reject); r.end();
    });
  }
  const results = {};
  for (const [name, env] of [['Harold','GMAIL_REFRESH_TOKEN'],['Matt','MATT_GMAIL_REFRESH_TOKEN'],['Preston','PRESTON_GMAIL_REFRESH_TOKEN']]) {
    const rt = process.env[env];
    if (!rt) { results[name] = 'NO TOKEN'; continue; }
    try {
      const tok = await post(qs.stringify({client_id:process.env.GMAIL_CLIENT_ID,client_secret:process.env.GMAIL_CLIENT_SECRET,refresh_token:rt,grant_type:'refresh_token'}));
      if (!tok.access_token) { results[name] = `token error: ${JSON.stringify(tok)}`; continue; }
      const info = await get(`/tokeninfo?access_token=${tok.access_token}`);
      results[name] = info.email || (info.error ? `token error: ${info.error}` : JSON.stringify(info));
    } catch(e) { results[name] = `error: ${e.message}`; }
  }
  res.json(results);
});

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
    { name: 'Preston', tokenEnv: 'PRESTON_GMAIL_REFRESH_TOKEN', email: 'preston.workingfile@gmail.com' },
  ];
  for (const inbox of inboxes) {
    const token = process.env[inbox.tokenEnv];
    if (!token) { results.push({ name: inbox.name, status: 'NO TOKEN' }); continue; }
    try {
      const body = qs.stringify({ client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET, refresh_token: token, grant_type: 'refresh_token' });
      const tokenData = await httpsReq({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (!tokenData.access_token) { results.push({ name: inbox.name, status: 'TOKEN_ERROR', error: JSON.stringify(tokenData) }); continue; }
      const auth = { Authorization: `Bearer ${tokenData.access_token}` };
      const profile = await httpsReq({ hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/profile`, method: 'GET', headers: auth });
      const q = qs.stringify({ q: `(to:${inbox.email} OR deliveredto:${inbox.email}) newer_than:14d`, maxResults: 10 });
      const msgs = await httpsReq({ hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages?${q}`, method: 'GET', headers: auth });
      const messageList = msgs.messages || [];
      const subjects = [];
      for (const m of messageList.slice(0, 5)) {
        const msg = await httpsReq({ hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject`, method: 'GET', headers: auth });
        subjects.push(msg.payload?.headers?.find(h => h.name === 'Subject')?.value || '(no subject)');
      }
      results.push({ name: inbox.name, authenticatedAs: profile.emailAddress, profileError: profile.error?.message, found: messageList.length, subjects });
    } catch (e) {
      results.push({ name: inbox.name, status: 'ERROR', error: e.message });
    }
  }
  res.json(results);
});

// ── One-time backfill: pull up to 25 unseen emails for a specific RC ──
app.get('/api/poll-backfill/:rcName', async (req, res) => {
  const { pollOneInboxBackfill } = require('./gmail-poller');
  const rcName = decodeURIComponent(req.params.rcName);
  try {
    const count = await pollOneInboxBackfill(supabase, supabaseService, rcName);
    res.json({ ok: true, inserted: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ── Reminder texts (called by cron-job.org every hour; ?dry=1 previews without sending) ──
app.get('/api/reminders/run', async (req, res) => {
  try {
    const result = await reminders.runHourly({ ...reminderDeps, dryRun: req.query.dry === '1' });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('Reminder run error:', e.message);
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
  let query = supabase.from('email_followups').select('*').order('received_at', { ascending: false });
  if (req.query.include_done !== 'true') query = query.eq('done', false);
  if (req.query.sms_only === 'true') query = query.ilike('subject', 'SMS from%');
  const { data, error } = await query;
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
    'text/csv': 'csv',
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

// ── List recent images for recovery ──
app.get('/api/recent-images', async (req, res) => {
  const { data, error } = await supabaseService.storage.from('note-images').list('', {
    limit: 100, sortBy: { column: 'created_at', order: 'desc' }
  });
  if (error) return res.status(500).json({ error: error.message });
  const urls = (data || []).map(f => ({
    name: f.name,
    created_at: f.created_at,
    url: supabaseService.storage.from('note-images').getPublicUrl(f.name).data.publicUrl
  }));
  res.json(urls);
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
  const { text, assigned_to, due_date, due_time = null, source = 'manual', rc_name = null, note_text = null } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  // Deduplicate: return existing open item if same text+assignee was created in last 60s
  const since = new Date(Date.now() - 60000).toISOString();
  const { data: existing } = await supabase.from('follow_ups')
    .select('id').eq('text', text).eq('assigned_to', assigned_to || '').eq('status', 'open')
    .gte('created_at', since).limit(1).single();
  if (existing) return res.status(201).json(existing);

  const { data, error } = await supabase
    .from('follow_ups')
    .insert({ text, assigned_to, due_date: due_date || null, due_time: due_time || null, source, rc_name, note_text, notes: [] })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  textAssignee(data);
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
  const { text, assigned_to, due_date, due_time, repeat_times, status } = req.body;
  const updates = {};
  if (text !== undefined) updates.text = text;
  if (assigned_to !== undefined) updates.assigned_to = assigned_to;
  if (due_date !== undefined) updates.due_date = due_date;
  // A new date or time re-arms the timed reminder that was already sent.
  if (due_time !== undefined) { updates.due_time = due_time || null; updates.timed_sent_at = null; }
  else if (due_date !== undefined) updates.timed_sent_at = null;
  // Repeat schedule, e.g. ["09:00","15:00"]; [] or null clears it. The slot already
  // past today counts as sent, so turning it on doesn't text them on the spot.
  if (repeat_times !== undefined) {
    const times = (Array.isArray(repeat_times) ? repeat_times : []).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).sort();
    updates.repeat_times = times.length ? times : null;
    let tz = 'America/New_York';
    if (times.length) {
      const { data: cur } = await supabase.from('follow_ups').select('assigned_to').eq('id', req.params.id).maybeSingle();
      tz = reminders.PEOPLE[assigned_to || cur?.assigned_to]?.tz || tz;
    }
    updates.repeat_last_slot = times.length ? reminders.currentSlot(new Date(), tz, times) : null;
  }
  if (status !== undefined) updates.status = status;
  updates.updated_at = new Date().toISOString();
  let before = null;
  if (assigned_to) {
    ({ data: before } = await supabase.from('follow_ups').select('*').eq('id', req.params.id).maybeSingle());
  }
  const { error } = await supabase.from('follow_ups').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (before && before.assigned_to !== assigned_to) textAssignee({ ...before, ...updates });
  res.json({ ok: true });
});

// ── Permanently delete follow-up ──
app.delete('/api/follow-ups/:id', async (req, res) => {
  const { error } = await supabase.from('follow_ups').delete().eq('id', req.params.id);
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
  '+18777089555': 'Harold Lacoste', // RC Tracker reminders (toll-free)
  '+14704606626': 'Matt Hester',
  '+14707431991': 'Harold Lacoste',
  '+18334825113': 'Harold Lacoste', // Twilio toll-free
  '+16292889444': 'Preston Arnwine',
  '+15756197848': 'Terrance Spillane',
};

app.post('/api/sms', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  let From, To, Body, MessageSid;

  let mediaAttachments = [];
  let numMedia = 0;
  const mediaErrors = [];
  if (req.body?.From && req.body?.To) {
    // Twilio format
    From = req.body.From || '';
    To = req.body.To || '';
    Body = req.body.Body || '';
    MessageSid = req.body.MessageSid || `${From}-${Date.now()}`;
    // Handle MMS media — download from Twilio and re-upload to Supabase
    numMedia = parseInt(req.body.NumMedia || '0', 10);
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
        } else {
          mediaErrors.push(`upload: ${upErr.message}`);
        }
      } catch (e) {
        console.error('MMS media fetch error:', e.message);
        mediaErrors.push(`download: ${e.message}`);
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

  // Message Center log of everything coming in
  reminderDeps.store.logMessage({
    direction: 'inbound',
    person: reminders.phoneToPerson(From),
    phone: From,
    body: Body,
    media: mediaAttachments,
    kind: 'inbound',
    status: 'received',
    twilio_sid: MessageSid,
    // A picture that never shows up in the tracker should say why, right on the message.
    error: numMedia > mediaAttachments.length
      ? `${numMedia - mediaAttachments.length} of ${numMedia} attachment(s) not saved${mediaErrors.length ? ` — ${mediaErrors.join('; ').slice(0, 300)}` : ''}`
      : null,
  }).catch(e => console.error('Inbound log error:', e.message));

  // Replies to reminder texts update the follow-up instead of landing in the inbox
  try {
    const { handled } = await reminders.handleInboundSms(reminderDeps, { from: From, body: Body, hasMedia: mediaAttachments.length > 0 });
    if (handled) return res.sendStatus(200);
  } catch (e) {
    console.error('Reminder reply error:', e.message);
  }

  const rcName = RC_NUMBERS[To] || null;
  const acName = reminders.phoneToPerson(From);

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
  else if (acName) {
    reminders.sendText(reminderDeps, { person: acName, kind: 'confirm', body: reminders.inboxAck(Body), reply: true })
      .catch(e => console.error('Inbox ack error:', e.message));
  }

  res.sendStatus(200);
});

// ── Schedule SMS via Twilio ──
app.post('/api/schedule-sms', async (req, res) => {
  const { to, body, send_at } = req.body;
  if (!to || !body || !send_at) return res.status(400).json({ error: 'to, body, and send_at are required' });
  // Must be RC Tracker's own Messaging Service (toll-free 877), never TalentDesk's.
  const service = process.env.TWILIO_REMINDER_MESSAGING_SID;
  if (!service) return res.status(500).json({ error: 'TWILIO_REMINDER_MESSAGING_SID is not set' });
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await twilio.messages.create({
      body: reminders.scheduledText(body),
      messagingServiceSid: service,
      to: reminders.PEOPLE[to]?.phone || to, // accepts a person's name or a phone number
      scheduleType: 'fixed',
      sendAt: new Date(send_at),
    });
    res.json({ ok: true, sid: msg.sid });
  } catch(e) {
    console.error('Schedule SMS error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Message Center ──

// Twilio delivery receipts
app.post('/api/sms-status', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  const sid = req.body?.MessageSid || req.body?.SmsSid;
  const status = req.body?.MessageStatus || req.body?.SmsStatus;
  if (sid && status) {
    const patch = { status };
    if (req.body?.ErrorCode) patch.error = `Twilio error ${req.body.ErrorCode}`;
    await reminderDeps.store.updateMessageStatus(sid, patch);
  }
  res.sendStatus(200);
});

// Activity feed: newest first, optional person / direction / status / search filters
app.get('/api/messages', async (req, res) => {
  const { person, direction, status, q, limit } = req.query;
  let query = supabaseService.from('sms_messages').select('*').order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 200, 500));
  if (person) query = query.eq('person', person);
  if (direction) query = query.eq('direction', direction);
  if (status === 'failed') query = query.in('status', ['failed', 'undelivered']);
  else if (status) query = query.eq('status', status);
  if (q) query = query.ilike('body', `%${q}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// One row per person: their latest message, unread-ish counts, opt-in state
app.get('/api/messages/threads', async (req, res) => {
  const { data, error } = await supabaseService.from('sms_messages').select('*')
    .order('created_at', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  const threads = {};
  for (const m of data || []) {
    const key = m.person || m.phone;
    if (!threads[key]) threads[key] = { person: m.person, phone: m.phone, last: m, inbound: 0, outbound: 0 };
    threads[key][m.direction === 'inbound' ? 'inbound' : 'outbound'] += 1;
  }
  res.json(Object.values(threads));
});

// Compose: send now or schedule, to one or many staff, with attachments
app.post('/api/messages/send', async (req, res) => {
  const { to = [], body, media = [], send_at, sent_by = null } = req.body || {};
  if (!Array.isArray(to) || !to.length || !String(body || '').trim()) {
    return res.status(400).json({ error: 'Pick at least one person and write a message.' });
  }
  const { images, links } = reminders.splitMedia(media);
  const results = [];
  for (const name of to) {
    const person = reminders.PEOPLE[name];
    if (!person) { results.push({ name, status: 'no phone on file' }); continue; }
    // A hand-written text carries its own STOP instructions, so it may reach someone
    // who has not signed up yet. Someone who texted STOP is never messaged again.
    if ((await reminderDeps.store.consentStatus(person.phone)) === 'opted_out') {
      results.push({ name, status: 'opted out' });
      continue;
    }
    // First text this person has ever had from the tracker? Lead with what it is.
    const firstContact = !(await reminderDeps.store.hasBeenTexted(person.phone));
    const text = reminders.composeText(body, links, firstContact);
    const logRow = { direction: 'outbound', person: name, phone: person.phone, body: text, media: [...images, ...links], kind: 'compose', sent_by };
    try {
      if (send_at) {
        const service = process.env.TWILIO_REMINDER_MESSAGING_SID;
        if (!service) throw new Error('TWILIO_REMINDER_MESSAGING_SID is not set');
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const msg = await twilio.messages.create({
          body: text, messagingServiceSid: service, to: person.phone,
          scheduleType: 'fixed', sendAt: new Date(send_at),
          // Without this a scheduled text says "scheduled" in the Message Center forever,
          // even after it's delivered.
          statusCallback: `${process.env.APP_BASE_URL || 'https://rc-tracker-hos2.onrender.com'}/api/sms-status`,
          ...(images.length ? { mediaUrl: images.map(i => i.url) } : {}),
        });
        await reminderDeps.store.logMessage({ ...logRow, status: 'scheduled', twilio_sid: msg.sid, send_at: new Date(send_at).toISOString() });
        results.push({ name, status: 'scheduled' });
      } else {
        const sid = await reminderDeps.sms(person.phone, text, images);
        await reminderDeps.store.logMessage({ ...logRow, status: 'sent', twilio_sid: sid || null });
        results.push({ name, status: 'sent' });
      }
    } catch (e) {
      await reminderDeps.store.logMessage({ ...logRow, status: 'failed', error: e.message });
      results.push({ name, status: 'error', error: e.message });
    }
  }
  res.json({ ok: true, results });
});

// Scheduled queue
app.get('/api/messages/scheduled', async (req, res) => {
  const { data, error } = await supabaseService.from('sms_messages').select('*')
    .eq('status', 'scheduled').order('send_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  // Scheduled texts sent before delivery receipts were requested never left
  // "scheduled". Once their time has passed, ask Twilio what really happened.
  const now = Date.now();
  const stale = (data || []).filter(m => m.twilio_sid && m.send_at && new Date(m.send_at).getTime() < now - 5 * 60000).slice(0, 25);
  if (stale.length) {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await Promise.all(stale.map(async m => {
      try {
        const msg = await twilio.messages(m.twilio_sid).fetch();
        const patch = { status: msg.status };
        if (msg.errorCode) patch.error = `Twilio error ${msg.errorCode}`;
        await reminderDeps.store.updateMessageStatus(m.twilio_sid, patch);
        m.status = msg.status;
      } catch (e) {
        console.error('Scheduled status check error:', e.message);
      }
    }));
  }
  res.json((data || []).filter(m => m.status === 'scheduled'));
});

app.post('/api/messages/scheduled/:sid/cancel', async (req, res) => {
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilio.messages(req.params.sid).update({ status: 'canceled' });
    await reminderDeps.store.updateMessageStatus(req.params.sid, { status: 'canceled' });
    res.json({ ok: true });
  } catch (e) {
    console.error('Cancel scheduled error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Who is signed up for texts
app.get('/api/sms-signups', async (req, res) => {
  const { data, error } = await supabaseService.from('sms_consent').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const latest = {};
  for (const row of data || []) if (!latest[row.phone]) latest[row.phone] = row;
  const people = Object.entries(reminders.PEOPLE).map(([name, p]) => ({
    name,
    role: p.role,
    rc: p.rc,
    status: latest[p.phone]?.status === 'opted_in' ? 'signed up' : (latest[p.phone] ? 'opted out' : 'not signed up'),
    since: latest[p.phone]?.created_at || null,
  }));
  res.json(people);
});

// ── Privacy Policy (wording follows carrier A2P 10DLC requirements) ──
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Privacy Policy — Ayvaz RC Tracker</title></head><body style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;line-height:1.5;">
<h1>Privacy Policy — Ayvaz RC Tracker</h1>
<p><strong>Last updated: September 15, 2026</strong></p>
<p>Ayvaz RC Tracker is an internal work tool of Ayvaz Pizza, LLC (4415 Highway 6, Sugar Land, TX 77478) used by its regional and area coaches to track work follow-ups. This policy explains how we handle information, including for our SMS reminder program.</p>
<h2>Information we collect</h2>
<ul>
<li>Employee name, work email, and mobile phone number</li>
<li>Text messages sent to and from the RC Tracker number, (877) 708-9555</li>
<li>SMS consent records: when and how you opted in or out, and the consent wording shown</li>
<li>Work follow-up details entered in the tracker</li>
</ul>
<h2>How we use information</h2>
<p>We use this information only to operate the tracker: to send work follow-up reminders you signed up for, to respond to texts you send, and to keep records of SMS consent.</p>
<h2>SMS messaging</h2>
<p>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties, except service providers (such as our SMS provider) who process it solely to deliver our messages.</p>
<p>You can opt out at any time by texting STOP to (877) 708-9555. Text HELP for help. Message frequency varies. Msg &amp; data rates may apply. See the <a href="/terms">Terms of Service</a> and <a href="/sms-opt-in">SMS sign-up page</a>.</p>
<h2>Sharing</h2>
<p>We do not sell personal information. Information is shared only with service providers needed to run the tracker (hosting, database, and SMS delivery) or when required by law.</p>
<h2>Security and retention</h2>
<p>Information is stored with access-controlled providers and kept only as long as needed for work follow-up tracking and consent recordkeeping.</p>
<h2>Contact</h2>
<p>Harold Lacoste, Ayvaz Pizza, LLC — <a href="mailto:hlacoste@ayvazpizza.com">hlacoste@ayvazpizza.com</a></p>
</body></html>`);
});

// ── Terms of Service (SMS program terms per carrier requirements) ──
app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Terms of Service — Ayvaz RC Tracker</title></head><body style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;line-height:1.5;">
<h1>Terms of Service — Ayvaz RC Tracker</h1>
<p><strong>Last updated: September 15, 2026</strong></p>
<p>Ayvaz RC Tracker is an internal work tool of Ayvaz Pizza, LLC for its regional and area coaches. It is not a consumer or marketing service.</p>
<h2>Ayvaz RC Tracker SMS reminders</h2>
<ul>
<li><strong>Program:</strong> work follow-up reminder texts for Ayvaz Pizza, LLC coaches — reminders about follow-ups due or overdue, notices when a follow-up is assigned to you, and replies to texts you send the tracker.</li>
<li><strong>How to join:</strong> sign up on the <a href="/sms-opt-in">SMS sign-up page</a> or text START to (877) 708-9555. Consent is not a condition of employment.</li>
<li><strong>Message frequency:</strong> varies, typically up to a few messages per day.</li>
<li><strong>Cost:</strong> Msg &amp; data rates may apply.</li>
<li><strong>Opt out:</strong> text STOP to (877) 708-9555 at any time. You will receive one confirmation and no further messages. Text START to rejoin.</li>
<li><strong>Help:</strong> text HELP to (877) 708-9555 or email <a href="mailto:hlacoste@ayvazpizza.com">hlacoste@ayvazpizza.com</a>.</li>
<li>Carriers are not liable for delayed or undelivered messages.</li>
</ul>
<h2>Use</h2>
<p>The tracker is for authorized Ayvaz Pizza, LLC coaching staff only. No marketing or promotional messages are sent.</p>
<h2>Privacy</h2>
<p>See our <a href="/privacy">Privacy Policy</a>. No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</p>
<h2>Contact</h2>
<p>Harold Lacoste, Ayvaz Pizza, LLC, 4415 Highway 6, Sugar Land, TX 77478 — <a href="mailto:hlacoste@ayvazpizza.com">hlacoste@ayvazpizza.com</a></p>
</body></html>`);
});

// ── SMS reminder sign-up (opt-in page linked from the A2P campaign registration) ──
app.get('/sms-opt-in', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sms-opt-in.html'));
});

app.post('/api/sms-opt-in', async (req, res) => {
  const { name, phone, consent } = req.body || {};
  const digits = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (!String(name || '').trim() || digits.length !== 10) {
    return res.status(400).json({ error: 'Please enter your name and a 10-digit mobile number.' });
  }
  // Texting is optional: an unchecked box is saved as a decline, and nobody is texted.
  const optedIn = consent === true;
  const { error } = await supabaseService.from('sms_consent').insert({
    phone: `+1${digits}`,
    name: String(name).trim().slice(0, 100),
    status: optedIn ? 'opted_in' : 'opted_out',
    source: optedIn ? 'web_form' : 'web_form_declined',
    consent_text: optedIn ? reminders.CONSENT_TEXT : null,
    ip: req.ip,
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
  });
  if (error) {
    console.error('SMS opt-in error:', error.message);
    return res.status(500).json({ error: 'Could not save your preference. Please try again.' });
  }
  if (optedIn) {
    reminders.sendOptInConfirmation(reminderDeps, `+1${digits}`).catch(e => console.error('Opt-in confirmation error:', e.message));
  }
  res.json({ ok: true, optedIn });
});

// ── Resume Tracker routes ──
registerResumeRoutes(app, supabase, supabaseService);

// ── Serve app for all other routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`RC Tracker running on port ${PORT}`);
  });

  // Timed reminders ("at 2:10pm") can't wait for an hourly external cron, so the
  // app ticks itself every few minutes. Sends claim their row first, so this and
  // the cron-job.org ping can both run without double-texting anyone.
  const tickMs = Number(process.env.REMINDER_TICK_MS || 3 * 60 * 1000);
  if (tickMs > 0) {
    setInterval(() => {
      reminders.runHourly(reminderDeps).catch(e => console.error('Reminder tick error:', e.message));
    }, tickMs).unref();
  }
}

module.exports = app;
