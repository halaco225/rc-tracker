const Imap = require('imap');
const { simpleParser } = require('mailparser');

// All area coaches with name variants for matching
const AC_MAP = {
  // Harold's ACs (Atlanta)
  'darian spikes': 'Darian Spikes', 'darian': 'Darian Spikes',
  'ebony simmons': 'Ebony Simmons', 'ebony': 'Ebony Simmons',
  'jadon mcneil': 'Jadon McNeil', 'jadon': 'Jadon McNeil', "ja'don": 'Jadon McNeil',
  'jorge garcia': 'Jorge Garcia', 'jorge': 'Jorge Garcia',
  'marc gannon': 'Marc Gannon', 'marc': 'Marc Gannon',
  'michelle meehan': 'Michelle Meehan',
  // Lori's ACs (Minnesota)
  'debbra selvig': 'Debbra Selvig', 'debbra': 'Debbra Selvig',
  'derek king': 'Derek King', 'derek': 'Derek King',
  'scott fiksdal': 'Scott Fiksdal', 'scott': 'Scott Fiksdal',
  'szymon lubas': 'Szymon Lubas', 'szymon': 'Szymon Lubas',
  'va vang': 'Va Vang',
  // Preston's ACs (Mid-Atlantic)
  'emmanuel boateng': 'Emmanuel Boateng', 'emmanuel': 'Emmanuel Boateng',
  'erin pizzo': 'Erin Pizzo', 'erin': 'Erin Pizzo',
  'royal mitchell': 'Royal Mitchell', 'royal': 'Royal Mitchell',
  'russell kowalczyk': 'Russell Kowalczyk', 'russell': 'Russell Kowalczyk',
  'stepfen white': 'Stepfen White', 'stepfen': 'Stepfen White',
  // Terrance's ACs (New Paso)
  'brenda marta': 'Brenda Marta', 'brenda': 'Brenda Marta',
  'constance miranda': 'Constance Miranda', 'constance': 'Constance Miranda',
  'eric harstine': 'Eric Harstine', 'eric': 'Eric Harstine',
  'javier martinez': 'Javier Martinez', 'javier': 'Javier Martinez',
  'kevin dunn': 'Kevin Dunn', 'kevin': 'Kevin Dunn',
  'max losey': 'Max Losey', 'max': 'Max Losey',
  'oscar gutierrez': 'Oscar Gutierrez', 'oscar': 'Oscar Gutierrez',
  'tami elliott-baker': 'Tami Elliott-Baker', 'tami': 'Tami Elliott-Baker',
};

// Map RC names for determining which RC "owns" the follow-up
const RC_BY_AC = {
  'Darian Spikes': 'Harold Lacoste', 'Ebony Simmons': 'Harold Lacoste',
  'Jadon McNeil': 'Harold Lacoste', 'Jorge Garcia': 'Harold Lacoste',
  'Marc Gannon': 'Harold Lacoste', 'Michelle Meehan': 'Harold Lacoste',
  'Debbra Selvig': 'Lori Schwartz', 'Derek King': 'Lori Schwartz',
  'Scott Fiksdal': 'Lori Schwartz', 'Szymon Lubas': 'Lori Schwartz', 'Va Vang': 'Lori Schwartz',
  'Emmanuel Boateng': 'Preston Arnwine', 'Erin Pizzo': 'Preston Arnwine',
  'Royal Mitchell': 'Preston Arnwine', 'Russell Kowalczyk': 'Preston Arnwine', 'Stepfen White': 'Preston Arnwine',
  'Brenda Marta': 'Terrance Spillane', 'Constance Miranda': 'Terrance Spillane',
  'Eric Harstine': 'Terrance Spillane', 'Javier Martinez': 'Terrance Spillane',
  'Kevin Dunn': 'Terrance Spillane', 'Max Losey': 'Terrance Spillane',
  'Oscar Gutierrez': 'Terrance Spillane', 'Tami Elliott-Baker': 'Terrance Spillane',
};

function findAC(text) {
  const lower = text.toLowerCase();
  // Try full name first, then first name
  for (const [key, fullName] of Object.entries(AC_MAP)) {
    if (lower.includes(key)) return fullName;
  }
  return null;
}

function cleanNoteText(text) {
  return (text || '')
    .replace(/^(hey\s+)?(siri|google|alexa)[,.\s]*/i, '')
    .replace(/^(remind me to|follow up with|talk to|follow up on|remind me)[,\s]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pollInbox(supabase) {
  return new Promise((resolve, reject) => {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      console.log('Gmail credentials not configured — skipping poll');
      return resolve();
    }

    const imap = new Imap({
      user: process.env.GMAIL_USER,
      password: process.env.GMAIL_APP_PASSWORD,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
      authTimeout: 5000,
    });

    let processed = 0;

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { imap.end(); return reject(err); }

        imap.search(['UNSEEN'], async (err, results) => {
          if (err || !results || results.length === 0) {
            imap.end();
            return resolve();
          }

          console.log(`Found ${results.length} unread email(s)`);
          const fetch = imap.fetch(results, { bodies: '', markSeen: true });
          const promises = [];

          fetch.on('message', (msg) => {
            const p = new Promise((res) => {
              msg.on('body', (stream) => {
                simpleParser(stream, async (err, parsed) => {
                  if (err) return res();
                  try {
                    const subject = parsed.subject || '';
                    const body = parsed.text || '';
                    const combined = subject + ' ' + body;
                    const from = parsed.from?.text || '';

                    const acName = findAC(combined);
                    let noteText = cleanNoteText(body || subject);

                    if (!noteText || noteText.length < 3) return res();

                    await supabase.from('email_followups').insert({
                      ac_name: acName || 'General',
                      rc_name: acName ? (RC_BY_AC[acName] || null) : null,
                      note_text: noteText,
                      sender_email: from,
                      subject: subject,
                      received_at: parsed.date?.toISOString() || new Date().toISOString(),
                      done: false,
                    });

                    processed++;
                    console.log(`Saved follow-up → ${acName || 'General'}: ${noteText.substring(0, 60)}`);
                  } catch (e) {
                    console.error('Error saving email:', e.message);
                  }
                  res();
                });
              });
            });
            promises.push(p);
          });

          fetch.once('end', async () => {
            await Promise.all(promises);
            console.log(`Poll complete. Saved ${processed} new follow-up(s).`);
            imap.end();
            resolve();
          });

          fetch.once('error', (err) => { imap.end(); reject(err); });
        });
      });
    });

    imap.once('error', (err) => {
      console.error('IMAP connection error:', err.message);
      reject(err);
    });

    imap.connect();
  });
}

module.exports = { pollInbox };
