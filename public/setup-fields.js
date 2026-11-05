// The one question the setup panel asks — "how do they hear about this?" — and the
// fields each answer writes. Pure: a follow-up row in, a choice or a field set out, no
// DOM. It lives outside index.html so tests can reach it: the bug it exists to pin is
// opening a weekly item and silently saving the weekly away.
(function (root) {
  'use strict';

  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Three common answers, then the ones behind "+ Other ways". Order is the order
  // they appear on screen.
  const SETUP_WAYS = [
    { id: 'morning', common: true, label: 'Every morning',
      sub: 'In their morning follow-ups each day until they reply "done"' },
    { id: 'once', common: true, label: 'Once', needs: 'when',
      sub: "One text and that's it" },
    { id: 'never', common: true, label: "Never — don't text them",
      sub: 'On your board only; they hear nothing' },
    { id: 'weekly', label: 'Certain days each week', needs: 'days',
      sub: 'In their morning follow-ups on the days you pick, every week' },
    { id: 'twice', label: 'Twice a day', needs: 'times',
      sub: 'Two texts a day until they reply "done"' },
    { id: 'message', label: "Just a message — don't track it", needs: 'when', track: false,
      sub: 'A text and nothing else; nothing on your board' },
  ];

  const times = fu => (Array.isArray(fu && fu.repeat_times) ? fu.repeat_times : []);

  // Which answer an existing row already represents. Order matters: no_text wins over
  // any leftover schedule, and repeat_days must be checked before repeat_times or a
  // weekly item reads as a plain daily one and loses its days on save.
  function inferWay(fu) {
    if (!fu) return 'morning';
    if (fu.no_text) return 'never';
    const reps = times(fu);
    if (Array.isArray(fu.repeat_days) && fu.repeat_days.length) return 'weekly';
    if (reps.length > 1) return 'twice';
    if (reps.length === 1) return 'weekly';          // daily at one time = all seven days
    if (fu.due_time && fu.one_time) return 'once';
    // A due_time without one_time repeats daily at that minute. There is no separate
    // choice for it; "every day at that time" is weekly with every day picked.
    if (fu.due_time) return 'weekly';
    return 'morning';
  }

  // The day buttons to show for an existing row. A single repeat time, or an older
  // daily timed reminder, means every day — not "no days picked".
  function daysOf(fu) {
    if (!fu) return [];
    if (Array.isArray(fu.repeat_days) && fu.repeat_days.length) return fu.repeat_days.slice().sort();
    if (times(fu).length === 1 || (fu.due_time && !fu.one_time)) return ALL_DAYS.slice();
    return [];
  }

  function timesOf(fu) {
    const reps = times(fu);
    if (reps.length) return reps.slice();
    if (fu && fu.due_time) return [fu.due_time];
    return ['08:00'];
  }

  // What Save posts. `state` is what the panel's controls hold:
  // { sendAt: 'YYYY-MM-DDTHH:MM', days: [0..6], times: ['HH:MM'], startDate, dueDate }
  function fieldsFor(way, state) {
    const st = state || {};
    const start = st.startDate || null;
    const due = st.dueDate || null;
    const base = { track: true, no_text: false, one_time: false, due_time: null,
      repeat_times: [], repeat_days: null, start_date: start, due_date: due };

    if (way === 'message') return { track: false };

    if (way === 'never') return { ...base, no_text: true };

    if (way === 'once') {
      const at = st.sendAt;
      // No minute picked means now, and the server works it out on the assignee's own
      // clock — a Central AC's "now" is an hour behind ours.
      if (!at) return { ...base, one_time: true, remind_now: true };
      return { ...base, one_time: true, due_date: at.slice(0, 10), due_time: at.slice(11, 16) };
    }

    if (way === 'weekly') {
      const days = (st.days || []).slice().sort();
      return { ...base, repeat_times: [(st.times || [])[0] || '08:00'],
        repeat_days: days.length ? days : null };
    }

    if (way === 'twice') {
      const two = (st.times || []).slice(0, 2);
      return { ...base, repeat_times: two.length === 2 ? two.slice().sort() : ['08:00', '15:00'] };
    }

    return base;                                       // morning
  }

  // "14:10" -> "2:10pm". Shown on screen, never stored.
  function clock(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return '';
    const h = Number(m[1]), min = Number(m[2]);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${min ? ':' + String(min).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
  }

  // One short phrase for a row's schedule, used on the pills in "Set up by text" so
  // the list and the panel never disagree about what something is set to.
  function wayLabel(fu) {
    const way = inferWay(fu);
    if (way === 'never') return 'not texted';
    if (way === 'once') return `once at ${clock(fu.due_time)}`;
    if (way === 'twice') return `twice a day, ${times(fu).map(clock).join(' & ')}`;
    if (way === 'weekly') {
      const days = daysOf(fu);
      const at = clock(timesOf(fu)[0]);
      if (days.length === 7) return `every day at ${at}`;
      return `every ${days.map(d => DAY_NAMES[d]).join(' and ')} at ${at}`;
    }
    return 'every morning';
  }

  const api = { SETUP_WAYS, ALL_DAYS, DAY_NAMES, inferWay, daysOf, timesOf, fieldsFor, wayLabel, clock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof window !== 'undefined' ? window : this));
