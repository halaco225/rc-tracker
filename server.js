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

// ── Debug: check inbox config ──
app.get('/api/poll-debug', async (req, res) => {
  const { google } = require('googleapis');
  const results = [];
  const inboxes = [
    { name: 'Harold', tokenEnv: 'GMAIL_REFRESH_TOKEN', email: 'atlworkingfile@gmail.com' },
    { name: 'Matt', tokenEnv: 'MATT_GMAIL_REFRESH_TOKEN', email: 'matt.workingfile@gmail.com' },
  ];
  for (const inbox of inboxes) {
    const token = process.env[inbox.tokenEnv];
    if (!token) { results.push({ name: inbox.name, status: 'NO TOKEN' }); continue; }
    try {
      const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
      auth.setCredentials({ refresh_token: token });
      const gmail = google.gmail({ version: 'v1', auth });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const msgs = await gmail.users.messages.list({ userId: 'me', q: `is:unread to:${inbox.email}`, maxResults: 5 });
      results.push({ name: inbox.name, account: profile.data.emailAddress, unread: (msgs.data.messages || []).length });
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
  const { status } = req.query;
  let query = supabase.from('follow_ups').select('*').order('created_at', { ascending: false });
  if (status === 'open' || status === 'done') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── Create follow-up ──
app.post('/api/follow-ups', async (req, res) => {
  const { text, assigned_to, due_date, source = 'manual' } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const { data, error } = await supabase
    .from('follow_ups')
    .insert({ text, assigned_to, due_date: due_date || null, source, notes: [] })
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

// ── Twilio SMS webhook ──
const TWILIO_NUMBERS = {
  '+14706556420': 'Harold Lacoste',
  '+14704606626': 'Matt Hester',
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

app.post('/api/sms', express.urlencoded({ extended: false }), async (req, res) => {
  const { From, To, Body, MessageSid } = req.body;

  const rcName = TWILIO_NUMBERS[To] || null;
  const digits = (From || '').replace(/\D/g, '').slice(-10);
  const acName = AC_PHONES[digits] || null;

  const { error } = await supabase.from('email_followups').upsert(
    {
      gmail_message_id: MessageSid,
      subject: `SMS from ${From}`,
      sender_email: From,
      note_text: (Body || '').substring(0, 1000),
      ac_name: acName,
      rc_name: rcName,
      attachments: [],
      received_at: new Date().toISOString(),
      done: false,
    },
    { onConflict: 'gmail_message_id', ignoreDuplicates: true }
  );

  if (error) console.error('SMS insert error:', error.message);

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
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
