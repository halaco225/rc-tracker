const e = require('../inbound-email');

const PEOPLE = {
  'Matt Hester': { role: 'VP', rc: 'Matt Hester', tz: 'America/New_York' },
  'Harold Lacoste': { role: 'RC', rc: 'Harold Lacoste', tz: 'America/New_York' },
  'Jadon McNeil': { role: 'AC', rc: 'Harold Lacoste', tz: 'America/New_York' },
  'Jason McNeal': { role: 'AC', rc: 'Jerry Warren', tz: 'America/New_York' },
};

describe('who a forwarded email belongs to', () => {
  it('reads the address it was sent to', () => {
    expect(e.personForAddress('matt@in.example.com', PEOPLE)).toBe('Matt Hester');
    expect(e.personForAddress('Matt Hester <matt.hester@in.example.com>', PEOPLE)).toBe('Matt Hester');
    expect(e.personForAddress('mhester@in.example.com', PEOPLE)).toBe('Matt Hester');
    expect(e.personForAddress('harold+urgent@in.example.com', PEOPLE)).toBe('Harold Lacoste');
  });

  it('refuses to guess when a first name is ambiguous or unknown', () => {
    expect(e.personForAddress('tracker@in.example.com', PEOPLE)).toBeNull();
    expect(e.personForAddress('ja@in.example.com', PEOPLE)).toBeNull();
    expect(e.personForAddress('', PEOPLE)).toBeNull();
  });
});

describe('unwrapping a forward', () => {
  const gmail = `Can you look at this one?

---------- Forwarded message ---------
From: Alona Ramirez <alona@vendor.com>
Date: Mon, Oct 20, 2026 at 9:14 AM
Subject: Re: Oven repair quote 39526
To: Matt Hester <mhester@ayvazpizza.com>

The part is backordered until the 28th. We can do a temporary fix Thursday.

Thanks,
Alona

--
Alona Ramirez | Service Co
`;

  it('finds the real sender, subject and message', () => {
    const f = e.parseForward(gmail);
    expect(f.from).toBe('alona@vendor.com');
    expect(f.subject).toBe('Re: Oven repair quote 39526');
    expect(f.text).toContain('backordered until the 28th');
    expect(f.text).not.toContain('Alona Ramirez | Service Co');   // signature trimmed
  });

  it('copes with Outlook and Apple wording', () => {
    const outlook = `FYI

-----Original Message-----
From: Hamza Khan <hamza@corp.com>
Sent: Tuesday, October 21, 2026 7:02 AM
Subject: Health score 39454

Score posted at 94.`;
    expect(e.parseForward(outlook).from).toBe('hamza@corp.com');
    expect(e.parseForward(outlook).subject).toBe('Health score 39454');

    const apple = `Begin forwarded message:

From: Payroll <payroll@corp.com>
Subject: Missing punches

Two punches missing for store 526.`;
    expect(e.parseForward(apple).from).toBe('payroll@corp.com');
  });

  it('keeps the whole body when it is not a forward', () => {
    const f = e.parseForward('Just a plain note about the cooler.');
    expect(f.from).toBeNull();
    expect(f.text).toBe('Just a plain note about the cooler.');
  });
});

describe('the inbox row it builds', () => {
  const base = {
    to: 'matt@in.example.com',
    from: 'Matt Hester <mhester@ayvazpizza.com>',
    subject: 'Fwd: Oven repair quote 39526',
    text: `Please chase this.

---------- Forwarded message ---------
From: Alona Ramirez <alona@vendor.com>
Subject: Oven repair quote 39526

Part is backordered.`,
    messageId: 'msg-1',
    people: PEOPLE,
  };

  it('routes to the addressee and credits the original sender', () => {
    const row = e.inboxRowFrom(base);
    expect(row).toMatchObject({
      subject: 'Oven repair quote 39526',          // "Fwd:" stripped
      sender_email: 'alona@vendor.com',            // not the forwarder
      ac_name: 'Matt Hester',
      rc_name: 'Matt Hester',
      done: false,
    });
    expect(row.note_text).toContain('Part is backordered');
  });

  it('falls back to the forwarder when the address is generic', () => {
    const row = e.inboxRowFrom({ ...base, to: 'tracker@in.example.com', from: 'jadon@in.example.com' });
    expect(row.ac_name).toBe('Jadon McNeil');
    expect(row.rc_name).toBe('Harold Lacoste');
  });

  it('reads HTML-only mail and always has an id', () => {
    const row = e.inboxRowFrom({ to: 'harold@in.example.com', from: 'x@y.com', subject: 'Invoice',
      html: '<p>Invoice <b>4821</b> is due</p><style>p{}</style>', people: PEOPLE });
    expect(row.note_text).toContain('Invoice 4821 is due');
    expect(row.gmail_message_id).toMatch(/^email-/);
  });
});
