const s = require('../public/setup-fields');

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const state = (over = {}) => ({ sendAt: '', days: [], times: ['08:00'], startDate: '', dueDate: '', ...over });

describe('inferWay', () => {
  it('opens a weekly item as weekly, keeping its days', () => {
    const fu = { repeat_times: ['08:00'], repeat_days: [3], start_date: '2026-09-16' };
    expect(s.inferWay(fu)).toBe('weekly');
    expect(s.daysOf(fu)).toEqual([3]);
  });

  it('opens a no_text item as never', () => {
    expect(s.inferWay({ no_text: true, repeat_times: ['08:00'], repeat_days: [3] })).toBe('never');
  });

  it('opens a one-time reminder as once', () => {
    expect(s.inferWay({ due_date: '2026-09-15', due_time: '14:10', one_time: true })).toBe('once');
  });

  it('opens a twice-a-day item as twice', () => {
    expect(s.inferWay({ repeat_times: ['08:00', '15:00'] })).toBe('twice');
  });

  it('opens a plain tracked item as morning', () => {
    expect(s.inferWay({ due_date: '2026-09-20' })).toBe('morning');
    expect(s.inferWay({})).toBe('morning');
    expect(s.inferWay(null)).toBe('morning');
  });

  it('opens an older daily timed reminder as every day at that time', () => {
    // due_time without one_time repeats daily. There is no separate choice for it,
    // and showing it as "once" would quietly stop a reminder someone relies on.
    const fu = { due_date: '2026-09-15', due_time: '14:10' };
    expect(s.inferWay(fu)).toBe('weekly');
    expect(s.daysOf(fu)).toEqual(ALL_DAYS);
    expect(s.timesOf(fu)).toEqual(['14:10']);
  });
});

describe('fieldsFor', () => {
  it('posts no due time and no repeat for every morning', () => {
    expect(s.fieldsFor('morning', state({ startDate: '2026-11-05' }))).toEqual({
      track: true, no_text: false, one_time: false, due_time: null,
      repeat_times: [], repeat_days: null, start_date: '2026-11-05', due_date: null,
    });
  });

  it('clears the schedule for never', () => {
    const f = s.fieldsFor('never', state({ days: [3] }));
    expect(f).toMatchObject({ track: true, no_text: true, repeat_times: [], due_time: null, one_time: false });
  });

  it('sends now for once with no time picked', () => {
    expect(s.fieldsFor('once', state())).toMatchObject({ track: true, one_time: true, remind_now: true });
  });

  it('sends at the picked minute for once with a time', () => {
    expect(s.fieldsFor('once', state({ sendAt: '2026-11-06T07:00' })))
      .toMatchObject({ track: true, one_time: true, due_date: '2026-11-06', due_time: '07:00' });
  });

  it('keeps the days and the time for weekly', () => {
    expect(s.fieldsFor('weekly', state({ days: [0, 3], times: ['14:00'], startDate: '2026-11-10' })))
      .toMatchObject({ track: true, repeat_times: ['14:00'], repeat_days: [0, 3], start_date: '2026-11-10' });
  });

  it('posts both times for twice a day', () => {
    expect(s.fieldsFor('twice', state({ times: ['08:00', '15:00'] })))
      .toMatchObject({ track: true, repeat_times: ['08:00', '15:00'], repeat_days: null });
  });

  it('tracks nothing for just a message', () => {
    expect(s.fieldsFor('message', state()).track).toBe(false);
  });

  it('round-trips a weekly item through infer and back', () => {
    const fu = { repeat_times: ['14:00'], repeat_days: [3], start_date: '2026-09-16', due_date: '2026-09-30' };
    const way = s.inferWay(fu);
    const back = s.fieldsFor(way, state({ days: s.daysOf(fu), times: s.timesOf(fu), startDate: fu.start_date, dueDate: fu.due_date }));
    expect(back).toMatchObject({ repeat_times: ['14:00'], repeat_days: [3], start_date: '2026-09-16', due_date: '2026-09-30' });
  });
});

describe('wayLabel', () => {
  it('names each schedule the way the panel does', () => {
    expect(s.wayLabel({ repeat_times: ['08:00'], repeat_days: [3] })).toBe('every Wed at 8am');
    expect(s.wayLabel({ repeat_times: ['08:00', '15:00'] })).toBe('twice a day, 8am & 3pm');
    expect(s.wayLabel({ no_text: true })).toBe('not texted');
    expect(s.wayLabel({ due_date: '2026-09-15', due_time: '14:10', one_time: true })).toBe('once at 2:10pm');
    expect(s.wayLabel({})).toBe('every morning');
  });
});
