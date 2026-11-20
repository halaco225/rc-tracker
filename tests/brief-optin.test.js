const { briefOptIns, DEFAULT_BRIEF_PEOPLE } = require('../reminders');

describe('who gets the daily numbers brief', () => {
  it('is Harold and Matt and nobody else before anyone touches a checkbox', () => {
    expect(briefOptIns([])).toEqual({ 'Harold Lacoste': true, 'Matt Hester': true });
    expect(DEFAULT_BRIEF_PEOPLE).toContain('Harold Lacoste');
  });

  it('leaves everyone else off even when the table is missing', () => {
    const on = briefOptIns(undefined);
    expect(on['Jorge Garcia']).toBeUndefined();
    expect(on['Michelle Meehan']).toBeUndefined();
  });

  it('turns someone on when an RC checks the box', () => {
    expect(briefOptIns([{ person: 'Jorge Garcia', enabled: true }])['Jorge Garcia']).toBe(true);
  });

  it('lets a default person opt out', () => {
    expect(briefOptIns([{ person: 'Matt Hester', enabled: false }])['Matt Hester']).toBe(false);
  });
});
