// ── SMS reminders ──
// Morning due-date texts, assignment texts, two-way replies, "remind me" texts,
// stuck-item alerts, and the Monday summary. Database, Twilio, and Claude access
// are passed in as `deps` ({ store, sms, ai, now }) so the logic can be tested.

const MODEL = 'claude-haiku-4-5-20251001';
const SUMMARY_TO = 'Harold Lacoste';
const SUMMARY_TZ = 'America/New_York';
const SEND_WINDOW = { start: 9, end: 12 }; // local hours; hourly cron may run late
const FULL_INSTRUCTION_COUNT = 3;
const STUCK_OVERDUE_DAYS = 3;
const STUCK_PUSH_COUNT = 3;
const MAX_LIST_ITEMS = 10;
const MAX_REQUESTS = 5;
const REPLY_WINDOW_DAYS = 7;
const PROMPT_KINDS = ['digest', 'assignment', 'list'];

// ── SMS program compliance (A2P 10DLC) ──
const BRAND = 'Ayvaz RC Tracker';
// Shown beside the sign-up checkbox (public/sms-opt-in.html repeats it) and stored with each web opt-in.
const CONSENT_TEXT = 'I agree to receive recurring work follow-up reminder texts from Ayvaz RC Tracker at the mobile number above. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Consent is not a condition of employment.';
const OPT_IN_CONFIRMATION = `${BRAND}: You're signed up for work follow-up reminder texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
// STOP/START/HELP replies themselves are sent by the Messaging Service's Advanced Opt-Out settings.
const KEYWORDS = {
  stop: ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke'],
  start: ['start', 'unstop', 'subscribe'],
  help: ['help', 'info'],
};

function keywordOf(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  return Object.keys(KEYWORDS).find(k => KEYWORDS[k].includes(t)) || null;
}

// VPs, RCs, and ACs with phones, generated from the Master Alignment workbook
// by scripts/import_alignment.py. { name: { role, phone, tz, rc, vp } }
// Not in git: on Render it's a Secret File named people.json (placed in the app root).
const PEOPLE = loadPeople();

function loadPeople() {
  try {
    return require('./people.json');
  } catch (e) {
    console.error('people.json not found — reminder texts are off until it is added as a Render Secret File');
    return {};
  }
}

const PHONE_INDEX = Object.fromEntries(Object.entries(PEOPLE).map(([name, p]) => [p.phone.slice(-10), name]));

function phoneToPerson(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  return PHONE_INDEX[digits] || null;
}

// Who a person may create follow-ups for by text: themselves, plus their ACs (RC)
// or their RCs and ACs (VP).
function allowedAssignees(sender) {
  const me = PEOPLE[sender];
  if (!me) return [];
  const names = Object.keys(PEOPLE);
  if (me.role === 'VP') return names.filter(n => n === sender || (PEOPLE[n].role !== 'VP' && PEOPLE[n].vp === sender));
  if (me.role === 'RC') return names.filter(n => n === sender || (PEOPLE[n].role === 'AC' && PEOPLE[n].rc === sender));
  return [sender];
}

// ── Dates (due dates are plain 'YYYY-MM-DD' strings) ──
function localDate(now, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function localHour(now, tz) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
}

function localWeekday(now, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);
}

function formatDue(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${wd} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function dueLabel(due, today) {
  if (!due) return 'no due date';
  const diff = daysBetween(today, due);
  if (diff === 0) return 'due today';
  if (diff === 1) return 'due tomorrow';
  if (diff < 0) return `${-diff} day${diff === -1 ? '' : 's'} overdue`;
  return `due ${formatDue(due)}`;
}

function upcomingDates(today) {
  return Array.from({ length: 8 }, (_, i) => {
    const d = addDays(today, i);
    return `${formatDue(d).split(' ')[0]} ${d}`;
  }).join(', ');
}

// ── Picking items ──
function isOpen(fu) {
  return fu.status !== 'done';
}

function byDueDate(a, b) {
  if (a.due_date !== b.due_date) {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

function pickDueItems(items, today) {
  const tomorrow = addDays(today, 1);
  return items.filter(fu => isOpen(fu) && fu.due_date && fu.due_date <= tomorrow).sort(byDueDate);
}

function stuckReason(fu, today) {
  if (!isOpen(fu)) return null;
  const pushes = fu.due_push_count || 0;
  if (pushes >= STUCK_PUSH_COUNT) return `due date pushed back ${pushes} times`;
  if (fu.due_date) {
    const overdue = daysBetween(fu.due_date, today);
    if (overdue >= STUCK_OVERDUE_DAYS) return `${overdue} days overdue`;
  }
  return null;
}

// ── Message text ──
function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function instructions(priorCount, itemCount) {
  const single = itemCount === 1;
  if (priorCount < FULL_INSTRUCTION_COUNT) {
    return single
      ? 'Reply to this text:\n"done" = finished\n"Friday" = new due date\n"waiting on parts" = add a note\n"list" = all your items\nReply STOP to opt out.'
      : 'Reply with the number + what\'s up:\n"1 done" = finished\n"1 Friday" = new due date\n"1 waiting on parts" = add a note\n"list" = all your items\nReply STOP to opt out.';
  }
  return single ? 'Reply "done", "Fri", "list", or STOP to opt out' : 'Reply "1 done", "1 Fri", "list", or STOP to opt out';
}

function itemLines(items, today) {
  const shown = items.slice(0, MAX_LIST_ITEMS);
  const lines = shown.map((fu, i) => `${i + 1}) ${truncate(fu.text, 70)} — ${dueLabel(fu.due_date, today)}`);
  if (items.length > shown.length) lines.push(`+${items.length - shown.length} more in the tracker`);
  return lines.join('\n');
}

function formatDigest(items, today, priorCount) {
  const count = Math.min(items.length, MAX_LIST_ITEMS);
  return `Your follow-up reminders:\n${itemLines(items, today)}\n\n${instructions(priorCount, count)}`;
}

function formatAssignment(fu, from, today, priorCount) {
  const due = fu.due_date ? `due ${formatDue(fu.due_date)}` : 'no due date';
  return `New follow-up from ${from}:\n1) ${truncate(fu.text, 100)} — ${due}\n\n${instructions(priorCount, 1)}`;
}

function formatList(items, today, priorCount) {
  if (!items.length) return 'You have no open follow-ups. 🎉';
  const count = Math.min(items.length, MAX_LIST_ITEMS);
  return `Your open follow-ups:\n${itemLines(items, today)}\n\n${instructions(priorCount, count)}`;
}

function firstName(name) {
  return String(name || '').split(' ')[0];
}

function countByPerson(items) {
  const counts = {};
  items.forEach(fu => { counts[fu.assigned_to] = (counts[fu.assigned_to] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${firstName(p)} ${n}`).join(', ');
}

function formatSummary({ done, open, today }) {
  const overdue = open.filter(fu => fu.due_date && fu.due_date < today);
  const pushed = open.filter(fu => (fu.due_push_count || 0) > 0);
  const stuck = open.filter(fu => stuckReason(fu, today));
  const lines = [`Weekly follow-up summary (${formatDue(today)}):`];
  lines.push(`✅ Done last week: ${done.length}${done.length ? ` — ${countByPerson(done)}` : ''}`);
  lines.push(`⏰ Overdue now: ${overdue.length}${overdue.length ? ` — ${countByPerson(overdue)}` : ''}`);
  lines.push(`↩ Pushed back: ${pushed.length}${pushed.length ? ` — ${countByPerson(pushed)}` : ''}`);
  lines.push(`⚠ Stuck: ${stuck.length}`);
  stuck.slice(0, 5).forEach(fu => lines.push(`- ${truncate(fu.text, 50)} (${firstName(fu.assigned_to)}, ${stuckReason(fu, today)})`));
  return lines.join('\n');
}

function extractJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

// ── Reply parsing ──
const DONE_WORDS = '(?:done|complete|completed|finished|did it)';

function parseSimpleReply(body, itemCount) {
  const t = String(body || '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  if (t === 'list') return { list: true, actions: [] };
  if (new RegExp(`^all (?:are |is )?${DONE_WORDS}$`).test(t) && itemCount > 0) {
    return { list: false, actions: Array.from({ length: itemCount }, (_, i) => ({ item: i + 1, type: 'done' })) };
  }
  if (new RegExp(`^${DONE_WORDS}$`).test(t)) {
    return itemCount === 1 ? { list: false, actions: [{ item: 1, type: 'done' }] } : null;
  }
  const m = t.match(new RegExp(`^#?(\\d+(?:\\s*(?:,|&|and)\\s*#?\\d+)*)\\s+(?:is |are )?${DONE_WORDS}$`));
  if (m) {
    const nums = m[1].split(/\s*(?:,|&|and)\s*/).map(s => Number(s.replace('#', '')));
    if (nums.every(n => n >= 1 && n <= itemCount)) {
      return { list: false, actions: nums.map(item => ({ item, type: 'done' })) };
    }
  }
  return null;
}

function validateActions(raw, itemCount, today) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const maxDate = addDays(today, 90);
  const valid = [];
  for (const a of raw) {
    if (!a || !Number.isInteger(a.item) || a.item < 1 || a.item > itemCount || seen.has(a.item)) continue;
    if (a.type === 'done') valid.push({ item: a.item, type: 'done' });
    else if (a.type === 'due' && /^\d{4}-\d{2}-\d{2}$/.test(a.due_date) && a.due_date >= today && a.due_date <= maxDate) {
      valid.push({ item: a.item, type: 'due', due_date: a.due_date });
    } else if (a.type === 'note') valid.push({ item: a.item, type: 'note' });
    else continue;
    seen.add(a.item);
  }
  return valid;
}

function buildReplyPrompt(body, items, today, now, tz) {
  const list = items.map((fu, i) => `${i + 1}) ${fu ? truncate(fu.text, 120) : '(deleted)'}${fu && fu.due_date ? ` (due ${fu.due_date})` : ''}`).join('\n');
  return `You read text-message replies to a work reminder. Today is ${localWeekday(now, tz)} ${today}.
Upcoming dates: ${upcomingDates(today)}.

The reminder listed these numbered follow-ups:
${list}

The person replied: """${body}"""

Return ONLY JSON like {"list": false, "needs_number": false, "actions": [{"item": 1, "type": "done"}, {"item": 2, "type": "due", "due_date": "YYYY-MM-DD"}, {"item": 3, "type": "note"}]}
Rules:
- "done": they say the item is finished.
- "due": they give a day/date they will get it done. Resolve weekdays to the next matching date on or after today.
- "note": a status update on an item with no finish and no new date.
- At most one action per item. If there is only one item and no number is given, it means item 1.
- "list": true only if they ask to see their items.
- "needs_number": true if they clearly mean one of the items but there are several and you cannot tell which.
- If the reply is not clearly about these items (a new question, a new request, an unrelated message), return {"list": false, "needs_number": false, "actions": []}.`;
}

async function interpretReply({ ai, body, items, today, now, tz }) {
  const simple = parseSimpleReply(body, items.length);
  if (simple) return simple;
  if (!ai || !items.length) return { list: false, actions: [] };
  const parsed = extractJson(await ai(buildReplyPrompt(body, items, today, now, tz)));
  if (!parsed) return { list: false, actions: [] };
  const actions = validateActions(parsed.actions, items.length, today).filter(a => items[a.item - 1]);
  return { list: parsed.list === true, needsNumber: parsed.needs_number === true && !actions.length, actions };
}

// ── "Remind me…" requests ──
const REQUEST_HINT = /\b(remind|reminder|don'?t let \w+ forget|add (?:a |an )?(?:follow[- ]?up|task|to-?do))\b/i;

function looksLikeRequest(text) {
  return REQUEST_HINT.test(text) && !/^\s*#?\d+\b/.test(text);
}

function buildRequestPrompt(text, sender, allowed, today, now, tz) {
  return `You turn text messages into follow-up reminders for a restaurant operations team. Today is ${localWeekday(now, tz)} ${today}.
Upcoming dates: ${upcomingDates(today)}.

The sender is ${sender}. They can create reminders for: ${allowed.join(', ')}.

Message: """${text}"""

Return ONLY JSON like {"reminders": [{"assignee": "Full Name", "text": "Call Jorge about labor", "due_date": "YYYY-MM-DD"}], "unknown_names": []}
Rules:
- Only create reminders when the message asks to be reminded, asks to remind or assign someone, or asks to add a follow-up/task/to-do. A message just reporting information is not a request.
- "me", "I", "myself" means ${sender}.
- assignee must be exactly one of the names listed above. Match a first name or nickname only when it clearly means one listed person. If they name someone who is not listed, put the name they used in "unknown_names" instead.
- text: a short task in the imperative, without "remind me to". Keep store numbers, names, and details.
- due_date: the day they mention. Weekdays resolve to the next matching date on or after today; "tomorrow" is ${addDays(today, 1)}. Use null if no day is given.
- One reminder per separate task, at most ${MAX_REQUESTS}.
- If the message is not a reminder request, return {"reminders": [], "unknown_names": []}.`;
}

function validateRequests(parsed, allowed, today) {
  const reminders = [];
  const unknown = (Array.isArray(parsed.unknown_names) ? parsed.unknown_names : [])
    .filter(n => typeof n === 'string' && n.trim()).map(n => truncate(n, 40));
  const maxDate = addDays(today, 365);
  for (const r of (Array.isArray(parsed.reminders) ? parsed.reminders : []).slice(0, MAX_REQUESTS)) {
    if (!r || typeof r.text !== 'string' || !r.text.trim()) continue;
    if (!allowed.includes(r.assignee)) {
      if (typeof r.assignee === 'string' && r.assignee.trim()) unknown.push(truncate(r.assignee, 40));
      continue;
    }
    const validDate = typeof r.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.due_date) && r.due_date >= today && r.due_date <= maxDate;
    reminders.push({ assignee: r.assignee, text: truncate(r.text, 200), due_date: validDate ? r.due_date : addDays(today, 1) });
  }
  return { reminders, unknown: [...new Set(unknown)] };
}

async function handleRequest(deps, person, text, now) {
  const { tz } = PEOPLE[person];
  const today = localDate(now, tz);
  const allowed = allowedAssignees(person);
  const parsed = extractJson(await deps.ai(buildRequestPrompt(text, person, allowed, today, now, tz)));
  if (!parsed) return { handled: false };
  const { reminders, unknown } = validateRequests(parsed, allowed, today);
  if (!reminders.length && !unknown.length) return { handled: false };

  const created = [];
  const notSignedUp = new Set();
  for (const req of reminders) {
    const item = await deps.store.createItem({
      text: req.text,
      assigned_to: req.assignee,
      due_date: req.due_date,
      source: 'sms',
      rc_name: PEOPLE[req.assignee].rc,
      note_text: truncate(text, 1000),
      notes: [],
    });
    created.push(item);
    if (req.assignee !== person) {
      const notified = await notifyAssignment(deps, item, person);
      if (notified.status === 'no consent') notSignedUp.add(item.id);
    }
  }

  const mine = created.filter(fu => fu.assigned_to === person);
  const others = created.filter(fu => fu.assigned_to !== person);
  const sections = [];
  if (mine.length) sections.push(`✅ Added to your follow-ups:\n${itemLines(mine, today)}`);
  if (others.length) {
    const line = fu => `- ${firstName(fu.assigned_to)}: ${truncate(fu.text, 60)} — ${dueLabel(fu.due_date, today)}${notSignedUp.has(fu.id) ? ' (not signed up for texts yet)' : ''}`;
    sections.push(`✅ Sent:\n${others.map(line).join('\n')}`);
  }
  if (unknown.length) sections.push(`⚠ Couldn't match ${unknown.map(n => `"${n}"`).join(', ')} to anyone you can assign. Use their full name.`);

  if (mine.length) {
    sections.push(instructions(await deps.store.countTexts(person), mine.length));
    await sendText(deps, { person, kind: 'assignment', itemIds: mine.map(fu => fu.id), body: sections.join('\n\n'), reply: true });
  } else {
    await sendText(deps, { person, kind: 'confirm', body: sections.join('\n\n'), reply: true });
  }
  return { handled: true, created: created.length };
}

// ── Sending ──
// `reply` marks a direct answer to a text the person just sent us; everything else
// requires their SMS opt-in.
async function sendText(deps, { person, kind, itemIds = [], body, localDate: date = null, reply = false }) {
  const p = PEOPLE[person];
  if (!p) return { status: 'no phone' };
  if (!reply && !(await deps.store.hasConsent(p.phone))) return { status: 'no consent' };
  const text = `${BRAND}\n${body}`;
  const row = await deps.store.claimMessage({ person, phone: p.phone, kind, item_ids: itemIds, body: text, local_date: date });
  if (!row) return { status: 'already sent' };
  try {
    const sid = await deps.sms(p.phone, text);
    await deps.store.updateMessage(row.id, { twilio_sid: sid || null });
    if (itemIds.length) await deps.store.markTexted(itemIds, deps.now().toISOString());
    return { status: 'sent' };
  } catch (e) {
    // Free the once-a-day slot so the next hourly run can retry.
    await deps.store.updateMessage(row.id, { error: e.message, local_date: null });
    return { status: 'error', error: e.message };
  }
}

// `from` is who assigned it; nobody is texted about an item they gave themselves.
async function notifyAssignment(deps, fu, from = fu && fu.rc_name) {
  if (!fu || !PEOPLE[fu.assigned_to] || !isOpen(fu) || fu.assigned_to === from) return { status: 'skipped' };
  const person = fu.assigned_to;
  const today = localDate(deps.now(), PEOPLE[person].tz);
  const prior = await deps.store.countTexts(person);
  const body = formatAssignment(fu, from || 'RC Tracker', today, prior);
  return sendText(deps, { person, kind: 'assignment', itemIds: [fu.id], body });
}

async function runHourly(deps) {
  const now = deps.now();
  const iso = now.toISOString();
  const openItems = await deps.store.getOpenItems();
  const result = { digests: [], stuck: [], summary: null };

  // Morning lists
  for (const person of Object.keys(PEOPLE)) {
    const { tz } = PEOPLE[person];
    const hour = localHour(now, tz);
    if (!deps.dryRun && (hour < SEND_WINDOW.start || hour >= SEND_WINDOW.end)) continue;
    const today = localDate(now, tz);
    const due = pickDueItems(openItems.filter(fu => fu.assigned_to === person), today);
    if (!due.length) continue;
    const prior = await deps.store.countTexts(person);
    const body = formatDigest(due, today, prior);
    if (deps.dryRun) { result.digests.push({ person, status: 'preview', body }); continue; }
    const itemIds = due.slice(0, MAX_LIST_ITEMS).map(fu => fu.id);
    const sent = await sendText(deps, { person, kind: 'digest', itemIds, body, localDate: today });
    result.digests.push({ person, ...sent });
  }

  // Stuck alerts (once per item)
  const easternToday = localDate(now, SUMMARY_TZ);
  for (const fu of openItems) {
    const reason = stuckReason(fu, easternToday);
    if (!reason || fu.stuck_alerted_at) continue;
    result.stuck.push({ id: fu.id, text: fu.text, reason });
    if (deps.dryRun) continue;
    try {
      await deps.store.updateItem(fu.id, { stuck_alerted_at: iso });
      await deps.store.insertInbox({
        gmail_message_id: `stuck-${fu.id}`,
        subject: `⚠ Stuck: ${truncate(fu.text, 80)}`,
        sender_email: 'rc-tracker-reminders',
        note_text: `${fu.assigned_to} — ${reason}${fu.due_date ? ` (due ${fu.due_date})` : ''}`,
        ac_name: fu.assigned_to,
        rc_name: fu.rc_name || PEOPLE[fu.assigned_to]?.rc || SUMMARY_TO,
        attachments: [],
        received_at: iso,
        done: false,
      });
    } catch (e) {
      console.error('Stuck alert error:', e.message);
    }
  }

  // Monday summary (Harold's region only)
  const summaryHour = localHour(now, SUMMARY_TZ);
  const isMonday = localWeekday(now, SUMMARY_TZ) === 'Mon';
  if (isMonday && (deps.dryRun || (summaryHour >= SEND_WINDOW.start && summaryHour < SEND_WINDOW.end))) {
    const inRegion = fu => PEOPLE[fu.assigned_to]?.rc === SUMMARY_TO;
    const since = new Date(now.getTime() - 7 * 86400000).toISOString();
    const done = (await deps.store.getDoneSince(since)).filter(inRegion);
    const body = formatSummary({ done, open: openItems.filter(inRegion), today: easternToday });
    if (deps.dryRun) {
      result.summary = { status: 'preview', body };
    } else {
      result.summary = await sendText(deps, { person: SUMMARY_TO, kind: 'summary', body, localDate: easternToday });
      await deps.store.insertInbox({
        gmail_message_id: `summary-${easternToday}`,
        subject: '📊 Weekly follow-up summary',
        sender_email: 'rc-tracker-reminders',
        note_text: body,
        ac_name: null,
        rc_name: SUMMARY_TO,
        attachments: [],
        received_at: iso,
        done: false,
      });
    }
  }

  return result;
}

// Returns { handled: true } when the text was a reminder reply or a "remind me"
// request; otherwise the caller drops it in the SMS inbox as before.
async function handleInboundSms(deps, { from, body, hasMedia = false }) {
  const person = phoneToPerson(from);
  const text = String(body || '').trim();
  const keyword = keywordOf(text);
  if (keyword) return handleKeyword(deps, keyword, from, person);
  if (!person || !text || hasMedia) return { handled: false };

  const now = deps.now();
  const iso = now.toISOString();
  const { tz } = PEOPLE[person];
  const today = localDate(now, tz);
  const isList = /^list[.!]?$/i.test(text);

  if (!isList && deps.ai && looksLikeRequest(text)) {
    const request = await handleRequest(deps, person, text, now);
    if (request.handled) return request;
  }

  const since = new Date(now.getTime() - REPLY_WINDOW_DAYS * 86400000).toISOString();
  const last = await deps.store.lastPrompt(person, since);
  if (!last && !isList) return { handled: false };

  const items = last ? await deps.store.getItemsByIds(last.item_ids || []) : [];
  const reply = isList ? { list: true, actions: [] } : await interpretReply({ ai: deps.ai, body: text, items, today, now, tz });

  if (reply.list) {
    const open = (await deps.store.getOpenItemsFor(person)).sort(byDueDate);
    const prior = await deps.store.countTexts(person);
    const itemIds = open.slice(0, MAX_LIST_ITEMS).map(fu => fu.id);
    await sendText(deps, { person, kind: 'list', itemIds, body: formatList(open, today, prior), reply: true });
    return { handled: true, list: true };
  }

  if (reply.needsNumber) {
    await sendText(deps, { person, kind: 'confirm', body: 'Which one? Reply with the number, like "2 done" or "2 Friday".', reply: true });
    return { handled: true, needsNumber: true };
  }

  if (!reply.actions.length) return { handled: false };

  const note = {
    text: `📱 Text reply from ${person}: "${truncate(text, 500)}"`,
    images: [],
    date: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    ts: iso,
  };
  const confirmations = [];
  for (const action of reply.actions) {
    const fu = items[action.item - 1];
    const patch = { last_reply: truncate(text, 500), last_reply_at: iso, updated_at: iso };
    if (action.type === 'done') {
      patch.status = 'done';
      confirmations.push(`✅ Done: ${truncate(fu.text, 50)}`);
    } else if (action.type === 'due') {
      patch.due_date = action.due_date;
      if (fu.due_date && action.due_date > fu.due_date) patch.due_push_count = (fu.due_push_count || 0) + 1;
      confirmations.push(`📅 Moved to ${formatDue(action.due_date)}: ${truncate(fu.text, 50)}`);
    } else {
      confirmations.push(`📝 Note added: ${truncate(fu.text, 50)}`);
    }
    await deps.store.updateItem(fu.id, patch);
    await deps.store.appendNote(fu.id, note);
  }
  await sendText(deps, { person, kind: 'confirm', body: `Got it!\n${confirmations.join('\n')}`, reply: true });
  return { handled: true, actions: reply.actions };
}

// STOP / START record consent (Twilio also blocks sends after STOP); HELP is answered by
// the Messaging Service. Keywords never become follow-ups or inbox items.
async function handleKeyword(deps, keyword, from, person) {
  const digits = String(from || '').replace(/\D/g, '').slice(-10);
  if (keyword !== 'help' && digits.length === 10) {
    await deps.store.recordConsent({
      phone: `+1${digits}`,
      name: person,
      status: keyword === 'stop' ? 'opted_out' : 'opted_in',
      source: `keyword_${keyword}`,
    });
  }
  return { handled: true, keyword };
}

// Used by the "Schedule Text" button so hand-scheduled texts carry the program name
// and the same reply instructions as automatic reminders.
function scheduledText(body) {
  return `${BRAND}\n${String(body || '').trim()}\n\nReply "done", "Fri", "list", or STOP to opt out`;
}

async function sendOptInConfirmation(deps, phone) {
  try {
    await deps.sms(phone, OPT_IN_CONFIRMATION);
    return { status: 'sent' };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

// ── Real dependencies ──
function createSupabaseStore(supabase, supabaseService) {
  const logDb = supabaseService || supabase;
  const names = Object.keys(PEOPLE);
  const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  return {
    async getOpenItems() {
      return check(await supabase.from('follow_ups').select('*').neq('status', 'done').in('assigned_to', names)) || [];
    },
    async getOpenItemsFor(person) {
      return check(await supabase.from('follow_ups').select('*').neq('status', 'done').eq('assigned_to', person)) || [];
    },
    async getDoneSince(sinceIso) {
      return check(await supabase.from('follow_ups').select('*').eq('status', 'done').gte('updated_at', sinceIso).in('assigned_to', names)) || [];
    },
    async getItemsByIds(ids) {
      if (!ids.length) return [];
      const rows = check(await supabase.from('follow_ups').select('*').in('id', ids)) || [];
      return ids.map(id => rows.find(r => r.id === id) || null);
    },
    async createItem(row) {
      return check(await supabase.from('follow_ups').insert(row).select().single());
    },
    async updateItem(id, patch) {
      check(await supabase.from('follow_ups').update(patch).eq('id', id));
    },
    async appendNote(id, note) {
      const row = check(await supabase.from('follow_ups').select('notes').eq('id', id).single());
      check(await supabase.from('follow_ups').update({ notes: [note, ...(row.notes || [])] }).eq('id', id));
    },
    async markTexted(ids, iso) {
      const { error } = await supabase.from('follow_ups').update({ last_texted_at: iso }).in('id', ids);
      if (error) console.error('markTexted error:', error.message);
    },
    // Inserts the log row before sending. Returns null when this text was
    // already sent (unique index) or the table is unavailable — never send then.
    async claimMessage(row) {
      const { data, error } = await logDb.from('sms_reminders').insert(row).select().single();
      if (error) {
        if (error.code !== '23505') console.error('sms_reminders insert error:', error.message);
        return null;
      }
      return data;
    },
    async updateMessage(id, patch) {
      const { error } = await logDb.from('sms_reminders').update(patch).eq('id', id);
      if (error) console.error('sms_reminders update error:', error.message);
    },
    async countTexts(person) {
      const { count, error } = await logDb.from('sms_reminders').select('id', { count: 'exact', head: true })
        .eq('person', person).is('error', null).in('kind', PROMPT_KINDS);
      return error ? 0 : count || 0;
    },
    async lastPrompt(person, sinceIso) {
      const { data, error } = await logDb.from('sms_reminders').select('*')
        .eq('person', person).is('error', null).in('kind', PROMPT_KINDS).gte('created_at', sinceIso)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      return error ? null : data;
    },
    async insertInbox(row) {
      check(await supabase.from('email_followups').upsert(row, { onConflict: 'gmail_message_id', ignoreDuplicates: true }));
    },
    // Newest consent record for the phone decides; no record or a read error means no consent.
    async hasConsent(phone) {
      const { data, error } = await logDb.from('sms_consent').select('status').eq('phone', phone)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      return !error && data?.status === 'opted_in';
    },
    async recordConsent(row) {
      check(await logDb.from('sms_consent').insert(row));
    },
  };
}

// Reminders send only from their own registered number (TWILIO_REMINDER_FROM, e.g. +18777089555).
// Never the shared Messaging Service: its campaign belongs to TalentDesk's recruiting texts.
// Unset = reminder texting is off; sends are logged as errors and nothing goes out.
// Reminders run on their own Twilio account (TWILIO_REMINDER_ACCOUNT_SID /
// TWILIO_REMINDER_AUTH_TOKEN) so TalentDesk's account, brand and campaign stay separate.
// Falls back to the main account's credentials only if the reminder pair is unset.
function createTwilioSender() {
  return async (to, body) => {
    const from = process.env.TWILIO_REMINDER_FROM;
    if (!from) throw new Error('TWILIO_REMINDER_FROM not set — reminder texting is off');
    const sid = process.env.TWILIO_REMINDER_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_REMINDER_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Twilio not configured');
    const twilio = require('twilio')(sid, token);
    const msg = await twilio.messages.create({ body, from, to });
    return msg.sid;
  };
}

function createClaudeCaller() {
  return async (prompt) => {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.tracker_key });
    const msg = await client.messages.create({ model: MODEL, max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
    return msg.content?.[0]?.text || '';
  };
}

module.exports = {
  PEOPLE,
  PROMPT_KINDS,
  BRAND,
  CONSENT_TEXT,
  OPT_IN_CONFIRMATION,
  keywordOf,
  scheduledText,
  sendOptInConfirmation,
  phoneToPerson,
  allowedAssignees,
  looksLikeRequest,
  localDate,
  localHour,
  addDays,
  dueLabel,
  formatDue,
  pickDueItems,
  stuckReason,
  formatDigest,
  formatAssignment,
  formatSummary,
  parseSimpleReply,
  validateActions,
  validateRequests,
  notifyAssignment,
  runHourly,
  handleInboundSms,
  createSupabaseStore,
  createTwilioSender,
  createClaudeCaller,
};
