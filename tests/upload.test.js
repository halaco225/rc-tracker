const request = require('supertest');

const mockUpload = jest.fn().mockResolvedValue({ error: null });
const mockGetPublicUrl = jest.fn().mockReturnValue({
  data: { publicUrl: 'https://example.supabase.co/storage/v1/object/public/note-images/test.jpg' }
});

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: jest.fn(),
    storage: {
      from: () => ({
        upload: mockUpload,
        getPublicUrl: mockGetPublicUrl,
      })
    }
  })
}));

const app = require('../server');

describe('POST /api/upload-image', () => {
  it('returns 400 when no file sent', async () => {
    const res = await request(app).post('/api/upload-image');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  it('returns 400 for non-image file', async () => {
    const res = await request(app)
      .post('/api/upload-image')
      .attach('file', Buffer.from('hello'), { filename: 'test.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);
  });

  it('returns url on success', async () => {
    const res = await request(app)
      .post('/api/upload-image')
      .attach('file', Buffer.from('fakejpeg'), { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('note-images');
  });
});
