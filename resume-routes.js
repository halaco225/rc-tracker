'use strict';

const multer = require('multer');
const crypto = require('crypto');

function getAnthropicClient() {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.tracker_key });
}

const RESUME_ALLOWED_EXTS = new Set(['.pdf', '.doc', '.docx', '.txt', '.rtf']);

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = require('path').extname(file.originalname).toLowerCase();
    if (!RESUME_ALLOWED_EXTS.has(ext)) {
      return cb(Object.assign(new Error('File type not allowed. Use PDF, DOC, DOCX, or TXT.'), { status: 400 }));
    }
    cb(null, true);
  },
});

const transcriptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const MODEL = 'claude-haiku-4-5-20251001';

function bufferToText(buffer, mimetype) {
  // For PDFs and Word docs, extract readable text from buffer
  // This gets most human-readable text from binary formats
  const raw = buffer.toString('latin1');
  // Strip non-printable chars except newline/tab/space
  return raw.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, ' ')
            .replace(/\s{3,}/g, '\n')
            .trim();
}

async function parseResumeWithAI(text, filename) {
  const client = getAnthropicClient();
  const prompt = `You are a resume parser for a Pizza Hut / Ayvaz restaurant management recruiting team.

Parse this resume and return ONLY a JSON object (no markdown, no explanation) with these exact fields:
{
  "name": "string or null",
  "email": "string or null",
  "phone": "string or null",
  "location": "city, state or null",
  "current_position": "most recent job title or null",
  "years_experience": number or null,
  "education": "highest degree and school or null",
  "skills": ["array", "of", "key", "skills"],
  "availability": "string describing when available or null",
  "notice_period": "string e.g. '2 weeks' or null",
  "is_rehire": true if Pizza Hut or Ayvaz appears in work history else false,
  "source": "Upload",
  "candidate_type": "one of: RGM, DM, AGM, SL (best fit based on experience)",
  "fit_ranking": "same as candidate_type",
  "fit_notes": "2-3 sentences explaining why this candidate fits that role",
  "red_flags": "string describing concerns like gaps or short tenures, or null if none",
  "ai_summary": "3-4 sentence overall professional summary",
  "region": "infer US region from location: Northeast, Southeast, Midwest, Southwest, West, or null"
}

RESUME TEXT:
${text.slice(0, 8000)}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = msg.content[0].text.trim();
  // Strip markdown code fences if present
  const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(jsonStr);
}

async function assessInterviewWithAI(transcript) {
  const client = getAnthropicClient();
  const prompt = `You are a hiring manager at Pizza Hut / Ayvaz. Analyze this interview transcript and return ONLY a JSON object:
{
  "assessment": "2-3 paragraph assessment of the candidate based on the interview",
  "recommendation": "one of: Strong Hire, Hire, Maybe, No Hire",
  "strengths": ["array of strengths"],
  "concerns": ["array of concerns or empty array"]
}

TRANSCRIPT:
${transcript.slice(0, 8000)}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = msg.content[0].text.trim();
  const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(jsonStr);
}

async function summarizeReferencesWithAI(notes) {
  const client = getAnthropicClient();
  const prompt = `Summarize these reference check notes for a restaurant management candidate. Return ONLY a JSON object:
{
  "summary": "2-3 paragraph summary of references",
  "overall_sentiment": "one of: Positive, Mixed, Negative",
  "key_themes": ["array of key themes from references"]
}

REFERENCE NOTES:
${notes.slice(0, 4000)}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = msg.content[0].text.trim();
  const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(jsonStr);
}

async function compareCandidatesWithAI(candidates) {
  const client = getAnthropicClient();
  const summaries = candidates.map((c, i) =>
    `Candidate ${i + 1}: ${c.name}\nRole: ${c.candidate_type}\nExperience: ${c.years_experience} years\nSummary: ${c.ai_summary}\nFit notes: ${c.fit_notes}\nRed flags: ${c.red_flags || 'None'}`
  ).join('\n\n---\n\n');

  const prompt = `Compare these restaurant management candidates side by side. Return ONLY a JSON object:
{
  "comparison": "3-4 paragraph side-by-side comparison",
  "ranking": [{"rank": 1, "name": "...", "reason": "..."}, ...],
  "recommendation": "Which candidate to move forward with and why"
}

CANDIDATES:
${summaries}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = msg.content[0].text.trim();
  const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(jsonStr);
}

async function generateInterviewQuestionsWithAI(candidate) {
  const client = getAnthropicClient();
  const prompt = `Generate 8-10 tailored interview questions for this restaurant management candidate. Return ONLY a JSON array of question strings.

Candidate: ${candidate.name}
Role: ${candidate.candidate_type}
Experience: ${candidate.years_experience} years
Current role: ${candidate.current_position}
Summary: ${candidate.ai_summary}
Red flags: ${candidate.red_flags || 'None'}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = msg.content[0].text.trim();
  const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(jsonStr);
}

async function generateFollowupDraftWithAI(candidate) {
  const client = getAnthropicClient();
  const prompt = `Draft an appropriate follow-up message for this candidate based on their current status. Return ONLY a JSON object:
{
  "subject": "email subject line",
  "body": "full message body",
  "channel": "one of: email, text"
}

Candidate: ${candidate.name}
Status: ${candidate.status}
Role: ${candidate.candidate_type}
Notes: ${(candidate.notes_log || []).slice(-1)[0]?.note || 'None'}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = msg.content[0].text.trim();
  const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(jsonStr);
}

function registerResumeRoutes(app, supabase, supabaseService) {

  // ── List candidates ──
  app.get('/api/candidates', async (req, res) => {
    try {
      const { uploaded_by, status, fit_ranking, candidate_type, archived } = req.query;
      let query = supabase.from('candidates').select('*').order('created_at', { ascending: false });

      if (uploaded_by) query = query.eq('uploaded_by', uploaded_by);
      if (status) query = query.eq('status', status);
      if (fit_ranking) query = query.eq('fit_ranking', fit_ranking);
      if (candidate_type) query = query.eq('candidate_type', candidate_type);

      // Default: exclude archived unless explicitly requested
      if (archived === 'true') {
        query = query.eq('is_archived', true);
      } else if (archived === 'all') {
        // no filter
      } else {
        query = query.eq('is_archived', false);
      }

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Upload resume(s), run AI extraction, create candidate records ──
  app.post('/api/candidates/upload', (req, res, next) => {
    resumeUpload.array('files', 10)(req, res, (err) => {
      if (err) return res.status(err.status || 400).json({ error: err.message });
      next();
    });
  }, async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
      }

      const uploaded_by = req.body.uploaded_by || null;
      const results = [];

      for (const file of req.files) {
        try {
          // Upload file to Supabase storage
          const ext = file.originalname.split('.').pop() || 'pdf';
          const storageFilename = `${crypto.randomUUID()}.${ext}`;

          const { error: storageError } = await supabaseService.storage
            .from('resumes')
            .upload(storageFilename, file.buffer, { contentType: file.mimetype });

          if (storageError) {
            results.push({ filename: file.originalname, error: storageError.message });
            continue;
          }

          const { data: urlData } = supabaseService.storage.from('resumes').getPublicUrl(storageFilename);
          const resumeUrl = urlData.publicUrl;

          // Extract text and parse with AI
          const text = bufferToText(file.buffer, file.mimetype);
          let parsed;
          try {
            parsed = await parseResumeWithAI(text, file.originalname);
          } catch (aiErr) {
            results.push({ filename: file.originalname, error: `AI parse failed: ${aiErr.message}` });
            continue;
          }

          // Duplicate detection: same name AND (email OR phone)
          if (parsed.name && (parsed.email || parsed.phone)) {
            let dupQuery = supabase.from('candidates')
              .select('id, name, email, phone')
              .eq('is_archived', false)
              .ilike('name', parsed.name);

            const { data: dupCheck } = await dupQuery;
            if (dupCheck && dupCheck.length > 0) {
              const dup = dupCheck.find(c =>
                (parsed.email && c.email === parsed.email) ||
                (parsed.phone && c.phone === parsed.phone)
              );
              if (dup) {
                results.push({
                  filename: file.originalname,
                  duplicate: true,
                  existing_id: dup.id,
                  name: dup.name,
                });
                continue;
              }
            }
          }

          // Create candidate record
          const now = new Date().toISOString();
          const candidateData = {
            ...parsed,
            status: '1st contact- text message',
            status_history: [{ status: '1st contact- text message', timestamp: now, note: 'Created via resume upload', changed_by: uploaded_by }],
            resume_url: resumeUrl,
            resume_filename: file.originalname,
            uploaded_by,
            is_archived: false,
            notes_log: [],
            created_at: now,
            updated_at: now,
          };

          const { data: created, error: insertError } = await supabase
            .from('candidates')
            .insert(candidateData)
            .select()
            .single();

          if (insertError) {
            results.push({ filename: file.originalname, error: insertError.message });
            continue;
          }

          results.push({ filename: file.originalname, success: true, candidate: created });
        } catch (fileErr) {
          results.push({ filename: file.originalname, error: fileErr.message });
        }
      }

      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Get single candidate ──
  app.get('/api/candidates/:id', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('id', req.params.id)
        .single();
      if (error) return res.status(404).json({ error: error.message });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Update candidate (patch) ──
  app.patch('/api/candidates/:id', async (req, res) => {
    try {
      const updates = { ...req.body, updated_at: new Date().toISOString() };

      // If status is changing, append to status_history
      if (updates.status) {
        const { data: current } = await supabase
          .from('candidates')
          .select('status, status_history')
          .eq('id', req.params.id)
          .single();

        if (current && updates.status !== current.status) {
          const history = current.status_history || [];
          history.push({
            status: updates.status,
            timestamp: new Date().toISOString(),
            note: updates._status_note || '',
            changed_by: updates._changed_by || null,
          });
          updates.status_history = history;
        }
        delete updates._status_note;
        delete updates._changed_by;
      }

      const { data, error } = await supabase
        .from('candidates')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Soft delete (archive) candidate ──
  app.delete('/api/candidates/:id', async (req, res) => {
    try {
      const { error } = await supabase
        .from('candidates')
        .update({ is_archived: true, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Add note to candidate ──
  app.post('/api/candidates/:id/notes', async (req, res) => {
    try {
      const { note, changed_by } = req.body;
      if (!note) return res.status(400).json({ error: 'note is required' });

      const { data: current, error: fetchErr } = await supabase
        .from('candidates')
        .select('notes_log')
        .eq('id', req.params.id)
        .single();

      if (fetchErr) return res.status(404).json({ error: fetchErr.message });

      const notes_log = current.notes_log || [];
      notes_log.push({ note, timestamp: new Date().toISOString(), changed_by: changed_by || null });

      const { data, error } = await supabase
        .from('candidates')
        .update({ notes_log, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Upload interview transcript, run AI assessment ──
  app.post('/api/candidates/:id/transcript', (req, res, next) => {
    transcriptUpload.single('file')(req, res, (err) => {
      if (err) return res.status(err.status || 400).json({ error: err.message });
      next();
    });
  }, async (req, res) => {
    try {
      const { id } = req.params;

      let transcriptText;
      let transcriptUrl = null;

      if (req.file) {
        // Store file in Supabase
        const ext = req.file.originalname.split('.').pop() || 'txt';
        const storageFilename = `transcripts/${crypto.randomUUID()}.${ext}`;
        const { error: storageErr } = await supabaseService.storage
          .from('resumes')
          .upload(storageFilename, req.file.buffer, { contentType: req.file.mimetype });
        if (storageErr) return res.status(500).json({ error: storageErr.message });

        const { data: urlData } = supabaseService.storage.from('resumes').getPublicUrl(storageFilename);
        transcriptUrl = urlData.publicUrl;
        transcriptText = bufferToText(req.file.buffer, req.file.mimetype);
      } else if (req.body.transcript) {
        transcriptText = req.body.transcript;
      } else {
        return res.status(400).json({ error: 'Provide a transcript file or transcript text in body' });
      }

      const assessment = await assessInterviewWithAI(transcriptText);

      const updates = {
        interview_transcript_url: transcriptUrl || req.body.transcript_url || null,
        interview_assessment: assessment,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from('candidates')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Save reference notes, run AI summary ──
  app.post('/api/candidates/:id/references', async (req, res) => {
    try {
      const { reference_notes } = req.body;
      if (!reference_notes) return res.status(400).json({ error: 'reference_notes is required' });

      const summary = await summarizeReferencesWithAI(reference_notes);

      const { data, error } = await supabase
        .from('candidates')
        .update({
          reference_notes,
          reference_summary: summary,
          updated_at: new Date().toISOString(),
        })
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Compare candidates ──
  app.post('/api/candidates/compare', async (req, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length < 2) {
        return res.status(400).json({ error: 'Provide at least 2 candidate ids in ids array' });
      }

      const { data: candidates, error } = await supabase
        .from('candidates')
        .select('*')
        .in('id', ids);

      if (error) return res.status(500).json({ error: error.message });
      if (!candidates || candidates.length < 2) {
        return res.status(404).json({ error: 'Could not find candidates' });
      }

      const comparison = await compareCandidatesWithAI(candidates);
      res.json({ comparison, candidates });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Generate interview questions ──
  app.post('/api/candidates/:id/interview-questions', async (req, res) => {
    try {
      const { data: candidate, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (error) return res.status(404).json({ error: error.message });

      const questions = await generateInterviewQuestionsWithAI(candidate);

      // Persist questions on candidate record
      await supabase
        .from('candidates')
        .update({ interview_questions: questions, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

      res.json({ questions });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Generate follow-up message draft ──
  app.post('/api/candidates/:id/followup-draft', async (req, res) => {
    try {
      const { data: candidate, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (error) return res.status(404).json({ error: error.message });

      const draft = await generateFollowupDraftWithAI(candidate);
      res.json({ draft });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerResumeRoutes };
