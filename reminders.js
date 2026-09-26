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
// Kinds a reply can be about. 'compose' carries no items, so a "done" after a
// plain Message Center text lands in the inbox instead of closing an older item.
const PROMPT_KINDS = ['digest', 'assignment', 'list', 'ask_due', 'timed', 'compose'];

// ── SMS program compliance (A2P 10DLC) ──
const BRAND = 'Ayvaz RC Tracker';
// Shown beside the sign-up checkbox (public/sms-opt-in.html repeats it) and stored with each web opt-in.
const CONSENT_TEXT = 'I agree to receive recurring work follow-up reminder texts from Ayvaz RC Tracker at the mobile number above. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Consent is not a condition of employment.';
const OPT_IN_CONFIRMATION = `${BRAND}: You're signed up for work follow-up reminder texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
// Rides along on the very first text a person ever gets from the tracker, so nobody
// has to be told separately what this number is. Sent once, then never again.
const INTRO = `This is the RC Tracker from Ayvaz. It texts you reminders about your follow-ups.
Reply DONE when you finish one, a day like "Friday" or 9/25 to move it, or LIST to see everything on your plate. You can also text "remind me to ___" and it'll set one up for you.
Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
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

// ── Times of day ('HH:MM', 24h, local to the person it's for) ──
function localMinutes(now, tz) {
  const [h, m] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(now).split(':');
  return Number(h) * 60 + Number(m);
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function formatTime(hhmm) {
  const mins = toMinutes(hhmm);
  if (mins === null) return '';
  const h = Math.floor(mins / 60), m = mins % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}

// "2:10pm", "at 2pm", "14:10", "by noon" → 'HH:MM'. Bare numbers need am/pm or a colon,
// so "remind me 5" doesn't silently become 5:00.
function parseTime(text) {
  const t = String(text || '').toLowerCase();
  if (/\bnoon\b/.test(t)) return '12:00';
  if (/\bmidnight\b/.test(t)) return '00:00';
  const m = /\b(?:at|by|around|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/.exec(t)
    || /\b(?:at|by|around|@)\s*(\d{1,2}):(\d{2})\b/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ampm = (m[3] || '').replace(/\./g, '');
  if (h > 23 || min > 59) return null;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (!ampm && h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// ── Repeating reminders: "twice daily until marked complete" ──
// Returns the local times to text every day until the item is done, or null.
function parseRepeat(text) {
  const t = String(text || '').toLowerCase();
  const repeats = /\b(daily|every ?day|each day|a day|per day|twice|every (?:morning|afternoon|evening|night)|each (?:morning|afternoon|evening)|times a day|x a day|2x|3x)\b/;
  if (!repeats.test(t)) return null;
  if (/\b(three times|3 times|3x|thrice)\b/.test(t)) return ['09:00', '13:00', '17:00'];
  if (/\b(twice|two times|2 times|2x)\b/.test(t)) return ['09:00', '15:00'];
  const at = parseTime(t);
  if (/\bafternoon\b/.test(t)) return [at || '14:00'];
  if (/\b(evening|night)\b/.test(t)) return [at || '18:00'];
  return [at || '09:00'];
}

function repeatLabel(times) {
  const list = (times || []).map(formatTime);
  if (list.length === 1) return `every day at ${list[0]}`;
  if (list.length === 2) return `twice a day (${list[0]} & ${list[1]})`;
  return `${list.length} times a day (${list.join(', ')})`;
}

// The most recent slot at or before now, as 'YYYY-MM-DD HH:MM' — or null before the
// first one today. Setting a repeat marks this as already sent, so saying "twice a
// day" at 11am doesn't fire the 9am slot at you on the spot.
function currentSlot(now, tz, times) {
  const nowMin = localMinutes(now, tz);
  const passed = (times || []).filter(t => toMinutes(t) !== null && toMinutes(t) <= nowMin).sort();
  return passed.length ? `${localDate(now, tz)} ${passed[passed.length - 1]}` : null;
}

// What to show beside an item: its repeat schedule if it has one, else its due date.
function whenLabel(fu, today) {
  return hasRepeat(fu) ? `🔁 ${repeatLabel(fu.repeat_times)}` : dueLabel(fu.due_date, today, fu.due_time);
}

// The repeat slot that's due now and hasn't gone out, or null.
function dueRepeatSlot(fu, now) {
  if (!hasRepeat(fu)) return null;
  const p = PEOPLE[fu.assigned_to];
  if (!p || (fu.due_date && fu.due_date > localDate(now, p.tz))) return null;   // starts on its due date
  const slot = currentSlot(now, p.tz, fu.repeat_times);
  return slot && !(fu.repeat_last_slot && fu.repeat_last_slot >= slot) ? slot : null;
}

function dueLabel(due, today, time = null) {
  if (!due) return 'no due date';
  const at = time ? ` at ${formatTime(time)}` : '';
  const diff = daysBetween(today, due);
  if (diff === 0) return `due today${at}`;
  if (diff === 1) return `due tomorrow${at}`;
  if (diff < 0) return `${-diff} day${diff === -1 ? '' : 's'} overdue`;
  return `due ${formatDue(due)}${at}`;
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

function hasRepeat(fu) {
  return Array.isArray(fu.repeat_times) && fu.repeat_times.length > 0;
}

// Items on a repeat schedule get their own texts, so they stay out of the morning
// list — otherwise "twice a day" would be three texts a day.
function pickDueItems(items, today) {
  const tomorrow = addDays(today, 1);
  return items.filter(fu => isOpen(fu) && !hasRepeat(fu) && fu.due_date && fu.due_date <= tomorrow).sort(byDueDate);
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
  // The running hint drops the opt-out line — everyone got it in their first texts,
  // and STOP keeps working whether or not it's repeated here.
  return single
    ? 'Reply "done" or a new due date like "Fri" — "list" for all your items'
    : 'Reply "1 done" or a new due date like "1 Fri" — "list" for all your items';
}

function itemLines(items, today) {
  const shown = items.slice(0, MAX_LIST_ITEMS);
  const lines = shown.map((fu, i) => `${i + 1}) ${truncate(fu.text, 70)} — ${whenLabel(fu, today)}`);
  if (items.length > shown.length) lines.push(`+${items.length - shown.length} more in the tracker`);
  return lines.join('\n');
}

function formatDigest(items, today, priorCount) {
  const count = Math.min(items.length, MAX_LIST_ITEMS);
  return `Your follow-up reminders:\n${itemLines(items, today)}\n\n${instructions(priorCount, count)}`;
}

function formatAssignment(fu, from, today, priorCount) {
  const due = fu.due_date ? `due ${formatDue(fu.due_date)}${fu.due_time ? ` at ${formatTime(fu.due_time)}` : ''}` : 'no due date';
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

// Cut at a word boundary so "…on treatment and infor…" reads as "…on treatment…".
function shortText(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

const SUMMARY_MAX_PEOPLE = 5;
const SUMMARY_MAX_ITEMS = 3;

// One section per person who's behind, most-behind first — who needs a nudge is the
// question an RC is asking on Monday. Stuck items get a 🔴 inline instead of a
// separate bucket that repeated the same items.
function formatSummary({ done, open, today }) {
  const lateBy = fu => daysBetween(fu.due_date, today);
  const overdue = open.filter(fu => fu.due_date && fu.due_date < today);
  const dueThisWeek = open.filter(fu => fu.due_date && fu.due_date >= today && fu.due_date <= addDays(today, 6));
  const lines = [`📊 Weekly check-in · ${formatDue(today)}`, ''];

  lines.push(done.length
    ? `✅ ${done.length} finished last week\n${countByPerson(done).replace(/, /g, ' · ')}`
    : '✅ Nothing marked done last week');

  if (overdue.length) {
    const byPerson = new Map();
    for (const fu of overdue) {
      if (!byPerson.has(fu.assigned_to)) byPerson.set(fu.assigned_to, []);
      byPerson.get(fu.assigned_to).push(fu);
    }
    const people = [...byPerson.entries()]
      .map(([name, items]) => [name, items.sort((a, b) => lateBy(b) - lateBy(a))])
      .sort((a, b) => b[1].length - a[1].length || lateBy(b[1][0]) - lateBy(a[1][0]));
    lines.push('', `⚠️ ${overdue.length} overdue`);
    let anyStuck = false;
    for (const [name, items] of people.slice(0, SUMMARY_MAX_PEOPLE)) {
      lines.push('', firstName(name));
      for (const fu of items.slice(0, SUMMARY_MAX_ITEMS)) {
        const days = lateBy(fu);
        const stuck = stuckReason(fu, today);
        anyStuck = anyStuck || !!stuck;
        lines.push(`• ${shortText(fu.text, 38)} — ${days} day${days === 1 ? '' : 's'} late${stuck ? ' 🔴' : ''}`);
      }
      if (items.length > SUMMARY_MAX_ITEMS) lines.push(`• +${items.length - SUMMARY_MAX_ITEMS} more`);
    }
    if (people.length > SUMMARY_MAX_PEOPLE) lines.push('', `+${people.length - SUMMARY_MAX_PEOPLE} more people in the tracker`);
    if (anyStuck) lines.push('', '🔴 = stuck: 3+ days late or pushed back 3+ times');
  } else {
    lines.push('', '🎉 Nothing overdue');
  }

  if (dueThisWeek.length) lines.push('', `📅 ${dueThisWeek.length} due this week`);
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
  // "1 done", "1-done", "1. done", "1) done", "#1 done", "1done", "1 and 3 done" — and "done 1".
  const NUMS = '#?(\\d+(?:\\s*(?:,|&|and)\\s*#?\\d+)*)';
  const m = t.match(new RegExp(`^${NUMS}\\s*[-.):]?\\s*(?:is |are )?${DONE_WORDS}$`))
    || t.match(new RegExp(`^${DONE_WORDS}\\s*[-:]?\\s*(?:with |on )?${NUMS}$`));
  if (m) {
    const nums = m[1].split(/\s*(?:,|&|and)\s*/).map(s => Number(s.replace('#', '')));
    if (nums.every(n => n >= 1 && n <= itemCount)) {
      return { list: false, actions: nums.map(item => ({ item, type: 'done' })) };
    }
  }
  return null;
}

// Item numbers the person actually typed — not the 9 in "9/25" or the 2 in "at 2:10".
function numbersNamed(body, itemCount) {
  const found = new Set();
  for (const m of String(body || '').matchAll(/(?<![\d/:.])#?(\d{1,2})(?![\d/:]|\s*(?:am|pm)\b)/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= itemCount) found.add(n);
  }
  return [...found];
}

// Does the reply say *when*? Without this, a date change is the AI guessing.
function mentionsWhen(body) {
  return /\b(today|tonight|tomorrow|tmrw|tmw|mon|tue|wed|thu|fri|sat|sun|week|month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|eod|noon)\w*\b|\d{1,2}\s*[/-]\s*\d{1,2}|\bin \d+ (?:day|week)|\d\s*(?:am|pm)\b|\b(?:at|by) \d/i
    .test(String(body || ''));
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
  // The AI may only act on what the reply actually says: the items it names (when it
  // names any), and a new date only when it mentions one. "1-done" once also moved
  // item 2 to "today" — this is the guard against that.
  const named = numbersNamed(body, items.length);
  const saysWhen = mentionsWhen(body);
  const actions = validateActions(parsed.actions, items.length, today)
    .filter(a => items[a.item - 1])
    .filter(a => !named.length || named.includes(a.item))
    .filter(a => a.type !== 'due' || saysWhen);
  return { list: parsed.list === true, needsNumber: parsed.needs_number === true && !actions.length, actions };
}

// ── Answering "when should I remind you?" ──
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseDayAnswer(text, today) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  if (/^(today|tonight)$/.test(t)) return today;
  if (/^(tomorrow|tmrw|tmw|tom)$/.test(t)) return addDays(today, 1);
  const wd = t.match(/^(next |this )?(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*$/);
  if (wd) {
    const stem = wd[2].slice(0, 3);
    const target = WEEKDAYS.findIndex(d => d.startsWith(stem));
    if (target >= 0) {
      const todayIdx = new Date(`${today}T12:00:00Z`).getUTCDay();
      let delta = (target - todayIdx + 7) % 7;
      if (delta === 0) delta = 7;
      if (wd[1] && wd[1].trim() === 'next' && delta < 7) delta += 7;
      return addDays(today, delta);
    }
  }
  const md = t.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = md[3] ? Number(md[3].length === 2 ? `20${md[3]}` : md[3]) : Number(today.slice(0, 4));
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (date >= today) return date;
      if (!md[3]) return `${year + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const inDays = t.match(/^in (\d{1,2}) (day|days|week|weeks)$/);
  if (inDays) return addDays(today, Number(inDays[1]) * (inDays[2].startsWith('week') ? 7 : 1));
  return null;
}

// Returns a due date when the reply names a day, else null (then it's treated as a normal message).
async function interpretDueAnswer({ ai, body, today, now, tz }) {
  const simple = parseDayAnswer(body, today);
  if (simple) return simple;
  if (!ai) return null;
  const prompt = `Today is ${localWeekday(now, tz)} ${today}. Upcoming dates: ${upcomingDates(today)}.
Someone was asked when a work task should be done. They replied: """${body}"""
Return ONLY JSON: {"due_date":"YYYY-MM-DD"} with the day they mean (resolve weekdays to the next matching date on or after today), or {"due_date":null} if the reply does not name a day.`;
  const parsed = extractJson(await ai(prompt));
  const d = parsed && parsed.due_date;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today && d <= addDays(today, 365)) return d;
  return null;
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

Return ONLY JSON like {"reminders": [{"assignee": "Full Name", "text": "Call Jorge about labor", "due_date": "YYYY-MM-DD", "due_time": "HH:MM"}], "unknown_names": []}
Rules:
- Only create reminders when the message asks to be reminded, asks to remind or assign someone, or asks to add a follow-up/task/to-do. A message just reporting information is not a request.
- "me", "I", "myself" means ${sender}.
- assignee must be exactly one of the names listed above. Match a first name or nickname only when it clearly means one listed person. If they name someone who is not listed, put the name they used in "unknown_names" instead.
- text: a short task in the imperative, without "remind me to". Keep store numbers, names, and details.
- due_date: the day they mention. Weekdays resolve to the next matching date on or after today; "tomorrow" is ${addDays(today, 1)}. Use null if no day is given.
- due_time: 24-hour "HH:MM" when they name a time of day ("2:10pm" -> "14:10", "by noon" -> "12:00"). Use null when they give no time. A time with no day means today.
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
    // No day given stays null — the tracker texts back to ask when.
    const validDate = typeof r.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.due_date) && r.due_date >= today && r.due_date <= maxDate;
    const due_time = typeof r.due_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.due_time) ? r.due_time : null;
    // A time with no day means today — "remind me at 2:10" never means "someday at 2:10".
    reminders.push({
      assignee: r.assignee,
      text: truncate(r.text, 200),
      due_date: validDate ? r.due_date : (due_time ? today : null),
      due_time,
    });
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
  // "Remind me twice a day to…" sets the schedule up front — no need to ask when.
  const repeatTimes = parseRepeat(text);
  for (const req of reminders) {
    const item = await deps.store.createItem({
      text: req.text,
      assigned_to: req.assignee,
      due_date: req.due_date || (repeatTimes ? today : null),
      due_time: req.due_time,
      repeat_times: repeatTimes,
      repeat_last_slot: repeatTimes ? currentSlot(now, PEOPLE[req.assignee].tz, repeatTimes) : null,
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
  const undated = mine.filter(fu => !fu.due_date);
  const sections = [];
  if (mine.length) sections.push(`✅ Added to your follow-ups:\n${itemLines(mine, today)}`);
  if (others.length) {
    const line = fu => `- ${firstName(fu.assigned_to)}: ${truncate(fu.text, 60)} — ${whenLabel(fu, today)}${notSignedUp.has(fu.id) ? ' (not signed up for texts yet)' : ''}`;
    sections.push(`✅ Sent:\n${others.map(line).join('\n')}`);
  }
  if (unknown.length) sections.push(`⚠ Couldn't match ${unknown.map(n => `"${n}"`).join(', ')} to anyone you can assign. Use their full name.`);

  if (undated.length) {
    // Ask when it's due; their next text sets the date (handled by the ask_due branch).
    sections.push(`When should I remind you about "${truncate(undated[0].text, 60)}"? Reply with a day, like "Friday" or "9/25".`);
    await sendText(deps, { person, kind: 'ask_due', itemIds: undated.map(fu => fu.id), body: sections.join('\n\n'), reply: true });
  } else if (mine.length) {
    sections.push(instructions(await deps.store.countTexts(person), mine.length));
    await sendText(deps, { person, kind: 'assignment', itemIds: mine.map(fu => fu.id), body: sections.join('\n\n'), reply: true });
  } else {
    await sendText(deps, { person, kind: 'confirm', body: sections.join('\n\n'), reply: true });
  }
  return { handled: true, created: created.length, asked: undated.length > 0 };
}

// ── Sending ──
// `reply` marks a direct answer to a text the person just sent us; everything else
// requires their SMS opt-in.
async function sendText(deps, { person, kind, itemIds = [], body, localDate: date = null, reply = false, media = [] }) {
  const p = PEOPLE[person];
  if (!p) return { status: 'no phone' };
  if (!reply && !(await deps.store.hasConsent(p.phone))) return { status: 'no consent' };
  const firstContact = deps.store.hasBeenTexted ? !(await deps.store.hasBeenTexted(p.phone)) : false;
  const text = `${BRAND}\n${firstContact ? `${INTRO}\n\n` : ''}${body}`;
  const row = await deps.store.claimMessage({ person, phone: p.phone, kind, item_ids: itemIds, body: text, local_date: date });
  if (!row) return { status: 'already sent' };
  try {
    const sid = await deps.sms(p.phone, text, media);
    await deps.store.updateMessage(row.id, { twilio_sid: sid || null });
    if (itemIds.length) await deps.store.markTexted(itemIds, deps.now().toISOString());
    await deps.store.logMessage({
      direction: 'outbound', person, phone: p.phone, body: text, media, kind,
      status: 'sent', twilio_sid: sid || null, follow_up_ids: itemIds,
    });
    return { status: 'sent', sid };
  } catch (e) {
    // Free the once-a-day slot so the next hourly run can retry.
    await deps.store.updateMessage(row.id, { error: e.message, local_date: null });
    await deps.store.logMessage({
      direction: 'outbound', person, phone: p.phone, body: text, media, kind,
      status: 'failed', error: e.message, follow_up_ids: itemIds,
    });
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
  const result = { digests: [], timed: [], stuck: [], summary: null };

  // Timed reminders: "remind me at 2:10pm". Fires the first run at or after that
  // minute in the person's own time zone — the cron runs every few minutes, so a
  // due time is accurate to the tick, not to 9am the next morning.
  for (const fu of openItems) {
    if (!fu.due_time || fu.timed_sent_at || !fu.due_date) continue;
    const p = PEOPLE[fu.assigned_to];
    if (!p) continue;
    const today = localDate(now, p.tz);
    if (fu.due_date > today) continue;                                  // its day hasn't come
    const dueMin = toMinutes(fu.due_time);
    if (fu.due_date === today && dueMin !== null && localMinutes(now, p.tz) < dueMin) continue;
    if (deps.dryRun) { result.timed.push({ person: fu.assigned_to, id: fu.id, status: 'preview' }); continue; }
    // Claim before sending so overlapping cron runs can't double-text.
    await deps.store.updateItem(fu.id, { timed_sent_at: iso });
    if (fu.due_date < today) { result.timed.push({ id: fu.id, status: 'missed — left to the digest' }); continue; }
    const prior = await deps.store.countTexts(fu.assigned_to);
    const body = `⏰ Reminder: ${truncate(fu.text, 120)}\n\n${instructions(prior, 1)}`;
    const sent = await sendText(deps, { person: fu.assigned_to, kind: 'timed', itemIds: [fu.id], body });
    if (sent.status === 'error') await deps.store.updateItem(fu.id, { timed_sent_at: null }); // let the next run retry
    result.timed.push({ person: fu.assigned_to, id: fu.id, ...sent });
  }

  // Morning lists. A repeat reminder that comes due in the same run rides inside the
  // list as a numbered line instead of arriving as a second text at the same moment —
  // replies go to the latest text, so a separate 🔁 text followed by the list left
  // "done" pointing at the list, where the repeat item had no number.
  for (const person of Object.keys(PEOPLE)) {
    const { tz } = PEOPLE[person];
    const hour = localHour(now, tz);
    if (!deps.dryRun && (hour < SEND_WINDOW.start || hour >= SEND_WINDOW.end)) continue;
    const today = localDate(now, tz);
    const mine = openItems.filter(fu => fu.assigned_to === person);
    const due = pickDueItems(mine, today);
    if (!due.length) continue;
    const repeatsNow = mine.filter(fu => dueRepeatSlot(fu, now));
    const listed = [...due, ...repeatsNow].slice(0, MAX_LIST_ITEMS);
    const prior = await deps.store.countTexts(person);
    const body = formatDigest(listed, today, prior);
    if (deps.dryRun) { result.digests.push({ person, status: 'preview', body }); continue; }
    const sent = await sendText(deps, { person, kind: 'digest', itemIds: listed.map(fu => fu.id), body, localDate: today });
    result.digests.push({ person, ...sent });
    if (sent.status === 'sent') {
      for (const fu of repeatsNow.filter(f => listed.includes(f))) {
        fu.repeat_last_slot = dueRepeatSlot(fu, now);
        await deps.store.updateItem(fu.id, { repeat_last_slot: fu.repeat_last_slot });
      }
    }
  }

  // Repeating reminders ("twice daily until marked complete"): each run sends the
  // latest slot that has come due today and hasn't gone out yet, unless the morning
  // list above already carried it. Marking the item done drops it from openItems,
  // which is what ends the repeat.
  result.repeats = [];
  for (const fu of openItems) {
    const slot = dueRepeatSlot(fu, now);
    if (!slot) continue;
    if (deps.dryRun) { result.repeats.push({ person: fu.assigned_to, id: fu.id, slot, status: 'preview' }); continue; }
    const before = fu.repeat_last_slot || null;
    fu.repeat_last_slot = slot;
    await deps.store.updateItem(fu.id, { repeat_last_slot: slot });       // claim before send
    const prior = await deps.store.countTexts(fu.assigned_to);
    const body = `🔁 Reminder: ${truncate(fu.text, 120)}\n\n${instructions(prior, 1)}`;
    const sent = await sendText(deps, { person: fu.assigned_to, kind: 'timed', itemIds: [fu.id], body });
    if (sent.status === 'error') {                                        // let the next run retry
      fu.repeat_last_slot = before;
      await deps.store.updateItem(fu.id, { repeat_last_slot: before });
    }
    result.repeats.push({ person: fu.assigned_to, id: fu.id, slot, ...sent });
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

  // "Twice daily until marked complete" — a repeat schedule for what they were just
  // asked about, or for the only item in the last text. Jadon's answer to "when?"
  // once landed here as a note, leaving him with no reminders at all.
  const repeatTimes = !isList ? parseRepeat(text) : null;
  const repeatTargets = items.filter(Boolean);
  if (repeatTimes && last && repeatTargets.length && (last.kind === 'ask_due' || repeatTargets.length === 1)) {
    const startDay = mentionsWhen(text) ? await interpretDueAnswer({ ai: deps.ai, body: text, today, now, tz }) : null;
    // Starting later than today? Then nothing has "already gone out" on that day.
    const slot = startDay && startDay > today ? null : currentSlot(now, tz, repeatTimes);
    for (const fu of repeatTargets) {
      await deps.store.updateItem(fu.id, {
        repeat_times: repeatTimes, repeat_last_slot: slot,
        due_date: startDay || fu.due_date || today,
        last_reply: truncate(text, 500), last_reply_at: iso, updated_at: iso,
      });
    }
    const lines = repeatTargets.map(fu => `- ${truncate(fu.text, 60)}`).join('\n');
    const from = startDay && startDay > today ? ` starting ${formatDue(startDay)}` : '';
    await sendText(deps, {
      person, kind: 'assignment', itemIds: repeatTargets.map(fu => fu.id), reply: true,
      body: `🔁 Got it — I'll remind you ${repeatLabel(repeatTimes)}${from} until you reply "done":\n${lines}`,
    });
    return { handled: true, repeat: repeatTimes };
  }

  // They were asked when something is due — a day in this reply sets it.
  if (last && last.kind === 'ask_due' && !isList) {
    const dueDate = await interpretDueAnswer({ ai: deps.ai, body: text, today, now, tz });
    if (dueDate) {
      const dated = items.filter(Boolean);
      const answerTime = parseTime(text);
      for (const fu of dated) {
        await deps.store.updateItem(fu.id, {
          due_date: dueDate, last_reply: truncate(text, 500), last_reply_at: iso, updated_at: iso,
          ...(answerTime ? { due_time: answerTime, timed_sent_at: null } : {}),
        });
      }
      if (dated.length) {
        const prior = await deps.store.countTexts(person);
        const lines = dated.map(fu => `- ${truncate(fu.text, 60)}`).join('\n');
        await sendText(deps, {
          person, kind: 'assignment', itemIds: dated.map(fu => fu.id), reply: true,
          body: `👍 I'll remind you ${formatDue(dueDate)}:\n${lines}\n\n${instructions(prior, dated.length)}`,
        });
        return { handled: true, dueDate };
      }
    }
  }

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
      // "Friday at 9am" moves the day and the time; a new time re-arms the timed text.
      const newTime = parseTime(text);
      if (newTime) { patch.due_time = newTime; patch.timed_sent_at = null; }
      if (fu.due_date && action.due_date > fu.due_date) patch.due_push_count = (fu.due_push_count || 0) + 1;
      confirmations.push(`📅 Moved to ${formatDue(action.due_date)}${newTime ? ` at ${formatTime(newTime)}` : ''}: ${truncate(fu.text, 50)}`);
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

// Carriers deliver images reliably; PDFs, spreadsheets and docs are sent as links instead.
function splitMedia(media = []) {
  const files = (Array.isArray(media) ? media : []).filter(m => m && m.url);
  const images = files.filter(m => /^image\//i.test(m.type || '') || /\.(jpe?g|png|gif)$/i.test(m.url)).slice(0, 10);
  const links = files.filter(m => !images.includes(m));
  return { images, links };
}

// Message Center sends: program name, the note, any file links, and opt-out wording.
// `intro` adds the what-this-is block — only on someone's first text from the tracker.
function composeText(body, links = [], intro = false) {
  const fileLines = links.length ? `\n\n${links.map(f => `📎 ${f.name || 'File'}: ${f.url}`).join('\n')}` : '';
  // The intro already ends with the STOP wording — don't say it twice in one text.
  return `${BRAND}\n${intro ? `${INTRO}\n\n` : ''}${String(body || '').trim()}${fileLines}${intro ? '' : '\n\nReply STOP to opt out'}`;
}

// Tail for a Message Center text that's tracked as a follow-up, so the person knows
// it's on their list and how to close it.
function assignmentHint({ due_date, due_time, repeat_times } = {}) {
  if (Array.isArray(repeat_times) && repeat_times.length) {
    return `This is on your follow-ups — I'll remind you ${repeatLabel(repeat_times)} until you reply "done".`;
  }
  const when = due_date ? ` Due ${formatDue(due_date)}${due_time ? ` at ${formatTime(due_time)}` : ''}.` : '';
  return `This is on your follow-ups.${when} Reply "done" when it's finished, or a new due date to move it.`;
}

// Reply to a staff text that wasn't a reminder reply or request, so it never looks
// like it vanished. "Send this picture to Ebony and Jadon at 10am" asks for something
// the text line can't do yet, so say where it can be done instead.
function inboxAck(body) {
  const relay = /^\s*(?:please\s+|can you\s+|pls\s+)?(?:send|text|tell|forward|message|msg)\b/i.test(String(body || ''));
  return relay
    ? '📥 Saved to your tracker inbox. I can\'t text other people for you from here yet — schedule it in the Message Center.'
    : '📥 Saved to your tracker inbox.';
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
    // 'opted_in' | 'opted_out' | null (never heard from them). Automated reminders
    // need 'opted_in'; a hand-written Message Center text only has to clear 'opted_out'.
    async consentStatus(phone) {
      const { data, error } = await logDb.from('sms_consent').select('status').eq('phone', phone)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      return error ? null : (data?.status || null);
    },
    async recordConsent(row) {
      check(await logDb.from('sms_consent').insert(row));
    },
    // Has this number ever had a text from us? Decides whether the intro rides along.
    // On error we assume yes, so a hiccup repeats nothing.
    async hasBeenTexted(phone) {
      const { data, error } = await logDb.from('sms_messages').select('id')
        .eq('phone', phone).eq('direction', 'outbound').neq('status', 'failed').limit(1);
      return error ? true : (data || []).length > 0;
    },
    // Message Center log — never blocks a send if it fails.
    async logMessage(row) {
      const { error } = await logDb.from('sms_messages').insert(row);
      if (error) console.error('sms_messages insert error:', error.message);
    },
    async updateMessageStatus(sid, patch) {
      const { error } = await logDb.from('sms_messages').update({ ...patch, updated_at: new Date().toISOString() }).eq('twilio_sid', sid);
      if (error) console.error('sms_messages status error:', error.message);
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
  return async (to, body, media = []) => {
    const from = process.env.TWILIO_REMINDER_FROM;
    if (!from) throw new Error('TWILIO_REMINDER_FROM not set — reminder texting is off');
    const sid = process.env.TWILIO_REMINDER_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_REMINDER_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Twilio not configured');
    const twilio = require('twilio')(sid, token);
    const base = process.env.APP_BASE_URL || 'https://rc-tracker-hos2.onrender.com';
    const mediaUrl = (Array.isArray(media) ? media : []).map(m => (typeof m === 'string' ? m : m.url)).filter(Boolean);
    const msg = await twilio.messages.create({
      body,
      from,
      to,
      statusCallback: `${base}/api/sms-status`,
      ...(mediaUrl.length ? { mediaUrl } : {}),
    });
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
  INTRO,
  keywordOf,
  scheduledText,
  parseRepeat,
  repeatLabel,
  currentSlot,
  numbersNamed,
  mentionsWhen,
  parseTime,
  formatTime,
  localMinutes,
  composeText,
  assignmentHint,
  inboxAck,
  splitMedia,
  parseDayAnswer,
  sendText,
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
