# Twilio texting registration — Ayvaz RC Tracker

**Current setup (2026-09-16): toll-free number (877) 708-9555, Toll-Free Verification in progress.**
Everything lives in the one existing Twilio account ("My first Twilio account"). TalentDesk is untouched.

| What | Value |
|---|---|
| Sending number | +1 877-708-9555 (toll-free), PN de35746ef5283ffe4378e416d1c43cae, $2.15/month |
| Inbound webhook | https://rc-tracker-hos2.onrender.com/api/sms (HTTP POST) |
| Verification | Toll-Free Verification, submitted 2026-09-16, **in progress** |
| Business | Ayvaz Pizza, LLC — Private Profit — EIN (entered by Harold) — DBA Ayvaz Pizza — https://ayvazpizza.com |
| Address / contact | Pulled from Harold's customer profile (Dacula, GA home address; not editable on the form) |
| Use case | Account Notifications, Customer Care; ~1,000 msgs/month; opt-in type Web Form |
| Proof of consent | https://rc-tracker-hos2.onrender.com/sms-opt-in (optional, unchecked box + skip link) |
| Policies | https://rc-tracker-hos2.onrender.com/privacy · https://rc-tracker-hos2.onrender.com/terms |
| Opt-in keywords | START, UNSTOP, SUBSCRIBE |
| Status notifications | hlacoste@ayvazpizza.com |

## When verification is approved
- Render → rc-tracker → Environment: add `TWILIO_REMINDER_FROM=+18777089555`.
  The existing `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` are the same account; nothing else changes.
- Send a test reminder, then share https://rc-tracker-hos2.onrender.com/sms-opt-in with coaches
  (or have them text START to (877) 708-9555).

## If verification is rejected
Toll-free rejections that are marked re-submittable can be corrected and resubmitted for free within 7 days
(Phone Numbers → (877) 708-9555 → Regulatory Information). The most likely flag is the address: it comes from
Harold's profile, not Ayvaz's registered address (4415 Highway 6, Sugar Land, TX 77478).

## Never change (TalentDesk)
- Local number 470-771-7670, Messaging Service MG5fc0fb9172f06c0f7ca83163075c1c55
- Sole Proprietor brand BN785bd37b5f7954bec5962b1b7a09b898 and campaign CM466baa64ad1b9efa349e8bb561f96fa2
- Toll-free number 844-950-3679 and its verification
- Primary customer profile BU7beb5232232304cc11527f5db1757562 — do **not** click "Switch to business profile"

## History: why not the local 229 number (A2P 10DLC)
1. 2026-09-15: registered a second Sole Proprietor brand (BN8782ae8dbc0aff804b23bdb6ef82b904, on Starter
   profile BU4c84fac590d8137ff6d9ff7980206253), Messaging Service "Ayvaz RC Tracker"
   (MG72bb31225069e9095a8a99660d2d4288) with +1 229-609-6809, and campaign CMbf2bb600f3a1c7460a15c6da24784b15.
2. 2026-09-16: campaign **rejected** with two errors:
   - **30923 Forced consent** — the sign-up form could not be submitted without the SMS checkbox.
     Fixed: the box is optional, an unchecked submission is saved as a decline, and the page has a skip link.
   - **30915 Not a sole proprietor** — an LLC with an EIN must register as Standard / Low-Volume Standard.
     In this account that needs the primary profile switched to Business, which TalentDesk depends on, and a
     second Twilio account was ruled out. Toll-Free Verification accepts the LLC and EIN inline instead.
3. The rejected campaign was deleted on 2026-09-16. The Sole Proprietor brand, the "Ayvaz RC Tracker"
   Messaging Service, and 229-609-6809 remain in the account.
4. 2026-09-21: 229-609-6809 was **removed from the "Ayvaz RC Tracker" Messaging Service sender pool**.
   It had stayed in the pool next to the 877, and scheduled Message Center texts (which must go through
   the service) were sometimes sent from it. Unregistered for 10DLC, those were blocked by carriers —
   e.g. Jadon's 9/20 text, SM27cd6dcbe3998ba6df2db3e477efedad, error 30034. The pool now holds only
   +1 877-708-9555. **Don't add a local number back to this service** unless it has an approved campaign.
   The number itself is still owned by the account; release it if it's never going to be used.
