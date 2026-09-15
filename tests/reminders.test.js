const r = require('../reminders');

// 2026-09-15 is a Tuesday. 13:30Z = 9:30am Eastern, 8:30am Central.
const TUE_930_ET = new Date('2026-09-15T13:30:00Z');
const MON_930_ET = new Date('2026-09-14T13:30:00Z');
const phone = name => r.PEOPLE[name].phone;

function memoryStore(items) {
  const messages = [];
  const inbox = [];
  let seq = 0;
  const find = id => items.find(i => i.id === id);
  return {
    items, messages, inbox,
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
  };
}

function setup(items, { now = TUE_930_ET, ai = null, sms } = {}) {
  const store = memoryStore(items);
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
  });

  it('uses a short hint after that', () => {
    const body = r.formatDigest(items, '2026-09-15', 3);
    expect(body).toContain('Reply "1 done", "1 Fri", or "list"');
    expect(body).not.toContain('add a note');
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
    expect(first.digests).toEqual([{ person: 'Darian Spikes', status: 'sent' }]);
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
    expect(summaries[0].body).toContain('✅ Done last week: 1 — Jorge 1');
    expect(summaries[0].body).toContain('⏰ Overdue now: 1 — Ebony 1');
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
    expect(sent[0].body).toBe('Got it!\n✅ Done: Task a');
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
    expect(res).toEqual({ handled: true, created: 1 });
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

  it('defaults to tomorrow when no day is given', async () => {
    const ai = jest.fn().mockResolvedValue('{"reminders":[{"assignee":"Jorge Garcia","text":"Check the cooler","due_date":null}]}');
    const { deps, store } = setup([], { ai });
    await r.handleInboundSms(deps, { from: phone('Jorge Garcia'), body: 'remind me to check the cooler' });
    expect(store.items[0].due_date).toBe('2026-09-16');
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

  it('does not treat texts from RGMs or unknown numbers as requests', async () => {
    const ai = jest.fn();
    const { deps } = setup([], { ai });
    const res = await r.handleInboundSms(deps, { from: '+15555550100', body: 'remind me to order cheese' });
    expect(res.handled).toBe(false);
    expect(ai).not.toHaveBeenCalled();
  });
});
