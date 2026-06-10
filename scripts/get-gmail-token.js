const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3333/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars first.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.modify'],
  prompt: 'consent',
});

console.log('\nOpen this URL in your browser:\n\n' + authUrl + '\n');

const server = http.createServer(async (req, res) => {
  const qs = new url.URL(req.url, 'http://localhost:3333').searchParams;
  const code = qs.get('code');
  if (!code) { res.end('No code'); return; }

  const { tokens } = await oauth2Client.getToken(code);
  res.end('Done! Copy the refresh token from your terminal.');
  server.close();

  console.log('\n✅ GMAIL_REFRESH_TOKEN =', tokens.refresh_token);
  console.log('\nAdd this to Render env vars (and your local .env).\n');
});

server.listen(3333, () => console.log('Waiting for OAuth callback on port 3333...'));
