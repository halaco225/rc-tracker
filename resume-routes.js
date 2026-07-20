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

const JOB_DESCRIPTIONS = {
  RGM: `RESTAURANT GENERAL MANAGER (RGM) — Ayvaz Pizza LLC (Pizza Hut Franchise), Atlanta Region
Hands-On Floor Leader. This is NOT a back-office role. We need a player-coach who is physically present on the line, on register, and on the floor during every rush.

THE ROLE:
- Works a station (make line, oven, register, drive-thru) during every peak period, every day
- Sets the pace of the shift by physically leading it, not directing from a distance
- First to jump in when the rush hits, last to leave when short-staffed
- Reads the floor in real time, makes fast decisive calls under pressure
- Builds culture through visible in-the-trenches presence
- Admin/scheduling done around the shift, never instead of floor time
- Think Waffle House GM energy: relentless floor presence, high tempo, personal hand in every rush

RESPONSIBILITIES:
Floor Leadership: personally work shifts alongside team on make line, register, drive-thru during rushes (daily expectation). Lead all restaurant operations — food quality, customer service, cleanliness, brand standards. Execute all company policies. Maintain food safety/sanitation with zero compromises. Drive speed-of-service and customer satisfaction in real time. Manage inventory, ordering, cash handling, security.

Team Leadership: Recruit, hire, train, coach, develop team members and shift leaders through hands-on side-by-side coaching during live shifts. Build schedules balancing guest demand with labor goals. Conduct performance evaluations, coaching sessions, corrective actions. Develop future leaders through mentoring and succession planning.

Financial Management: Own P&L for the restaurant. Hit sales targets, control food/labor costs. Analyze financial reports and implement action plans.`,

  DM: `DISTRICT MANAGER (DM) — Ayvaz Pizza LLC (Pizza Hut Franchise)
Multi-unit leader overseeing 8-12 Pizza Hut locations. Drives performance through RGM development, operational excellence, and financial accountability across the district.`
};

function bufferToText(buffer, mimetype) {
  // For PDFs and Word docs, extract readable text from buffer
  // This gets most human-readable text from binary formats
  const raw = buffer.toString('latin1');
  // Strip non-printable chars except newline/tab/space
  return raw.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, ' ')
            .replace(/\s{3,}/g, '\n')
            .trim();
}

async function parseResumeWithAI(buffer, mimetype, filename) {
  const client = getAnthropicClient();
  const prompt = `You are a resume parser for a Pizza Hut / Ayvaz restaurant management recruiting team.

OUR JOB DESCRIPTIONS (use these to score fit):
${Object.entries(JOB_DESCRIPTIONS).map(([k,v])=>`--- ${k} ---\n${v}`).join('\n\n')}


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
  "candidate_type": "one of: RGM, DM, AGM, SL (best fit based on experience level)",
  "fit_ranking": "same as candidate_type",
  "fit_score": integer from 1 to 5 rating how well this candidate fits the suggested role against our job description (5 = exceptional fit, 4 = strong fit, 3 = reasonable fit, 2 = marginal fit, 1 = poor fit),
  "fit_notes": "2-3 sentences explaining why this candidate fits or doesn't fit the role based on our specific job requirements",
  "red_flags": ["array of concern strings, or empty array if none"],
  "ai_summary": "3-4 sentence overall professional summary",
  "region": "infer US region from location: Northeast, Southeast, Midwest, Southwest, West, or null"
}`;

  const isPdf = mimetype === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
  let messages;

  if (isPdf) {
    messages = [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
        },
        { type: 'text', text: prompt },
      ],
    }];
  } else {
    const text = buffer.toString('utf8').slice(0, 8000);
    messages = [{ role: 'user', content: `${prompt}\n\nRESUME TEXT:\n${text}` }];
  }

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages,
  });

  const content = msg.content[0].text.trim();
  const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // AI returned prose instead of JSON (scanned/image PDF) — extract what we can
    const emailMatch = content.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    const phoneMatch = content.match(/[\+]?[\d\s\-\(\)]{10,}/);
    return {
      name: null, email: emailMatch ? emailMatch[0] : null,
      phone: phoneMatch ? phoneMatch[0].trim() : null,
      location: null, current_position: null, years_experience: null,
      education: null, skills: [], availability: null, notice_period: null,
      is_rehire: false, source: 'Upload', candidate_type: null,
      fit_ranking: null, fit_notes: null,
      red_flags: ['Could not fully parse resume — may be scanned or image-based. Please review manually.'],
      ai_summary: 'Resume could not be auto-parsed. Please open the PDF and update details manually.',
      region: null,
    };
  }
}

async function assessInterviewWithAI(transcript, candidateType) {
  const client = getAnthropicClient();
  const jd = JOB_DESCRIPTIONS[candidateType] || JOB_DESCRIPTIONS['RGM'];
  const prompt = `You are a hiring manager at Pizza Hut / Ayvaz evaluating a candidate for the ${candidateType||'RGM'} role.

JOB DESCRIPTION YOU ARE HIRING FOR:
${jd}

Analyze the interview transcript against this specific job description and return ONLY a JSON object:
{
  "assessment": "3-4 paragraph thorough assessment evaluating the candidate specifically against our requirements — do they have the hands-on presence, high-tempo operations background, and leadership style we need?",
  "recommendation": "one of: Strong Hire, Hire, Maybe, No Hire",
  "strengths": ["array of green-flag qualities that directly match our job description"],
  "watch_outs": ["array of yellow-flag cautions — things to monitor but not disqualifying for our role"],
  "concerns": ["array of red-flag concerns that conflict with our specific requirements, empty array if none"],
  "next_steps": ["ONLY actions the interviewer explicitly said they would do or follow up on — exact commitments stated in the transcript. Do NOT add suggestions. Empty array if none mentioned."]
}

Use the FULL transcript provided. Do not say the transcript is incomplete unless it truly cuts off mid-sentence before any substantive content.

TRANSCRIPT:
${transcript.slice(0, 60000)}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
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
  const jd = JOB_DESCRIPTIONS[candidate.candidate_type] || JOB_DESCRIPTIONS['RGM'];
  const redFlags = Array.isArray(candidate.red_flags) ? candidate.red_flags.join('; ') : candidate.red_flags || 'None';
  const skills = Array.isArray(candidate.skills) ? candidate.skills.join(', ') : candidate.skills || '';
  const prompt = `You are preparing an interviewer to evaluate ${candidate.name} for our ${candidate.candidate_type} role.

Your job: Generate the following in order, returned as a single JSON array of strings:

1. 6-7 SHORT thought-trigger topics (5-10 words max each) SPECIFIC to this candidate's resume — things to probe to determine if they are truly a fit. Each must reference something from their actual background or a gap vs. our requirements. NOT generic.

2. Two TWIST questions — disarming, conversational questions that feel casual but reveal something important about their character, self-awareness, reliability, or how they handle pressure. Think along the lines of "I don't like surprises — what should I know about you now?" but vary the angle every time. Never repeat the same question. Each should be 1-2 sentences. Start each with "TWIST:".

3. One SCENARIO — place them in a specific, realistic situation they would face in this role. Vary the scenario every time — could be a staffing crisis, an angry customer escalation, a food safety issue, a team conflict, an underperforming shift leader, a surprise inspection, etc. Tailor it to a gap or strength you see in THIS candidate. 2 sentences max. Start it with "SCENARIO:".

Return ONLY a JSON array of strings.

OUR JOB REQUIREMENTS:
${jd}

THIS CANDIDATE'S BACKGROUND:
- Name: ${candidate.name}
- Years experience: ${candidate.years_experience}
- Current/last role: ${candidate.current_position}
- Location: ${candidate.location || 'Unknown'}
- Skills on resume: ${skills}
- AI summary: ${candidate.ai_summary || 'N/A'}
- Education: ${candidate.education || 'N/A'}
- Is rehire: ${candidate.is_rehire ? 'Yes — previously worked at Pizza Hut/Ayvaz' : 'No'}
- Red flags to probe: ${redFlags}
- Fit score: ${(candidate.fit_notes||'').match(/^(\d)\/5/)?.[1] || 'N/A'}/5 — ${candidate.fit_notes || ''}

Focus questions on: gaps between their background and our hands-on floor-leader requirement, anything vague or concerning in their resume, and what makes them different from a typical candidate.`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = msg.content[0].text.trim();
  const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(jsonStr);
  } catch(e) {
    const matches = jsonStr.match(/"([^"]+)"/g);
    if (matches && matches.length) return matches.map(m => m.replace(/^"|"$/g,''));
    throw new Error('Could not parse interview questions: ' + e.message);
  }
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
    resumeUpload.array('file', 10)(req, res, (err) => {
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

      console.log(`[resume-upload] ${req.files.length} file(s), uploaded_by=${req.body.uploaded_by}`);
      for (const file of req.files) {
        console.log(`[resume-upload] processing: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`);
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

          // Parse with AI (PDFs sent natively, others as text)
          let parsed;
          try {
            console.log(`[resume-upload] calling AI for ${file.originalname}`);
            parsed = await parseResumeWithAI(file.buffer, file.mimetype, file.originalname);
            console.log(`[resume-upload] AI parsed name=${parsed.name}, email=${parsed.email}`);
          } catch (aiErr) {
            console.error(`[resume-upload] AI error for ${file.originalname}:`, aiErr.message);
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
          // Normalize AI fields that may come back as strings instead of arrays
          if (parsed.skills && !Array.isArray(parsed.skills)) parsed.skills = [parsed.skills];
          if (parsed.red_flags && !Array.isArray(parsed.red_flags)) parsed.red_flags = parsed.red_flags ? [parsed.red_flags] : [];
          // Encode fit_score into fit_notes prefix (avoids schema change), then remove from insert
          const fitScore = parsed.fit_score || 3;
          parsed.fit_notes = `${fitScore}/5 — ${parsed.fit_notes || ''}`.trim();
          delete parsed.fit_score;
          const candidateData = {
            ...parsed,
            status: 'not contacted',
            status_history: [{ status: 'not contacted', timestamp: now, note: 'Created via resume upload', changed_by: uploaded_by }],
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

  // ── Manual candidate creation ──
  app.post('/api/candidates/manual', async (req, res) => {
    try {
      const { name, phone, applied_to, position, source, uploaded_by } = req.body;
      if (!name) return res.status(400).json({ error: 'Name is required' });
      const now = new Date().toISOString();
      const { data, error } = await supabase.from('candidates').insert({
        name,
        phone,
        applied_to,
        position,
        source: source || 'Other',
        uploaded_by: uploaded_by || '',
        status: 'not contacted',
        status_history: [{ status: 'not contacted', timestamp: now, note: 'Created manually', changed_by: uploaded_by || '' }],
        is_archived: false,
        notes_log: [],
        created_at: now,
        updated_at: now,
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json({ success: true, candidate: data });
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

      // Fetch candidate to get their type for JD-matched assessment
      const { data: candidateForAssess } = await supabase.from('candidates').select('candidate_type').eq('id', id).single();
      const assessment = await assessInterviewWithAI(transcriptText, candidateForAssess?.candidate_type);

      // Map interview recommendation → fit score, update fit_notes with 🎤 marker
      const scoreMap = { 'Strong Hire': 5, 'Hire': 4, 'Maybe': 3, 'No Hire': 1 };
      const interviewScore = scoreMap[assessment.recommendation] || 3;
      const { data: currentC } = await supabase.from('candidates').select('fit_notes').eq('id', id).single();
      const prevNotes = (currentC?.fit_notes || '').replace(/^\d\/5 \[🎤\] — /, '').replace(/^\d\/5 — /, '');
      const newFitNotes = `${interviewScore}/5 [🎤] — ${prevNotes}`;

      const updates = {
        interview_transcript_url: transcriptUrl || req.body.transcript_url || null,
        interview_assessment: assessment,
        fit_notes: newFitNotes,
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
