const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { pollInbox } = require('./gmail-poller');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Health check (also used by cron-job.org to keep server alive) ──
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Trigger Gmail poll (called by cron-job.org every 5 min) ──
app.get('/api/poll', async (req, res) => {
  try {
    await pollInbox(supabase);
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

// ── Serve app for all other routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RC Tracker running on port ${PORT}`);
  // Poll on startup
  setTimeout(() => pollInbox(supabase).catch(console.error), 5000);
});
