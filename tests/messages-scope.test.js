const request = require('supertest');

// The roster endpoint reads sms_consent. With no consent rows everyone comes back
// "not signed up", which is all this test needs — it is about who is listed, not status.
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
    }),
    storage: { from: () => ({}) },
  }),
}));

const app = require('../server');
const { PEOPLE } = require('../reminders');

describe('GET /api/sms-signups?user=', () => {
  it('gives an RC their own ACs and themselves, nobody else', async () => {
    const res = await request(app).get('/api/sms-signups?user=Preston%20Arnwine');
    expect(res.status).toBe(200);
    const names = res.body.map(p => p.name);
    expect(names).toContain('Preston Arnwine');
    expect(names).toContain('Erin Pizzo');
    expect(names).not.toContain('Harold Lacoste');
    expect(names.every(n => n === 'Preston Arnwine' || PEOPLE[n].rc === 'Preston Arnwine')).toBe(true);
  });

  it('gives a VP their whole org', async () => {
    const res = await request(app).get('/api/sms-signups?user=Matt%20Hester');
    const names = res.body.map(p => p.name);
    expect(names).toContain('Harold Lacoste');
    expect(names).toContain('Preston Arnwine');
    expect(names).not.toContain('Tracy Krumwiede');   // the other VP
  });

  // A typo in the user name must not fall back to showing the whole company.
  it('shows nobody for a name that is not in people.json', async () => {
    const res = await request(app).get('/api/sms-signups?user=Nobody');
    expect(res.body).toEqual([]);
  });

  it('still lists everyone when no user is given', async () => {
    const res = await request(app).get('/api/sms-signups');
    expect(res.body.length).toBe(Object.keys(PEOPLE).length);
  });
});
