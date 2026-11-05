# Messaging setup redesign

Design doc — 2026-11-04

## Intent and why

Setting up a reminder in RC Tracker is harder than the thing it's reminding you
about. There are four separate "What should happen?" forms, they offer different
options, they word the same option differently, and two of them mislabel a field.
Harold can't reliably get the outcome he wants, and the people he's building this
for — RCs and ACs in their 40s–60s who don't use software much — have no chance.

A worked example from the week this was written: Harold wanted a follow-up for
Darian about receipts for store 377, nothing sent that day, appearing on Darian's
morning text starting the next day. A text went out immediately instead. That
outcome was not reachable from the dialog he used, at all.

Separately, people are texting the tracker and setting up their own reminders — it
reads them and creates real follow-ups with real schedules. Matt set one up the day
this was written. There is no list of these anywhere. Harold can only find one by
guessing which person to click.

### The design bar

Everything below is subordinate to one constraint Harold stated directly: this has
to be usable by someone who isn't comfortable with software. When simplicity and
capability conflict, simplicity wins. Harold's stated top worry, when asked, was
**too many choices** — people freezing or picking the first thing they see.

## Goals

1. One setup panel, used everywhere a follow-up, reminder or outbound message is
   created or edited — including mass sends. All five of today's forms go away.
2. Three visible answers to "how do they hear about it", with rarer schedules
   behind one link.
3. A genuine **one-time** reminder, which is currently impossible.
4. "Start showing up later" that actually works, as its own field, separate from
   the deadline.
5. A list of what people set up by text, with the schedule editable from that list.
6. Region filters for Harold and Matt, for both reading lists and picking
   recipients.
7. Nothing a non-technical user does by accident should send a text.

## Non-goals

- Changing how inbound texts are parsed. The SMS reading side works; it is only
  invisible. Do not touch `handleInboundSms` beyond what item 4 below requires.
- Changing the morning-list engine, the Monday recap, or RC text schedules
  (`rc_schedules`). Those were settled in earlier work and are not in question.
- Rewording the outbound text bodies people receive.
- A multi-day/multi-time picker for "Once". Harold was offered this and declined
  for now — see "Deferred" below.
- Any new navigation tab.
- Changing `/api/messages/send` or how an untracked text is delivered. The panel
  becomes the only way in; what happens past the API is unchanged.

## Anti-goals

Things that would make this a failure even if it technically shipped:

- **Any new option, toggle or field that isn't one of the ones named here.** The
  problem being solved is excess choice. Adding capability "while we're in there"
  defeats the entire exercise.
- **A fifth form.** If this ships and some corner of the app still has its own
  "What should happen?", nothing has been fixed.
- **A default that sends.** If the panel can send a text to a real person because
  someone pressed Save without reading, it has failed its main job.
- **Silently destroying a schedule on edit.** See bug 3.

## What exists today (verified in code, 2026-11-04)

Four setup forms, none a superset of another:

| Where | Options offered | Has a start date? |
|---|---|---|
| Add Follow-Up modal (`index.html` ~line 950) | daily to-dos · reminder text · just track | No — field says "Starting", writes `due_date` |
| ⏰ Reminder dialog (`index.html` ~line 891) | daily to-dos · reminder text · certain days each week | No — same mislabel |
| Message several (`index.html` ~line 481) | text now + track · track only · just text | Yes |
| Quick reply in a thread (`index.html` ~line 4095) | track only · text now + track · just text | Yes |

Relevant schema (all columns already exist): `follow_ups.start_date`, `due_date`,
`due_time`, `repeat_times` (jsonb array of `HH:MM`), `repeat_days` (jsonb array,
0=Sun), `repeat_last_slot`, `timed_sent_at`, `last_done_at`, `no_text`, `source`.

Engine behaviour that matters:

- `pickDueItems` (reminders.js) — the morning list. Already honours `start_date`
  and `no_text`. Excludes anything with `due_time` or a repeat.
- `timedDueNow` — a `due_date` + `due_time` item texts at that minute **and again
  at the same minute every following day** until done. This is why there is no
  one-time reminder.
- `dueRepeatSlot` — repeats fire by `repeat_times`/`repeat_days` and are held back
  only by backdating `repeat_last_slot`. It ignores `start_date` entirely.
- `scheduledAhead` — suppresses the immediate "new follow-up" text when an item is
  dated in the future. Repeats always count as "ahead".

## The three bugs to fix

These are defects, not preferences. They should be fixed whether or not the rest
of the redesign ships.

1. **"Starting" sets the deadline.** In the Add Follow-Up modal and the ⏰ dialog,
   the field labelled "Starting" writes `due_date`. The real `start_date` column
   works and is honoured by the engine, but those two forms never send it. So
   "don't show this until the 15th" becomes "due the 15th" and appears tomorrow
   morning regardless.

2. **The ⏰ dialog defaults to sending immediately.** It opens with "Reminder text"
   selected; a blank send time posts `remind_now: true`, which texts the person
   that second. The riskiest, least reversible action in the feature is the
   default. This is the most likely cause of the Darian incident.

3. **Editing a weekly item destroys it.** `openReminderModal` infers its mode from
   `due_time`/`due_date` only and ignores `repeat_days`, so a weekly item opens as
   a plain "Reminder text". `remFields()` then returns a complete field set, so
   pressing Save converts Matt's "every Wednesday" into a daily reminder with no
   warning. It also ignores `start_date`, so any start date is lost on every edit.

## The setup panel

One panel. It replaces all four forms above and is also what "Change when" opens
from the new text-setups list.

Four things, top to bottom:

1. **What needs doing?** — free text. (Pre-filled and read-only when editing an
   existing item's schedule.)
2. **Who's it for?** — one person or many, with each one's text-signup state shown
   inline, as the ⏰ dialog already does. Region chips and the "Everyone here" /
   "Only the RCs" buttons appear only when the viewer can see more than one region.
3. **How do they hear about it?** — see below.
4. **Dates** — collapsed. See below.

Then a readback sentence, then Save.

### Question 3: how do they hear about it

Three choices visible, one selected on open:

| Choice | Means | Fields |
|---|---|---|
| **Every morning** *(default)* | In their morning text each day until they reply "done" | none |
| **Once** | One text and that's it | now, or a day + time |
| **Never — don't text them** | On the board only; they hear nothing | none |

Behind a single **"+ Other ways"** link:

| Choice | Means | Fields |
|---|---|---|
| **Certain days each week** | Their morning text on the days picked, repeating weekly; "done" closes out that week | day picker + time |
| **Twice a day** | Two texts a day until done | two times |
| **Just a message — don't track it** | A text and nothing else; nothing on the board | now, or a day + time |

Rules:

- Every option reads as a complete sentence. No option may require comparing it
  with another to understand.
- The default is **Every morning**, which sends nothing today. "Once → right now"
  is the only path to an immediate text and must be chosen deliberately.
- "On the board" is not a choice. Everything lands on the board; that is what the
  tracker does. This was the specific contradiction Harold caught in an earlier
  draft — "his follow-up list only, no texts" is nonsense, because the morning
  list *is* a text.
- The weekly and twice-a-day times are pickable. Today they are hardcoded to
  08:00 in the UI even though the engine takes any time.

### Question 4: dates

Not shown on open. The panel shows one line of prose and a "Change" link:

> Starts right away, no deadline. *Change*

Opened, it is two questions, each with a safe default already selected:

- **When should this start showing up?** — Right away *(default)* / Not yet, start
  it `[date]`. Copy: "They hear nothing before that day."
- **Is there a deadline?** — No deadline *(default)* / Needs doing by `[date]`.
  Copy: "A deadline only decides when it turns red for being late."

Empty date inputs are the thing being avoided here. People who aren't sure fill
blanks in rather than leaving them, which is how deadlines land on things that
never had one.

### The readback and the Save button

- A sentence above Save, in plain words, stating what will happen — including
  "nothing goes out today" when that's the case.
- **The Save button carries the outcome**: "Save — he hears it tomorrow 8am", not
  "Save". A readback above a button is where people stop looking; the button is
  where they're already aiming.
- Under it: "Nothing is sent until you press Save."

## Set up by text

Open the Messages tab with nobody selected and the right-hand pane currently reads
"Pick someone on the left" — the largest empty space in the app. That becomes the
**Set up by text** list.

- Every follow-up with `source = 'sms'`, newest first, scoped as below.
- A "N new" badge for ones Harold hasn't seen yet.
- Each row: who, what, the schedule it's actually on ("🔁 every Wed, 8am"), when
  they set it up, their region when more than one is in view, and — importantly —
  **the text they sent**, so Harold can see whether the tracker read them right.
- Three actions per row: **Change when** (opens the setup panel, pre-filled),
  **Mark done**, **Stop reminding**.
- Picking a person on the left restores their conversation exactly as today. This
  list only fills the space when nobody is picked.

No new tab. No new navigation.

## Region filters

**Decided by Harold:** Harold and Matt both see **Matt's three regions** — Harold
Lacoste, Lori Schwartz, Preston Arnwine. Tracy Krumwiede's five regions are out of
scope and stay as they are. Every other RC continues to see their own region only.

This is the scope `allowedAssignees` already computes for a VP, so the change is
to grant Harold that scope, not to invent one.

**Decided by Harold:** the widened scope covers **seeing and assigning**. Reading
and writing are not split. Harold and Matt can both text and assign follow-ups to
anyone in those three regions, by text as well as in the app, and those people
appear in their recipient lists. `allowedAssignees` is the single gate for all of
it (reminders.js:741 for inbound assignment, `/api/messages` and
`/api/sms-signups` for scope), so one marker widens all of them together and no new
permission concept is needed.

Note for the builder: this means an inbound text from Harold can now assign work to
Lori's and Preston's ACs. That is intended.

**My call, overrulable:** carry it as a "sees all regions" marker on the person in
the roster rather than a name test in code, so the next person who needs it is a
roster edit.

Filter chips appear in two places, and **only when the viewer can see more than
one region** — the other seven RCs see no chips and no new clutter:

- **Reading** — above the Set up by text list, and anywhere else a cross-region
  list appears: `All regions · Harold · Lori · Preston`, each with a count. Rows
  name their region so the list reads correctly on "All".
- **Sending** — in the recipient picker. Clicking a chip narrows the names and
  enables **Everyone here**, so "just Preston's region" is two clicks instead of
  hunting through 62 checkboxes. Also **Only the RCs**, since "things I need all of
  them to do" sometimes means the RCs and not every AC.

## Constraints

- Single-page app: `public/index.html`, one file, vanilla JS, no build step, no
  framework. Match the surrounding style.
- Express API in `server.js`; the engine is `reminders.js`; Supabase/Postgres with
  numbered migrations in `supabase/migrations/`. Tests are plain `node:test` in
  `tests/`.
- The roster is `people.json`, generated from the Master Alignment workbook. 52
  ACs, 8 RCs, 2 VPs.
- Texting is Twilio A2P-registered. Consent, STOP/HELP handling and the opt-in
  flow are compliance surface — do not alter them.
- People already have items set up under today's rules. Any schema change must
  leave existing rows behaving as they do now.
- The same panel is used on phones. Harold's RCs read texts and open this on a
  phone more than on a desktop.

## Known implementation problems the builder must solve

Flagged because each one needs a decision, and the obvious approach is wrong:

1. **"Once" has no mechanism.** `timedDueNow` re-fires daily by design. A one-time
   reminder needs a way to stop after the first send without closing the item
   (it stays open and tracked until someone actually does it). A new boolean
   column read by `timedDueNow` is the smallest honest answer; existing rows
   default to today's repeating behaviour, which preserves them.

2. **`start_date` doesn't hold back a repeat.** `dueRepeatSlot` ignores it. The
   inbound text path fakes a later start by backdating `repeat_last_slot`. Pick
   one mechanism and use it in both places — having the UI and the SMS path hold
   items back differently is how this feature got into its current state.

3. **`scheduledAhead` decides whether the "new follow-up" text goes out.** The new
   defaults change what lands here. "Every morning, starts right away" must not
   fire an immediate announcement text on top of the morning list, or the default
   choice still texts people today.

4. **Five call sites, one panel.** The Add Follow-Up modal, the ⏰ dialog, the
   broadcast compose box, the in-thread quick reply and the Region Matrix quick-add
   all currently build their own request bodies (`remFields`, `fuMode`,
   `msgModeChanged`, `msgQuickChanged`, and an inline `fetch` at `index.html:2570`).
   All five must end up calling the same thing, or anti-goal 2 happens.

5. **Two endpoints behind one panel.** Tracked items go to `/api/follow-ups`;
   untracked texts go to `/api/messages/send`. "Just a message — don't track it" is
   the only choice that takes the second route, and with many recipients the panel
   must not half-succeed — decide what it reports when some recipients fail, as the
   broadcast box already has to.

## Left to the builder

- Whether the panel is a modal or an inline pane, and how it behaves at phone
  width.
- Exact markup, class names and layout, following the existing page's conventions.
- Migration shape and naming.
- How "N new" is tracked (a per-user last-seen timestamp is the obvious route, but
  it is the builder's call).
- Whether the broadcast compose box keeps its attachment and scheduled-send
  features alongside the shared panel, or those move into the panel.
- Test coverage, beyond the required cases below.

## Must be covered by tests

The engine is where mistakes reach real people's phones.

- A "Once" reminder fires exactly once and does not fire the next day.
- An item with a future `start_date` sends nothing before that date — on the
  morning list and on a weekly repeat.
- Editing a weekly item's schedule preserves `repeat_days` and `start_date`.
- "Never — don't text them" sends nothing, on any path, ever.
- The default choice, saved with no other fields touched, sends no text today.

## Deferred

- **Several one-time nudges in one go** (Harold's product-outage case: a few texts
  on different days and times). Today that's three trips through "Once". Harold was
  shown this and chose to leave it rather than add another option. Revisit only if
  he says he's doing it often.

## Settled during the builder review

A reviewer read this as a builder and found seven gaps. Five are settled here; they
are my calls unless marked otherwise.

- **One panel for everything, including mass texts — Harold's call, against my
  lean.** The "Message several" box does not survive as a separate form. This costs
  less than the reviewer feared, because it absorbs into parts the panel already
  has rather than adding choices:
  - **Who's it for** accepts one person or many. One person looks like today's
    single dropdown; the region chips, "Everyone here" and "Only the RCs" appear
    only when the viewer can see more than one region, as elsewhere.
  - **"Just a message — don't track it"** joins *"+ Other ways"* alongside weekly
    and twice-a-day, rather than becoming a fourth visible choice. The three common
    answers stay three. It belongs in that list and nowhere else: it is one more
    complete sentence about how they hear about it, and it sits naturally opposite
    "Never — don't text them, just track it". Those two are the symmetric ends of
    the same question — text-and-don't-track, track-and-don't-text — which is
    exactly why they must not become a second axis.
  - **The broadcast box's "Schedule the text for" field disappears.** It is already
    "Once, on a day and time I pick". One concept, one place.
  - **Attachments move into the panel.** They exist today and are not a new choice.
  - The readback and Save button pluralise: "Save — 5 people hear it tomorrow 8am".
  - When more than one person is picked, the panel still writes one follow-up per
    person, as the broadcast box does today.

- **A fifth form exists.** The Region Matrix quick-add (`index.html:2570`) posts
  with no dates, so `scheduledAhead` is false and `server.js:373` texts the
  assignee on the spot — "a default that sends", outside the four forms listed
  above. It is in scope. It keeps its one-box workflow (type, press Add; no
  dialog), and implementation problem 3 fixes it for free: once the morning-list
  default stops firing an immediate announcement, matrix quick-adds join tomorrow's
  morning follow-ups instead of texting now.

- **"Never — don't text them" clears any schedule, out loud.** `no_text` is read
  only by `pickDueItems` today; `dueRepeatSlot`, `timedDueNow` and `previewDay`
  ignore it. Both: honour `no_text` in all four, *and* have the panel clear
  `repeat_times`/`due_time` when Never is chosen. That is not anti-goal 4, because
  the panel states it before saving — "This stops the every-Wednesday reminder" —
  and the readback and Save button both reflect it. Existing `no_text` rows cannot
  have a repeat from the create path, so honouring the flag everywhere is the
  behaviour its name already promises rather than a change to live rows.

- **"Stop reminding" on a text-setup row** is the same action as choosing Never,
  with the same confirm line. It does not mark the item done — Harold may still
  want it tracked.

- **"Every morning" must read `rc_schedules`.** `self_days`/`team_days` decide
  which mornings the list goes out, so for an RC on Mon/Wed the plain label and the
  Save button would otherwise both lie. The readback names the real next morning:
  "Save — he hears it Monday 8am". Reading that table is not the same as changing
  the engine, so this stays inside the non-goal.

- **"The text they sent" is already in `note_text`** on both inbound paths. On the
  `ask_track` path it looks like our own question, but `trackedQuestionText`
  (reminders.js:1356) extracts the person's original words back out of the curly
  quotes in our question before storing them. Verified. Show `note_text`; no join
  to `sms_messages`, no new column.

Both questions the reviewer left to Harold are now answered: the shared panel
absorbs untracked and multi-recipient sending (above), and the widened region scope
covers seeing and assigning (see "Region filters"). Nothing is left open.

## Decision log

| Decision | Who |
|---|---|
| Three visible answers, rarer schedules behind a link | Harold — top worry was too many choices |
| One question, not two; "on the board" isn't a choice | Harold caught the contradiction |
| Call it "their morning follow-ups" throughout | mine — Harold never answered the wording question directly, but those are the words he used unprompted ("there morning follow ups", "morning follow up message"). Worth confirming with him. |
| Harold and Matt see Matt's three regions, not all ten | Harold |
| Region chips in the recipient picker, not just the list | Harold — "so we only send it to select people" |
| One panel for everything, mass texts included; no separate "Message several" | Harold, against my lean |
| Widened region scope covers seeing *and* assigning; reading and writing not split | Harold |
| Defer the multi-nudge picker | Harold |
| "Sees all regions" as a roster marker meaning "scope as your VP", not a name test | mine |
| "Just a message — don't track it" goes behind "+ Other ways", not a 4th visible choice | mine |
| The broadcast box's "Schedule the text for" field is deleted — it's "Once, on a day and time" | mine |
| Call it "their morning follow-ups" throughout | mine — worth confirming |
| "Never" clears a schedule, but says so before saving | mine |
| "Stop reminding" ≠ mark done | mine |
| The readback reads `rc_schedules` so "every morning" can't lie | mine |
| The Region Matrix quick-add is in scope and keeps its one-box workflow | mine |
| Save button carries the outcome sentence | mine |
| Dates collapsed behind "Change" | mine |
| Default is "Every morning", which sends nothing today | mine |
