const request = require('supertest');

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table) => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: [], error: null }),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: 'abc', text: 'test', status: 'open', source: 'manual', notes: [] },
        error: null
      }),
    }),
    storage: { from: () => ({ upload: jest.fn().mockResolvedValue({ error: null }), getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'http://x' } }) }) }
  })
}));

const app = require('../server');

describe('GET /api/follow-ups', () => {
  it('returns 200 with array', async () => {
    const res = await request(app).get('/api/follow-ups');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/follow-ups', () => {
  it('returns 400 when text missing', async () => {
    const res = await request(app).post('/api/follow-ups').send({});
    expect(res.status).toBe(400);
  });

  it('creates follow-up with text', async () => {
    const res = await request(app)
      .post('/api/follow-ups')
      .send({ text: 'Follow up with Matt on labor', assigned_to: 'Matt Hester' });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/follow-ups/:id/done', () => {
  it('returns 200', async () => {
    const res = await request(app).patch('/api/follow-ups/abc/done');
    expect(res.status).toBe(200);
  });
});
