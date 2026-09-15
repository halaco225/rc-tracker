# Twilio A2P 10DLC registration — Ayvaz RC Tracker (229-609-6809)

Everything needed to register the RC Tracker texting number in one pass. **TalentDesk must not change:**
leave its Sole Proprietor brand (BN785bd37b…), campaign (CM466baa64…), Messaging Service
(MG5fc0fb91…) and number 470-771-7670 exactly as they are. Never click "Switch to business profile"
on the primary (Individual) customer profile, never reuse or edit MG5fc0fb91…, never delete a campaign.
If any step requires one of those, stop.

Path (Twilio doc "Transition from a Sole Proprietor to a Standard Brand", Console option 1):
new Customer Profile → new Low-Volume Standard Brand → new Campaign → **new** Messaging Service → add 229-609-6809.

## Before starting
- [ ] Twilio console loads normally (no "Pages Not Accessible" incident)
- [ ] Balance funded + auto-recharge on
- [ ] Screenshot TalentDesk's recent Messaging logs (before picture)
- [ ] https://rc-tracker-hos2.onrender.com/sms-opt-in, /privacy, /terms all load

## 1. Business customer profile
| Field | Value |
|---|---|
| Legal business name | Ayvaz Pizza, LLC |
| Business type | Limited Liability Corporation |
| Business registration ID type | USA: Employer Identification Number (EIN) |
| EIN | **Harold types it** (federal EIN, 9 digits — not the Texas tax ID) |
| Business industry | Food & Beverage / Restaurants |
| Regions of operation | USA and Canada |
| Website | https://ayvazpizza.com |
| Social media | (leave blank) |
| Address | 4415 Highway 6, Sugar Land, TX 77478, US (matches ayvazpizza.com) |
| Authorized rep | Harold Lacoste — Regional Coach — hlacoste@ayvazpizza.com — +1 225-810-1361 |
| Company status | Private |

## 2. Brand
- Type: **Low-Volume Standard** (skips secondary vetting; up to ~6,000 segments/day — far above our use)

## 3. Campaign
**Use case:** Low Volume Mixed (sub use cases: Account Notification, Customer Care)

**Campaign description**
> Ayvaz Pizza, LLC sends internal work follow-up reminders to its own regional and area coaches (employees) who opted in through the Ayvaz RC Tracker, an internal work-tracking tool. Messages remind employees of follow-up tasks due tomorrow, due today, or overdue; notify them when a follow-up is assigned to them; and answer texts they send (for example "remind me to call store 39380 Friday" or "1 done"). No marketing or promotional content is sent. Recipients are Ayvaz employees only.

**Message flow / how end users consent**
> Ayvaz Pizza, LLC regional and area coaches opt in on the Ayvaz RC Tracker SMS sign-up page, https://rc-tracker-hos2.onrender.com/sms-opt-in, by entering their name and mobile number and checking an unchecked consent box that reads: "I agree to receive recurring work follow-up reminder texts from Ayvaz RC Tracker at the mobile number above. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Consent is not a condition of employment." The page links to the Privacy Policy (https://rc-tracker-hos2.onrender.com/privacy) and Terms (https://rc-tracker-hos2.onrender.com/terms). Employees can also opt in by texting START to (229) 609-6809. After opting in they receive a confirmation text. Opt-in records (time, source, wording) are stored. Reminders are only sent to opted-in employees.

**Privacy policy URL:** https://rc-tracker-hos2.onrender.com/privacy
**Terms URL:** https://rc-tracker-hos2.onrender.com/terms

**Sample message 1**
> Ayvaz RC Tracker
> Your follow-up reminders:
> 1) Send weekend schedule — due today
> 2) Call store 39380 about cooler — due tomorrow
>
> Reply "1 done", "1 Fri", "list", or STOP to opt out

**Sample message 2**
> Ayvaz RC Tracker
> New follow-up from Harold Lacoste:
> 1) Review labor report for Area 2011 — due Fri 9/18
>
> Reply "done", "Fri", "list", or STOP to opt out

**Sample message 3**
> Ayvaz RC Tracker
> Got it!
> ✅ Done: Send weekend schedule

**Sample message 4**
> Ayvaz RC Tracker
> ✅ Added to your follow-ups:
> 1) Call store 39380 about cooler — due Fri 9/18
>
> Reply "done", "Fri", "list", or STOP to opt out

**Sample message 5**
> Ayvaz RC Tracker: You're signed up for work follow-up reminder texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.

**Message contents:** Embedded links — No. Embedded phone numbers — No. Age-gated — No. Direct lending — No.

**Opt-in keywords:** START, UNSTOP, SUBSCRIBE
**Opt-in message:** Ayvaz RC Tracker: You're signed up for work follow-up reminder texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.

**Opt-out keywords:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE
**Opt-out message:** Ayvaz RC Tracker: You're unsubscribed and will receive no more messages. Reply START to resubscribe.

**Help keywords:** HELP, INFO
**Help message:** Ayvaz RC Tracker: Work follow-up reminders for Ayvaz Pizza coaches. Help: hlacoste@ayvazpizza.com. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.

## 4. Messaging Service (new)
- Friendly name: **Ayvaz RC Tracker**
- Use case: Notify my users
- Sender pool: **+1 229-609-6809 only**
- Integration → incoming messages: Send a webhook → `https://rc-tracker-hos2.onrender.com/api/sms` (HTTP POST)
- Advanced Opt-Out: on, with the opt-in / opt-out / help messages above

## 5. After campaign is Verified
- Render → rc-tracker → Environment: `TWILIO_REMINDER_FROM=+12296096809`
- Share https://rc-tracker-hos2.onrender.com/sms-opt-in with coaches (or have them text START)
- Re-check TalentDesk Messaging logs (after picture)
