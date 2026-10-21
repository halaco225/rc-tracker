# Forwarded email → tracker inbox

Replaces the Gmail poller, which needed an OAuth refresh token that kept expiring
(dead since June 2026). Nothing here expires.

**How it flows:** someone forwards an email to `<name>@in.ayvazops.com` → SendGrid
receives it → SendGrid POSTs it to the tracker → it appears in that person's inbox
with a **+ follow-up** button, exactly like a text does.

The code is live already (`inbound-email.js`, route in `server.js`). The route is
`POST /api/email-in/<secret>` and **404s until `EMAIL_WEBHOOK_SECRET` is set**, so
nothing is exposed before setup.

## Who it routes to

1. The address it was sent to, if that's a person: `matt@`, `matt.hester@`, `mhester@`
   all reach Matt Hester.
2. Otherwise whoever forwarded it: Darian forwards to `tracker@…` → Darian's inbox.
3. Neither matched → lands unassigned rather than guessing.

If someone forwards from an address the name rules don't catch, add it explicitly on
Render: `EMAIL_SENDERS={"mhester@ayvazpizza.com":"Matt Hester"}`

## What's configured (done 21 Oct 2026)

All of it is live. Recorded here so it can be rebuilt or copied to another app.

**SendGrid** — domain authentication for `ayvazops.com` (id 33600002, validated), and an
Inbound Parse host `in.ayvazops.com` pointing at the webhook. Parse **requires** an
authenticated sender domain first; it refuses the host otherwise. That tripped us up once.

**Porkbun DNS on ayvazops.com** — four records:

| Type | Host | Answer | Priority |
|------|------|--------|----------|
| CNAME | `em` | `u117080540.wl041.sendgrid.net` | |
| CNAME | `s1._domainkey` | `s1.domainkey.u117080540.wl041.sendgrid.net` | |
| CNAME | `s2._domainkey` | `s2.domainkey.u117080540.wl041.sendgrid.net` | |
| MX | `in` | `mx.sendgrid.net` | 10 |

There is also a wildcard `*` CNAME to Porkbun parking. It does not interfere: an explicit
record at a name beats the wildcard for that name.

**Render** — `EMAIL_WEBHOOK_SECRET` is set. Without it the route 404s.

## Testing it

Forward any email to `harold@in.ayvazops.com`, then open the tracker. It should show
in the inbox within a few seconds, titled with the **original** subject ("Fwd:"
stripped) and credited to the **original** sender, not to you.

If nothing arrives:
- Render logs show `Email in: "<subject>" → <person>` on success.
- SendGrid → Inbound Parse shows delivery attempts and the response code.
- A 404 from the webhook means the secret doesn't match.

## Later: other apps, and sending

The same inbox can serve every app — the address decides. `pai@in.ayvazops.com` and
`training@in.ayvazops.com` just need their own route in their own app, pointed at the
same Parse host (SendGrid posts every address at `in.ayvazops.com` to one URL, and the
`to` field says which was used).

For **outbound** (training emails a certificate reminder, PAI emails a recap), the
domain is already authenticated, so nothing more is needed in DNS: send through
SendGrid as `training@ayvazops.com` with a display name like "Ayvaz Training". Replies come back to `in.ayvazops.com` and land in the
inbox, closing the loop. Sending as `@ayvazpizza.com` is not possible without records
on Ayvaz's own DNS.

## Retiring the old poller

Once this is proven, `/api/poll`, `gmail-poller.js` and the three
`*_GMAIL_REFRESH_TOKEN` env vars can go. The cron job for it is already disabled.
