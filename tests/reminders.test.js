const r = require('../reminders');

// 2026-09-15 is a Tuesday. 13:30Z = 9:30am Eastern, 8:30am Central.
const TUE_930_ET = new Date('2026-09-15T13:30:00Z');
const MON_930_ET = new Date('2026-09-14T13:30:00Z');
const phone = name => r.PEOPLE[name].phone;

function memoryStore(items, consent) {
  const messages = [];
  const inbox = [];
  const consentLog = [];
  const log = [];
  let seq = 0;
  const find = id => items.find(i => i.id === id);
  return {
    items, messages, inbox, consentLog, log,
    async hasConsent(phoneNumber) {
      if (consent === 'all') return true;
      const last = [...consentLog].reverse().find(c => c.phone === phoneNumber);
      return last ? last.status === 'opted_in' : false;
    },
    async recordConsent(row) { consentLog.push(row); },
    async getOpenItems() { return items.filter(i => i.status !== 'done' && r.PEOPLE[i.assigned_to]); },
    async getOpenItemsFor(p) { return items.filter(i => i.status !== 'done' && i.assigned_to === p); },
    async getDoneSince(iso) { return items.filter(i => i.status === 'done' && (i.updated_at || '') >= iso); },
    async getItemsByIds(ids) { return ids.map(id => find(id) || null); },
    async createItem(row) { const item = { ...row, id: `new${items.length + 1}`, status: 'open' }; items.push(item); return item; },
    async updateItem(id, patch) { Object.assign(find(id), patch); },
    async appendNote(id, note) { const i = find(id); i.notes = [note, ...(i.notes || [])]; },
    async markTexted(ids, iso) { ids.forEach(id => { if (find(id)) find(id).last_texted_at = iso; }); },
    async claimMessage(row) {
      if (row.local_date && messages.some(m => m.person === row.person && m.kind === row.kind && m.local_date === row.local_date)) return null;
      const m = { ...row, id: String(++seq), error: null };
      messages.push(m);
      return m;
    },
    async updateMessage(id, patch) { Object.assign(messages.find(m => m.id === id), patch); },
    async countTexts(p) { return messages.filter(m => m.person === p && !m.error && r.PROMPT_KINDS.includes(m.kind)).length; },
    async lastPrompt(p) { return [...messages].reverse().find(m => m.person === p && !m.error && r.PROMPT_KINDS.includes(m.kind)) || null; },
    async insertInbox(row) { if (!inbox.some(x => x.gmail_message_id === row.gmail_message_id)) inbox.push(row); },
    async hasBeenTexted(phoneNumber) { return log.some(m => m.phone === phoneNumber && m.direction === 'outbound' && m.status !== 'failed'); },
    async logMessage(row) { log.push({ ...row, created_at: new Date().toISOString() }); },
    async updateMessageStatus(sid, patch) { const m = log.find(x => x.twilio_sid === sid); if (m) Object.assign(m, patch); },
  };
}

function setup(items, { now = TUE_930_ET, ai = null, sms, consent = 'all' } = {}) {
  const store = memoryStore(items, consent);
  const sent = [];
  const deps = {
    store,
    now: () => now,
    ai,
    sms: sms || (async (to, body) => { sent.push({ to, body }); return `SM${sent.length}`; }),
  };
  return { deps, store, sent };
}

const fu = (id, fields) => ({ id, text: `Task ${id}`, status: 'open', notes: [], due_push_count: 0, ...fields });

describe('people.json', () => {
  it('has a valid phone, time zone, and RC for everyone', () => {
    const names = Object.keys(r.PEOPLE);
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) {
      const p = r.PEOPLE[name];
      expect(p.phone).toMatch(/^\+1\d{10}$/);
      expect(['America/New_York', 'America/Chicago', 'America/Denver']).toContain(p.tz);
      expect(r.PEOPLE[p.rc]).toBeDefined();
      expect(name).not.toMatch(/[()]/);
    }
    expect(new Set(names.map(phone)).size).toBe(names.length);
  });

  it('matches phone numbers in any format', () => {
    const digits = phone('Jorge Garcia').slice(-10);
    expect(r.phoneToPerson(`(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`)).toBe('Jorge Garcia');
    expect(r.phoneToPerson('+15555550100')).toBeNull();
  });
});

describe('allowedAssignees', () => {
  it('lets ACs assign only themselves', () => {
    expect(r.allowedAssignees('Jorge Garcia')).toEqual(['Jorge Garcia']);
  });

  it('lets RCs assign themselves and their own ACs', () => {
    const allowed = r.allowedAssignees('Harold Lacoste');
    expect(allowed).toEqual(expect.arrayContaining(['Harold Lacoste', 'Jorge Garcia', 'Darian Spikes']));
    expect(allowed).not.toContain('Lori Schwartz');
    expect(allowed.every(n => n === 'Harold Lacoste' || r.PEOPLE[n].rc === 'Harold Lacoste')).toBe(true);
  });

  it('lets VPs assign their RCs and ACs', () => {
    const allowed = r.allowedAssignees('Matt Hester');
    expect(allowed).toEqual(expect.arrayContaining(['Matt Hester', 'Harold Lacoste']));
    expect(allowed.every(n => n === 'Matt Hester' || r.PEOPLE[n].vp === 'Matt Hester')).toBe(true);
  });

  it('gives unknown senders nothing', () => {
    expect(r.allowedAssignees('Sylvia Brown')).toEqual([]);
  });
});

describe('dates', () => {
  it('uses each person\'s local time', () => {
    expect(r.localHour(TUE_930_ET, 'America/New_York')).toBe(9);
    expect(r.localHour(TUE_930_ET, 'America/Chicago')).toBe(8);
    expect(r.localDate(new Date('2026-09-16T02:00:00Z'), 'America/New_York')).toBe('2026-09-15');
  });

  it('labels due dates', () => {
    expect(r.dueLabel('2026-09-15', '2026-09-15')).toBe('due today');
    expect(r.dueLabel('2026-09-16', '2026-09-15')).toBe('due tomorrow');
    expect(r.dueLabel('2026-09-14', '2026-09-15')).toBe('1 day overdue');
    expect(r.dueLabel('2026-09-12', '2026-09-15')).toBe('3 days overdue');
    expect(r.formatDue('2026-09-19')).toBe('Sat 9/19');
  });
});

describe('pickDueItems', () => {
  it('keeps open items due tomorrow, today, or overdue, oldest first', () => {
    const items = [
      fu('a', { due_date: '2026-09-16' }),
      fu('b', { due_date: '2026-09-15' }),
      fu('c', { due_date: '2026-09-12' }),
      fu('d', { due_date: '2026-09-20' }),
      fu('e', { due_date: null }),
      fu('f', { due_date: '2026-09-15', status: 'done' }),
    ];
    expect(r.pickDueItems(items, '2026-09-15').map(i => i.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('formatting', () => {
  const items = [fu('a', { due_date: '2026-09-15' }), fu('b', { due_date: '2026-09-16' })];

  it('includes full reply instructions for the first 3 texts', () => {
    const body = r.formatDigest(items, '2026-09-15', 2);
    expect(body).toContain('1) Task a — due today');
    expect(body).toContain('"1 waiting on parts" = add a note');
    expect(body).toContain('Reply STOP to opt out.');
  });

  it('uses a short hint after that', () => {
    const body = r.formatDigest(items, '2026-09-15', 3);
    expect(body).toContain('Reply "1 done" or a new due date like "1 Fri" — "list" for all your items');
    expect(body).not.toContain('add a note');
    expect(body).not.toContain('STOP');   // the first texts carry the opt-out wording, not every one
  });

  it('uses number-free instructions for a single assignment', () => {
    const body = r.formatAssignment(fu('a', { due_date: '2026-09-19' }), 'Harold Lacoste', '2026-09-15', 0);
    expect(body).toContain('New follow-up from Harold Lacoste:\n1) Task a — due Sat 9/19');
    expect(body).toContain('"done" = finished');
  });
});

describe('parseSimpleReply', () => {
  it('handles common replies without AI', () => {
    expect(r.parseSimpleReply('1 done', 3).actions).toEqual([{ item: 1, type: 'done' }]);
    expect(r.parseSimpleReply('1 and 3 completed!', 3).actions).toEqual([{ item: 1, type: 'done' }, { item: 3, type: 'done' }]);
    expect(r.parseSimpleReply('All done', 2).actions).toHaveLength(2);
    expect(r.parseSimpleReply('Done.', 1).actions).toEqual([{ item: 1, type: 'done' }]);
    expect(r.parseSimpleReply('LIST', 0).list).toBe(true);
  });

  it('leaves ambiguous or free-form replies to AI', () => {
    expect(r.parseSimpleReply('done', 3)).toBeNull();
    expect(r.parseSimpleReply('5 done', 3)).toBeNull();
    expect(r.parseSimpleReply('2 by Friday', 3)).toBeNull();
  });
});

describe('validateActions', () => {
  it('drops out-of-range items, past dates, and duplicates', () => {
    const actions = r.validateActions([
      { item: 1, type: 'due', due_date: '2026-09-18' },
      { item: 1, type: 'done' },
      { item: 2, type: 'due', due_date: '2026-09-01' },
      { item: 9, type: 'done' },
      { item: 3, type: 'note' },
      { item: 2, type: 'explode' },
    ], 3, '2026-09-15');
    expect(actions).toEqual([{ item: 1, type: 'due', due_date: '2026-09-18' }, { item: 3, type: 'note' }]);
  });
});

describe('stuckReason', () => {
  it('flags 3+ days overdue or 3+ push-backs', () => {
    expect(r.stuckReason(fu('a', { due_date: '2026-09-12' }), '2026-09-15')).toBe('3 days overdue');
    expect(r.stuckReason(fu('a', { due_date: '2026-09-13' }), '2026-09-15')).toBeNull();
    expect(r.stuckReason(fu('a', { due_date: '2026-09-20', due_push_count: 3 }), '2026-09-15')).toBe('due date pushed back 3 times');
    expect(r.stuckReason(fu('a', { due_date: '2026-09-01', status: 'done' }), '2026-09-15')).toBeNull();
  });
});

describe('runHourly', () => {
  const items = () => [
    fu('a', { assigned_to: 'Darian Spikes', due_date: '2026-09-15' }),
    fu('b', { assigned_to: 'Marc Gannon', due_date: '2026-09-15' }),
    fu('c', { assigned_to: 'Darian Spikes', due_date: '2026-09-25' }),
  ];

  it('texts people whose local time is 9am, once per day', async () => {
    const { deps, sent, store } = setup(items());
    const first = await r.runHourly(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(phone('Darian Spikes'));
    expect(sent[0].body).toContain('1) Task a — due today');
    expect(first.digests).toMatchObject([{ person: 'Darian Spikes', status: 'sent' }]);
    expect(store.items[0].last_texted_at).toBe(TUE_930_ET.toISOString());

    await r.runHourly(deps);
    expect(sent).toHaveLength(1);
  });

  it('retries on the next run after a failed send', async () => {
    let fail = true;
    const { deps, store } = setup(items(), { sms: async () => { if (fail) throw new Error('carrier blocked'); return 'SM1'; } });
    const first = await r.runHourly(deps);
    expect(first.digests[0].status).toBe('error');
    fail = false;
    const second = await r.runHourly(deps);
    expect(second.digests[0].status).toBe('sent');
    expect(store.messages.filter(m => m.error)).toHaveLength(1);
  });

  it('previews without sending in dry run', async () => {
    const { deps, sent } = setup(items());
    const result = await r.runHourly({ ...deps, dryRun: true });
    expect(sent).toHaveLength(0);
    expect(result.digests.map(d => d.person).sort()).toEqual(['Darian Spikes', 'Marc Gannon']);
  });

  it('alerts the inbox once per stuck item', async () => {
    const { deps, store } = setup([fu('s', { assigned_to: 'Jorge Garcia', due_date: '2026-09-10', rc_name: 'Harold Lacoste' })]);
    await r.runHourly(deps);
    await r.runHourly(deps);
    expect(store.inbox).toHaveLength(1);
    expect(store.inbox[0].subject).toBe('⚠ Stuck: Task s');
    expect(store.inbox[0].note_text).toContain('5 days overdue');
  });

  it('sends the Monday summary for Harold\'s region to Harold once', async () => {
    const list = [
      fu('d', { assigned_to: 'Jorge Garcia', status: 'done', updated_at: '2026-09-12T15:00:00Z' }),
      fu('o', { assigned_to: 'Ebony Simmons', due_date: '2026-09-13', due_push_count: 1 }),
      fu('x', { assigned_to: 'Lori Schwartz', due_date: '2026-09-13' }),
    ];
    const { deps, sent, store } = setup(list, { now: MON_930_ET });
    await r.runHourly(deps);
    await r.runHourly(deps);
    const summaries = sent.filter(s => s.to === phone('Harold Lacoste'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].body).toContain('✅ 1 finished last week\nJorge 1');
    expect(summaries[0].body).toContain('⚠️ 1 overdue\n\nEbony\n• Task o — 1 day late');
    expect(summaries[0].body).not.toContain('Lori');   // Matt's region, not Harold's
    expect(store.inbox.some(i => i.subject === '📊 Weekly follow-up summary')).toBe(true);
  });
});

describe('notifyAssignment', () => {
  it('texts the assignee right away', async () => {
    const { deps, sent } = setup([]);
    const res = await r.notifyAssignment(deps, fu('a', { assigned_to: 'Jadon McNeil', rc_name: 'Harold Lacoste', due_date: '2026-09-19' }));
    expect(res.status).toBe('sent');
    expect(sent[0].to).toBe(phone('Jadon McNeil'));
  });

  it('skips people without phones, Everyone, and self-assignments', async () => {
    const { deps, sent } = setup([]);
    await r.notifyAssignment(deps, fu('a', { assigned_to: 'Everyone', rc_name: 'Harold Lacoste' }));
    await r.notifyAssignment(deps, fu('b', { assigned_to: 'Sylvia Brown', rc_name: 'Harold Lacoste' }));
    await r.notifyAssignment(deps, fu('c', { assigned_to: 'Harold Lacoste', rc_name: 'Harold Lacoste' }));
    expect(sent).toHaveLength(0);
  });

  it('texts an RC assigned by their VP', async () => {
    const { deps, sent } = setup([]);
    await r.notifyAssignment(deps, fu('a', { assigned_to: 'Harold Lacoste', rc_name: 'Harold Lacoste' }), 'Matt Hester');
    expect(sent[0].body).toContain('New follow-up from Matt Hester');
  });
});

describe('handleInboundSms: replies', () => {
  const twoItems = () => [
    fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15' }),
    fu('b', { assigned_to: 'Jorge Garcia', due_date: '2026-09-16' }),
  ];

  async function afterDigest(opts) {
    const ctx = setup(twoItems(), opts);
    await r.runHourly(ctx.deps);
    ctx.sent.length = 0;
    return ctx;
  }

  it('marks an item done from "1 done" and confirms', async () => {
    const { deps, store, sent } = await afterDigest();
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: '1 done' });
    expect(res.handled).toBe(true);
    expect(store.items[0].status).toBe('done');
    expect(store.items[0].notes[0].text).toBe('📱 Text reply from Jorge Garcia: "1 done"');
    expect(store.items[0].last_reply).toBe('1 done');
    expect(sent[0].body).toBe('Ayvaz RC Tracker\nGot it!\n✅ Done: Task a');
  });

  it('moves a due date using AI and counts the push-back', async () => {
    const ai = jest.fn().mockResolvedValue('{"list":false,"actions":[{"item":2,"type":"due","due_date":"2026-09-18"}]}');
    const { deps, store, sent } = await afterDigest({ ai });
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: '2 by friday' });
    expect(res.handled).toBe(true);
    expect(ai.mock.calls[0][0]).toContain('2) Task b (due 2026-09-16)');
    expect(store.items[1].due_date).toBe('2026-09-18');
    expect(store.items[1].due_push_count).toBe(1);
    expect(sent[0].body).toContain('📅 Moved to Fri 9/18: Task b');
  });

  it('asks which one when a bare "done" is ambiguous', async () => {
    const ai = jest.fn().mockResolvedValue('{"list":false,"needs_number":true,"actions":[]}');
    const { deps, store, sent } = await afterDigest({ ai });
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'done' });
    expect(res.handled).toBe(true);
    expect(store.items.every(i => i.status === 'open')).toBe(true);
    expect(sent[0].body).toContain('Which one?');
  });

  it('sends unrelated texts to the inbox', async () => {
    const ai = jest.fn().mockResolvedValue('{"list":false,"actions":[]}');
    const { deps } = await afterDigest({ ai });
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'Can you call me about the Mableton manager?' });
    expect(res.handled).toBe(false);
  });

  it('ignores unknown numbers, people with no recent reminder, and picture messages', async () => {
    const { deps } = setup(twoItems());
    expect((await r.handleInboundSms(deps, { from: '+15555550100', body: '1 done' })).handled).toBe(false);
    expect((await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: '1 done' })).handled).toBe(false);
    expect((await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'list', hasMedia: true })).handled).toBe(false);
  });

  it('replies to "list" with all open items, which later replies refer to', async () => {
    const { deps, store, sent } = setup(twoItems());
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'list' });
    expect(res.handled).toBe(true);
    expect(sent[0].body).toContain('Your open follow-ups:\n1) Task a — due today\n2) Task b — due tomorrow');
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: '2 done' });
    expect(store.items[1].status).toBe('done');
  });
});

describe('SMS consent and keywords', () => {
  const dueForDarian = () => [fu('a', { assigned_to: 'Darian Spikes', due_date: '2026-09-15' })];

  it('does not send reminders to people who have not opted in', async () => {
    const { deps, sent } = setup(dueForDarian(), { consent: 'none' });
    const result = await r.runHourly(deps);
    expect(result.digests).toEqual([{ person: 'Darian Spikes', status: 'no consent' }]);
    expect(sent).toHaveLength(0);
  });

  it('sends after texting START, with the program name and opt-out language', async () => {
    const { deps, sent, store } = setup(dueForDarian(), { consent: 'none' });
    expect(await r.handleInboundSms(deps, { from: phone('Darian Spikes'), body: 'Start' })).toEqual({ handled: true, keyword: 'start' });
    expect(store.consentLog[0]).toMatchObject({ phone: phone('Darian Spikes'), name: 'Darian Spikes', status: 'opted_in', source: 'keyword_start' });
    await r.runHourly(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.startsWith('Ayvaz RC Tracker\n')).toBe(true);
    expect(sent[0].body).toContain('Reply STOP to opt out.');
  });

  it('stops sending after STOP', async () => {
    const { deps, sent } = setup(dueForDarian(), { consent: 'none' });
    await r.handleInboundSms(deps, { from: phone('Darian Spikes'), body: 'START' });
    await r.handleInboundSms(deps, { from: phone('Darian Spikes'), body: 'STOP' });
    const result = await r.runHourly(deps);
    expect(result.digests[0].status).toBe('no consent');
    expect(sent).toHaveLength(0);
  });

  it('handles keywords from any number without creating follow-ups', async () => {
    const ai = jest.fn();
    const { deps, store, sent } = setup([], { consent: 'none', ai });
    expect((await r.handleInboundSms(deps, { from: '+15555550100', body: 'unsubscribe' })).handled).toBe(true);
    expect((await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'HELP' })).keyword).toBe('help');
    expect(store.consentLog).toEqual([expect.objectContaining({ phone: '+15555550100', status: 'opted_out', source: 'keyword_stop' })]);
    expect(store.items).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(ai).not.toHaveBeenCalled();
  });

  it('still answers people who text in before opting in', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Jorge Garcia","text":"Check the cooler","due_date":null}]}');
    const { deps, sent } = setup([], { consent: 'none', ai });
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'remind me to check the cooler' });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('✅ Added to your follow-ups:');
  });

  it('keeps the sign-up page wording identical to the stored consent text', () => {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'sms-opt-in.html'), 'utf8');
    expect(html.replace(/&amp;/g, '&')).toContain(r.CONSENT_TEXT);
  });
});

describe('handleInboundSms: "remind me" requests', () => {
  it('only treats reminder-style texts as requests', () => {
    expect(r.looksLikeRequest('Remind me to order cheese Friday')).toBe(true);
    expect(r.looksLikeRequest("don't let me forget the schedule")).toBe(true);
    expect(r.looksLikeRequest('add a follow up to call 39380')).toBe(true);
    expect(r.looksLikeRequest('Follow up: cooler is broken at 39380')).toBe(false);
    expect(r.looksLikeRequest('2 remind me Friday')).toBe(false);
  });

  it('creates a follow-up for the sender under their RC and confirms', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Jorge Garcia","text":"Order cheese for 39380","due_date":"2026-09-18"}],"unknown_names":[]}');
    const { deps, store, sent } = setup([], { ai });
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'remind me to order cheese for 39380 friday' });
    expect(res).toMatchObject({ handled: true, created: 1 });
    expect(ai.mock.calls[0][0]).toContain('They can create reminders for: Jorge Garcia.');
    expect(store.items[0]).toMatchObject({
      text: 'Order cheese for 39380', assigned_to: 'Jorge Garcia', due_date: '2026-09-18',
      source: 'sms', rc_name: 'Harold Lacoste', note_text: 'remind me to order cheese for 39380 friday',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('✅ Added to your follow-ups:\n1) Order cheese for 39380 — due Fri 9/18');
    expect(sent[0].body).toContain('"done" = finished');

    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'done' });
    expect(store.items[0].status).toBe('done');
  });

  it('asks when it is due instead of guessing, then sets the date from the answer', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Jorge Garcia","text":"Follow up on Suzy\'s training","due_date":null}]}');
    const { deps, store, sent } = setup([], { ai });

    const asked = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: "remind me to follow up on Suzy's training" });
    expect(asked).toMatchObject({ handled: true, asked: true });
    expect(store.items[0].due_date).toBeFalsy();
    expect(sent[0].body).toContain('When should I remind you about "Follow up on Suzy\'s training"?');

    // "Friday" needs no AI call — the regex fast path handles it.
    ai.mockClear();
    const answered = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'Friday' });
    expect(answered).toMatchObject({ handled: true, dueDate: '2026-09-18' });
    expect(ai).not.toHaveBeenCalled();
    expect(store.items[0].due_date).toBe('2026-09-18');
    expect(sent[1].body).toContain("👍 I'll remind you Fri 9/18:\n- Follow up on Suzy's training");
    expect(sent[1].body).toContain('"done" = finished');
  });

  it('falls back to AI for a wordy day answer', async () => {
    const ai = jest.fn()
      .mockResolvedValueOnce('{"reminders":[{"assignee":"Jorge Garcia","text":"Order cheese","due_date":null}]}')
      .mockResolvedValueOnce('{"due_date":"2026-09-21"}');
    const { deps, store } = setup([], { ai });
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'remind me to order cheese' });
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'start of next week I guess' });
    expect(store.items[0].due_date).toBe('2026-09-21');
  });

  it('treats a reply with no day in it as a normal message, not a due date', async () => {
    const ai = jest.fn()
      .mockResolvedValueOnce('{"reminders":[{"assignee":"Jorge Garcia","text":"Order cheese","due_date":null}]}')
      .mockResolvedValueOnce('{"due_date":null}')
      .mockResolvedValueOnce('{"actions":[{"item":1,"type":"note"}]}');
    const { deps, store } = setup([], { ai });
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'remind me to order cheese' });
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'waiting on the DM' });
    expect(store.items[0].due_date).toBeFalsy();
    expect(store.items[0].notes[0].text).toContain('waiting on the DM');
  });
});

describe('parseDayAnswer', () => {
  const today = '2026-09-15'; // Tuesday

  it('reads plain day answers', () => {
    expect(r.parseDayAnswer('today', today)).toBe('2026-09-15');
    expect(r.parseDayAnswer('Tomorrow.', today)).toBe('2026-09-16');
    expect(r.parseDayAnswer('friday', today)).toBe('2026-09-18');
    expect(r.parseDayAnswer('Thurs', today)).toBe('2026-09-17');
    expect(r.parseDayAnswer('next tuesday', today)).toBe('2026-09-22');
    expect(r.parseDayAnswer('9/25', today)).toBe('2026-09-25');
    expect(r.parseDayAnswer('in 3 days', today)).toBe('2026-09-18');
    expect(r.parseDayAnswer('in 2 weeks', today)).toBe('2026-09-29');
  });

  it('rolls a past month/day into next year and ignores non-days', () => {
    expect(r.parseDayAnswer('1/5', today)).toBe('2027-01-05');
    expect(r.parseDayAnswer('sometime soon', today)).toBeNull();
    expect(r.parseDayAnswer('done', today)).toBeNull();
    expect(r.parseDayAnswer('13/40', today)).toBeNull();
  });
});

describe('attachments', () => {
  it('splits images (MMS) from other files (links)', () => {
    const { images, links } = r.splitMedia([
      { url: 'https://x/a.png', type: 'image/png', name: 'a.png' },
      { url: 'https://x/deck.pdf', type: 'application/pdf', name: 'deck.pdf' },
      { url: 'https://x/photo.JPG', name: 'photo.JPG' },
      { url: '', type: 'image/png' },
      null,
    ]);
    expect(images.map(f => f.name)).toEqual(['a.png', 'photo.JPG']);
    expect(links.map(f => f.name)).toEqual(['deck.pdf']);
  });

  it('caps MMS images at 10', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ url: `https://x/${i}.png`, type: 'image/png' }));
    expect(r.splitMedia(many).images).toHaveLength(10);
    expect(r.splitMedia(many).links).toHaveLength(4);
  });

  it('builds a compose body with the brand, file links, and opt-out', () => {
    const text = r.composeText('  Team meeting moved to 9am.  ', [{ url: 'https://x/deck.pdf', name: 'deck.pdf' }]);
    expect(text).toBe('Ayvaz RC Tracker\nTeam meeting moved to 9am.\n\n📎 deck.pdf: https://x/deck.pdf\n\nReply STOP to opt out');
    expect(r.composeText('Hi')).toBe('Ayvaz RC Tracker\nHi\n\nReply STOP to opt out');
  });
});

describe('times of day', () => {
  it('reads a time out of a request', () => {
    expect(r.parseTime('remind me at 2:10pm today')).toBe('14:10');
    expect(r.parseTime('at 2pm')).toBe('14:00');
    expect(r.parseTime('call them at 9:30 am')).toBe('09:30');
    expect(r.parseTime('by noon')).toBe('12:00');
    expect(r.parseTime('at 14:10')).toBe('14:10');
    expect(r.parseTime('12am')).toBe('00:00');
    expect(r.parseTime('remind me 5')).toBeNull();        // no am/pm, no colon
    expect(r.parseTime('check the walk-in Friday')).toBeNull();
  });

  it('shows the time on screen the way people say it', () => {
    expect(r.formatTime('14:10')).toBe('2:10pm');
    expect(r.formatTime('09:00')).toBe('9am');
    expect(r.formatTime('00:30')).toBe('12:30am');
    expect(r.dueLabel('2026-09-15', '2026-09-15', '14:10')).toBe('due today at 2:10pm');
  });

  it('texts at the due time, not at 9am the next morning', async () => {
    // 2026-09-15 18:15Z = 2:15pm Eastern, just past a 2:10pm reminder.
    const at215 = new Date('2026-09-15T18:15:00Z');
    const item = fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15', due_time: '14:10' });
    const { deps, store, sent } = setup([item], { now: at215 });
    const res = await r.runHourly(deps);
    expect(res.timed).toMatchObject([{ person: 'Jorge Garcia', id: 'a', status: 'sent' }]);
    expect(sent[0].body).toContain('⏰ Reminder: Task a');
    expect(store.items[0].timed_sent_at).toBe(at215.toISOString());

    // A later run in the same day must not send it twice.
    sent.length = 0;
    await r.runHourly({ ...deps, now: () => new Date('2026-09-15T19:00:00Z') });
    expect(sent.filter(s => s.body.includes('⏰'))).toHaveLength(0);
  });

  it('waits until the time actually arrives', async () => {
    const at1pm = new Date('2026-09-15T17:00:00Z'); // 1pm Eastern
    const { deps, store } = setup([fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15', due_time: '14:10' })], { now: at1pm });
    const res = await r.runHourly(deps);
    expect(res.timed).toEqual([]);
    expect(store.items[0].timed_sent_at).toBeUndefined();
  });

  it('uses each person\'s own clock', async () => {
    // 15:05Z = 11:05am Eastern, 10:05am Central. A 10:30 local reminder is due for neither.
    const now = new Date('2026-09-15T15:05:00Z');
    const { deps } = setup([
      fu('east', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15', due_time: '10:30' }),   // Eastern: passed
      fu('central', { assigned_to: 'Alpha Garza', due_date: '2026-09-15', due_time: '10:30' }), // Central: not yet
    ], { now });
    expect(r.PEOPLE['Jorge Garcia'].tz).toBe('America/New_York');
    expect(r.PEOPLE['Alpha Garza'].tz).toBe('America/Chicago');
    const res = await r.runHourly(deps);
    expect(res.timed.map(t => t.id)).toEqual(['east']);
  });

  it('leaves a missed time to the overdue digest instead of firing late', async () => {
    const { deps, store, sent } = setup([fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-14', due_time: '14:10' })], { now: TUE_930_ET });
    const res = await r.runHourly(deps);
    expect(res.timed).toMatchObject([{ id: 'a', status: 'missed — left to the digest' }]);
    expect(sent.filter(s => s.body.includes('⏰'))).toHaveLength(0);
    expect(store.items[0].timed_sent_at).toBe(TUE_930_ET.toISOString());
  });

  it('creates a timed follow-up from "remind me at 2:10pm today"', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Jorge Garcia","text":"Check e6 learning","due_date":"2026-09-15","due_time":"14:10"}],"unknown_names":[]}');
    const { deps, store, sent } = setup([], { ai });
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'Remind me at 2:10pm today to check e6 learning' });
    expect(store.items[0]).toMatchObject({ due_date: '2026-09-15', due_time: '14:10' });
    expect(sent[0].body).toContain('due today at 2:10pm');
  });

  it('treats a bare time as today', () => {
    const { reminders: out } = r.validateRequests(
      { reminders: [{ assignee: 'Jorge Garcia', text: 'Call the DM', due_date: null, due_time: '16:00' }] },
      ['Jorge Garcia'], '2026-09-15');
    expect(out[0]).toMatchObject({ due_date: '2026-09-15', due_time: '16:00' });
  });

  it('re-arms the text when a reply moves the time', async () => {
    const ai = jest.fn().mockResolvedValue('{"actions":[{"item":1,"type":"due","due_date":"2026-09-18"}]}');
    const items = [fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15', due_time: '14:10', timed_sent_at: '2026-09-15T18:15:00Z' })];
    const { deps, store } = setup(items, { ai });
    await r.runHourly(deps);                                   // makes it the last prompt
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'push it to Friday at 8am' });
    expect(store.items[0]).toMatchObject({ due_date: '2026-09-18', due_time: '08:00', timed_sent_at: null });
  });
});

describe('what went wrong on 9/20–9/21', () => {
  it('reads "1-done" and its cousins without asking the AI', () => {
    for (const reply of ['1-done', '1 - done', '1. done', '1) done', '#1 done', '1done', 'done 1', 'Done #1']) {
      expect(r.parseSimpleReply(reply, 2)).toEqual({ list: false, actions: [{ item: 1, type: 'done' }] });
    }
  });

  it('never lets the AI act on an item the reply did not name, or move a date it did not mention', async () => {
    // What happened to Harold: "1-done" also moved item 2 to today.
    const ai = jest.fn().mockResolvedValue('{"actions":[{"item":1,"type":"done"},{"item":2,"type":"due","due_date":"2026-09-15"}]}');
    const items = [fu('a', { assigned_to: 'Harold Lacoste', due_date: '2026-08-15' }), fu('b', { assigned_to: 'Harold Lacoste', due_date: '2026-09-14' })];
    const { deps, store } = setup(items, { ai });
    await r.runHourly(deps);
    await r.handleInboundSms(deps, { from: phone('Harold Lacoste'), body: 'first one is finished' });
    expect(store.items[1]).toMatchObject({ due_date: '2026-09-14', due_push_count: 0 });
  });

  it('knows which numbers are items and when a reply names a day', () => {
    expect(r.numbersNamed('2 by 9/25', 3)).toEqual([2]);
    expect(r.numbersNamed('move 1 to friday at 2:10', 3)).toEqual([1]);
    expect(r.mentionsWhen('1-done')).toBe(false);
    expect(r.mentionsWhen('waiting on the DM')).toBe(false);
    expect(r.mentionsWhen('push to friday')).toBe(true);
    expect(r.mentionsWhen('by 9/25')).toBe(true);
  });

  it('turns Jadon\'s "Twice daily until marked complete" into a repeat, not a note', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Jorge Garcia","text":"Follow up with Markeisha and Wyatt on training","due_date":null}]}');
    const at1128 = new Date('2026-09-15T15:28:00Z'); // 11:28am Eastern
    const { deps, store, sent } = setup([], { ai, now: at1128 });
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'Remind me to follow up with Markeisha and Wyatt on training' });
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'Twice daily until marked complete' });

    expect(res).toMatchObject({ handled: true, repeat: ['09:00', '15:00'] });
    expect(store.items[0]).toMatchObject({ repeat_times: ['09:00', '15:00'], due_date: '2026-09-15', repeat_last_slot: '2026-09-15 09:00' });
    expect(store.items[0].notes).toEqual([]);
    expect(sent[1].body).toContain('🔁 Got it — I\'ll remind you twice a day (9am & 3pm) until you reply "done"');
  });

  it('fires each repeat slot once, skips the one already past, and stops when done', async () => {
    const item = fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15', repeat_times: ['09:00', '15:00'], repeat_last_slot: '2026-09-15 09:00' });
    const { deps, store, sent } = setup([item]);
    const at = iso => ({ ...deps, now: () => new Date(iso) });

    await r.runHourly(at('2026-09-15T16:00:00Z'));                // noon: 9am slot already counted
    expect(sent.filter(s => s.body.includes('🔁'))).toHaveLength(0);

    await r.runHourly(at('2026-09-15T19:05:00Z'));                // 3:05pm: send the 3pm slot
    await r.runHourly(at('2026-09-15T19:35:00Z'));                // 3:35pm: not again
    expect(sent.filter(s => s.body.includes('🔁 Reminder: Task a'))).toHaveLength(1);
    expect(store.items[0].repeat_last_slot).toBe('2026-09-15 15:00');

    await r.runHourly(at('2026-09-16T13:02:00Z'));                // next morning 9:02am
    expect(sent.filter(s => s.body.includes('🔁 Reminder: Task a'))).toHaveLength(2);

    store.items[0].status = 'done';
    await r.runHourly(at('2026-09-16T19:05:00Z'));
    expect(sent.filter(s => s.body.includes('🔁 Reminder: Task a'))).toHaveLength(2);
  });

  it('puts a 9am repeat inside the morning list, so "done" has a number to point at', async () => {
    // Jadon's real setup: a twice-daily item plus two overdue ones.
    const items = [
      fu('krystle', { assigned_to: 'Jorge Garcia', due_date: '2026-06-17' }),
      fu('tim', { assigned_to: 'Jorge Garcia', due_date: '2026-09-10' }),
      fu('training', { assigned_to: 'Jorge Garcia', due_date: '2026-09-14', repeat_times: ['09:00', '15:00'], repeat_last_slot: '2026-09-14 15:00' }),
    ];
    const { deps, store, sent } = setup(items, { now: new Date('2026-09-15T13:03:00Z') }); // 9:03am Eastern
    await r.runHourly(deps);

    expect(sent).toHaveLength(1);                                   // one text, not two at once
    expect(sent[0].body).toContain('3) Task training — 🔁 twice a day (9am & 3pm)');
    expect(store.items[2].repeat_last_slot).toBe('2026-09-15 09:00');

    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: '3 done' });
    expect(store.items[2].status).toBe('done');

    // …and with it done, the 3pm slot doesn't fire.
    await r.runHourly({ ...deps, now: () => new Date('2026-09-15T19:03:00Z') });
    expect(sent.filter(s => s.body.includes('🔁 Reminder'))).toHaveLength(0);
  });

  it('keeps repeating items out of the morning list so it is two texts a day, not three', () => {
    const items = [fu('a', { due_date: '2026-09-15', repeat_times: ['09:00', '15:00'] }), fu('b', { due_date: '2026-09-15' })];
    expect(r.pickDueItems(items, '2026-09-15').map(i => i.id)).toEqual(['b']);
  });

  it('reads the ways people ask for a repeat', () => {
    expect(r.parseRepeat('Twice daily until marked complete')).toEqual(['09:00', '15:00']);
    expect(r.parseRepeat('every day at 2pm')).toEqual(['14:00']);
    expect(r.parseRepeat('every morning')).toEqual(['09:00']);
    expect(r.parseRepeat('3x a day')).toEqual(['09:00', '13:00', '17:00']);
    expect(r.parseRepeat('Friday')).toBeNull();
    expect(r.parseRepeat('done')).toBeNull();
  });

  it('answers a text that only lands in the inbox, and says where relays go', () => {
    expect(r.inboxAck('Follow up o. Jefferson oven')).toBe('📥 Saved to your tracker inbox.');
    expect(r.inboxAck('Send this picture to Ebony and Jadon on 9/23/26 at 10am')).toContain('schedule it in the Message Center');
  });

  it('does not repeat the STOP line when the intro already has it', () => {
    const text = r.composeText('Follow up on E6 training', [], true);
    expect(text.match(/STOP to opt out/g)).toHaveLength(1);
  });
});

describe('Message Center messages', () => {
  it('does not let "done" after a plain message close an older reminder', async () => {
    const { deps, store, sent } = setup([fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15' })]);
    await r.runHourly(deps);                                    // morning list about item a
    // A plain Message Center text is recorded as the newest thing we asked them.
    await store.claimMessage({ person: 'Jorge Garcia', phone: phone('Jorge Garcia'), kind: 'compose', item_ids: [], body: 'Call Hugo about the admin line', local_date: null });

    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'done' });
    expect(res.handled).toBe(false);                            // goes to the inbox instead
    expect(store.items[0].status).toBe('open');                 // the reminder is untouched
    expect(sent.filter(s => s.body.includes('✅ Done'))).toHaveLength(0);
  });

  it('closes the right item when the message was tracked as a follow-up', async () => {
    const { deps, store } = setup([
      fu('old', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15' }),
      fu('new', { assigned_to: 'Jorge Garcia', due_date: '2026-09-18', text: 'Call Hugo about the admin line' }),
    ]);
    await r.runHourly(deps);
    await store.claimMessage({ person: 'Jorge Garcia', phone: phone('Jorge Garcia'), kind: 'assignment', item_ids: ['new'], body: 'Call Hugo about the admin line', local_date: null });

    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'done' });
    expect(store.items[1].status).toBe('done');
    expect(store.items[0].status).toBe('open');
  });

  it('tells them it is on their list and how to close it', () => {
    expect(r.assignmentHint({ due_date: '2026-09-28' }))
      .toBe('This is on your follow-ups. Due Mon 9/28. Reply "done" when it\'s finished, or a new due date to move it.');
    expect(r.assignmentHint({ due_date: '2026-09-28', due_time: '14:00' })).toContain('Due Mon 9/28 at 2pm.');
    expect(r.assignmentHint({ repeat_times: ['09:00', '15:00'] }))
      .toContain('I\'ll remind you twice a day (9am & 3pm) until you reply "done"');
  });
});

describe('weekly summary', () => {
  const today = '2026-09-21';
  const open = [
    fu('krystle', { assigned_to: 'Jadon McNeil', text: 'Need DRs note from krystle on treatment and information of when they return', due_date: '2026-06-17' }),
    fu('tim', { assigned_to: 'Jadon McNeil', text: 'Documentation for Tim for allowing people to work not scheduled', due_date: '2026-09-18' }),
    fu('speed', { assigned_to: 'Harold Lacoste', text: 'Check with speed', due_date: '2026-09-19' }),
    fu('later', { assigned_to: 'Harold Lacoste', text: 'Later thing', due_date: '2026-09-24' }),
  ];
  const done = ['Jadon McNeil', 'Jadon McNeil', 'Jadon McNeil', 'Harold Lacoste', 'Harold Lacoste', 'Michelle Meehan', 'Michelle Meehan']
    .map((assigned_to, i) => fu(`d${i}`, { assigned_to, status: 'done' }));

  it('groups what is late by person, most behind first, and cuts at word boundaries', () => {
    const body = r.formatSummary({ done, open, today });
    expect(body).toBe([
      '📊 Weekly check-in · Mon 9/21',
      '',
      '✅ 7 finished last week',
      'Jadon 3 · Harold 2 · Michelle 2',
      '',
      '⚠️ 3 overdue',
      '',
      'Jadon',
      '• Need DRs note from krystle on… — 96 days late 🔴',
      '• Documentation for Tim for allowing… — 3 days late 🔴',
      '',
      'Harold',
      '• Check with speed — 2 days late',
      '',
      '🔴 = stuck: 3+ days late or pushed back 3+ times',
      '',
      '📅 1 due this week',
    ].join('\n'));
  });

  it('says so when nothing is overdue', () => {
    expect(r.formatSummary({ done: [], open: [], today })).toContain('🎉 Nothing overdue');
  });
});

describe('first-contact intro', () => {
  const items = () => [fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15', rc_name: 'Harold Lacoste' })];

  it('leads the very first text with what the tracker is, then never again', async () => {
    const { deps, sent } = setup(items(), { now: TUE_930_ET });
    await r.runHourly(deps);
    expect(sent[0].body).toContain('This is the RC Tracker from Ayvaz');
    expect(sent[0].body).toContain('Reply DONE when you finish one');
    expect(sent[0].body).toContain('1) Task a — due today');
    // Numbered replies are for digests, not the intro.
    expect(sent[0].body.split('Reply DONE')[0]).not.toContain('"1 done"');

    const next = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'list' });
    expect(next.handled).toBe(true);
    expect(sent[1].body).not.toContain('This is the RC Tracker from Ayvaz');
  });

  it('does not count a failed send as first contact', async () => {
    let fail = true;
    const { deps, sent } = setup(items(), { sms: async (to, body) => { sent.push({ to, body }); if (fail) throw new Error('carrier blocked'); return 'SM1'; } });
    await r.runHourly(deps);
    fail = false;
    const { deps: d2 } = { deps };
    await r.handleInboundSms(d2, { from: phone('Jorge Garcia'), body: 'list' });
    expect(sent[1].body).toContain('This is the RC Tracker from Ayvaz');
  });

  it('adds the intro to a Message Center compose only for a new number', () => {
    expect(r.composeText('Team meeting at 9.', [], true)).toContain('This is the RC Tracker from Ayvaz');
    expect(r.composeText('Team meeting at 9.', [], false)).not.toContain('This is the RC Tracker from Ayvaz');
    expect(r.composeText('Team meeting at 9.', [], true).match(/STOP to opt out/g)).toHaveLength(1);
  });
});

describe('message log', () => {
  it('records every outbound text, with the Twilio sid, for the Message Center', async () => {
    const { deps, store } = setup([fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15', rc_name: 'Harold Lacoste' })]);
    await r.runHourly(deps);
    const out = store.log.filter(m => m.direction === 'outbound');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ person: 'Jorge Garcia', phone: phone('Jorge Garcia'), status: 'sent', kind: 'digest' });
    expect(out[0].twilio_sid).toMatch(/^SM/);
    expect(out[0].follow_up_ids).toEqual(['a']);
  });

  it('logs a failure instead of a send when Twilio errors', async () => {
    const { deps, store } = setup([fu('a', { assigned_to: 'Jorge Garcia', due_date: '2026-09-15', rc_name: 'Harold Lacoste' })], {
      sms: async () => { throw new Error('Twilio down'); },
    });
    await r.runHourly(deps);
    expect(store.log[0]).toMatchObject({ direction: 'outbound', status: 'failed', error: 'Twilio down' });
  });

  it('lets an RC remind one of their ACs, texting both', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Jorge Garcia","text":"Send weekend schedule","due_date":"2026-09-16"}],"unknown_names":[]}');
    const { deps, store, sent } = setup([], { ai });
    const res = await r.handleInboundSms(deps, { from: phone('Harold Lacoste'), body: 'remind Jorge to send the weekend schedule tomorrow' });
    expect(res.handled).toBe(true);
    expect(store.items[0]).toMatchObject({ assigned_to: 'Jorge Garcia', rc_name: 'Harold Lacoste' });
    const toJorge = sent.find(s => s.to === phone('Jorge Garcia'));
    const toHarold = sent.find(s => s.to === phone('Harold Lacoste'));
    expect(toJorge.body).toContain('New follow-up from Harold Lacoste:\n1) Send weekend schedule — due Wed 9/16');
    expect(toHarold.body).toContain('✅ Sent:\n- Jorge: Send weekend schedule — due tomorrow');
  });

  it('refuses assignees the sender cannot assign', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Ebony Simmons","text":"Call me back","due_date":null}],"unknown_names":[]}');
    const { deps, store, sent } = setup([], { ai });
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'remind Ebony to call me back' });
    expect(res.handled).toBe(true);
    expect(store.items).toHaveLength(0);
    expect(sent[0].body).toContain('Couldn\'t match "Ebony Simmons"');
  });

  it('falls through to the inbox when AI says it is not a request', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[],"unknown_names":[]}');
    const { deps, store } = setup([], { ai });
    const res = await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'Did you get my reminder about the audit?' });
    expect(res.handled).toBe(false);
    expect(store.items).toHaveLength(0);
  });

  it('tells an RC when the person they assigned has not signed up for texts', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Jorge Garcia","text":"Send weekend schedule","due_date":"2026-09-16"}],"unknown_names":[]}');
    const { deps, store, sent } = setup([], { consent: 'none', ai });
    await r.handleInboundSms(deps, { from: phone('Harold Lacoste'), body: 'remind Jorge to send the weekend schedule tomorrow' });
    expect(store.items[0]).toMatchObject({ assigned_to: 'Jorge Garcia' });
    expect(sent.map(s => s.to)).toEqual([phone('Harold Lacoste')]);
    expect(sent[0].body).toContain('Jorge: Send weekend schedule — due tomorrow (not signed up for texts yet)');
  });

  it('does not treat texts from RGMs or unknown numbers as requests', async () => {
    const ai = jest.fn();
    const { deps } = setup([], { ai });
    const res = await r.handleInboundSms(deps, { from: '+15555550100', body: 'remind me to order cheese' });
    expect(res.handled).toBe(false);
    expect(ai).not.toHaveBeenCalled();
  });
});
