# Messaging Setup Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace five disagreeing "What should happen?" forms with one setup panel, give the engine a genuine one-time reminder and a working start date, and surface what people set up by texting back.

**Architecture:** Engine first, UI second. Tasks 1–6 are server/engine changes, each independently testable against `tests/reminders.test.js` and shippable on their own — Task 1 alone fixes the live bug that texts people the moment you press Save. Tasks 7–11 build the single panel in `public/index.html` and delete the five forms it replaces. No new tab, no new dependency, no build step.

**Tech Stack:** Node/Express (`server.js`), plain-JS engine (`reminders.js`), Supabase/Postgres with numbered migrations, single-page vanilla-JS front end (`public/index.html`), Jest (`npm test`).

**Spec:** [docs/superpowers/specs/2026-11-04-messaging-setup-redesign-design.md](../specs/2026-11-04-messaging-setup-redesign-design.md)

## Global Constraints

- `public/index.html` is one file, vanilla JS, no framework, no build step. Match surrounding style.
- Every schema change must leave existing rows behaving exactly as they do now.
- Consent, STOP/HELP handling and the opt-in flow are A2P compliance surface — do not alter them.
- Days are `0=Sunday..6=Saturday` everywhere, matching `follow_ups.repeat_days` and `rc_schedules`.
- Times are `'HH:MM'` 24h strings, local to the **assignee's** timezone, never the sender's.
- The morning message is called **"their morning follow-ups"** in all user-facing copy.
- No new option, toggle or field beyond those named in this plan. Excess choice is the problem being solved.
- Migrations are `supabase/migrations/NNN_name.sql`, next free number is `013`.
- Run tests with `npx jest tests/reminders.test.js -t "<test name>"`.

## Review Focus

Input classes the spec implies but no task's happy path exercises. Each has its test pinned to the task that owns the code.

1. **An assignee in a different timezone.** 52 ACs span Eastern, Central and Mountain. "8am" and "today" must resolve on *their* clock, not Harold's. → Task 2.
2. **A recipient who never signed up or texted STOP.** The panel can pick them; nothing may be sent, and the item must still be tracked. → Task 5.
3. **A mass send where some recipients fail.** The panel must not report success for a partial send. → Task 11.
4. **An assignee outside the sender's scope.** Widening Harold's scope must not let anyone assign outside their own. → Task 6.
5. **A repeat crossing a DST boundary.** `currentSlot`/`repeat_last_slot` compare local `'YYYY-MM-DD HH:MM'` strings; a duplicate or skipped slot means a person gets two texts or none. → Task 3.

---

### Task 1: The clock dialog stops texting on open-and-save

Smallest fix for the live bug, shipped before any redesign. `remFields()` returns `{ remind_now: true }` whenever "Reminder text" is selected with a blank send time — and that radio is checked on open.

**Files:**
- Modify: `public/index.html:891-905` (the `remMode` radios), `public/index.html:1745` (mode inference in `openReminderModal`)

**Interfaces:**
- Produces: nothing. Self-contained.

- [ ] **Step 1: Change the default checked radio from `reminder` to `daily`**

In the `name="remMode"` group, move the `checked` attribute to the `value="daily"` input.

- [ ] **Step 2: Fix the mode inference for a new item**

`openReminderModal` computes `const mode = fu && !time && fu.due_date ? 'daily' : 'reminder'`, which lands on `reminder` whenever `fu` is null. A new item with no existing schedule must open on `daily`.

- [ ] **Step 3: Verify by hand**

Open the ⏰ from a Messages thread and from a matrix card. Expected: "Add to their daily to-dos" is selected, the plan line reads "in their 8am text every morning", and Save sends no text today.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "The clock dialog no longer texts someone the moment it opens"
```

---

### Task 2: A one-time reminder fires once

`timedDueNow` re-fires every day at the same minute until "done", so there is no one-off. Existing rows must keep repeating.

**Files:**
- Create: `supabase/migrations/013_one_time.sql`
- Modify: `reminders.js:333-346` (`timedDueNow`), `server.js:340` (POST body), `server.js:427` (PATCH body)
- Test: `tests/reminders.test.js`

**Interfaces:**
- Produces: `follow_ups.one_time boolean not null default false`. `timedDueNow(fu, now)` unchanged in signature.

- [ ] **Step 1: Write the failing tests**

```js
describe('one-time reminders', () => {
  test('fires at its minute on its day', () => { /* timedDueNow -> true */ });
  test('does not fire again the next day once sent', () => {
    // fu: { due_date: '2026-09-15', due_time: '09:00', one_time: true,
    //       timed_sent_at: '2026-09-15T13:00:00Z' }, now = TUE_930_ET + 1 day
    expect(r.timedDueNow(fu, WED_930_ET)).toBe(false);
  });
  test('an existing row without one_time still fires the next day', () => {
    // same fu with one_time absent -> true, proving live rows are untouched
  });
  test('fires on the assignee’s clock, not the sender’s', () => {
    // a Central-time AC at due_time '09:00' is not due at 9:30am Eastern
  });
});
```

The fourth test is Review Focus item 1.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest tests/reminders.test.js -t "one-time reminders"`
Expected: FAIL — the next-day case returns `true`.

- [ ] **Step 3: Write the migration**

`013_one_time.sql`: add `one_time boolean not null default false` to `follow_ups`, with a comment saying why (a timed reminder repeats daily by default, and that stays true for every row that existed before this).

- [ ] **Step 4: Make `timedDueNow` honour it**

Return `false` when `fu.one_time` and `fu.timed_sent_at` is set. Leave every other branch alone.

- [ ] **Step 5: Accept `one_time` on both routes**

POST `/api/follow-ups`: read `one_time = false` from the body, insert `one_time: !!one_time`. PATCH `/api/follow-ups/:id`: `if (one_time !== undefined) updates.one_time = !!one_time`.

- [ ] **Step 6: Run the tests**

Run: `npx jest tests/reminders.test.js -t "one-time reminders"`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/013_one_time.sql reminders.js server.js tests/reminders.test.js
git commit -m "A reminder can go out once instead of every day until done"
```

---

### Task 3: A start date holds back a repeat

`dueRepeatSlot` ignores `start_date` entirely. The inbound text path fakes a later start by backdating `repeat_last_slot` (`reminders.js:1196`). One mechanism, used by both.

**Files:**
- Modify: `reminders.js:234-245` (`dueRepeatSlot`), `reminders.js:1190-1200` (the inbound repeat branch)
- Test: `tests/reminders.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `dueRepeatSlot` returns `null` before `start_date`. The `repeat_last_slot` backdating trick is gone.

- [ ] **Step 1: Write the failing tests**

```js
describe('start_date on a repeat', () => {
  test('sends nothing before the start date', () => {
    // repeat_times ['08:00'], start_date two days out -> dueRepeatSlot === null
  });
  test('sends on the start date itself', () => { /* -> a slot string */ });
  test('a weekly repeat starting later waits for its first matching day', () => {
    // repeat_days [3] (Wed), start_date next Monday -> null Monday, slot Wednesday
  });
  test('an inbound "every wednesday starting the 16th" sets start_date, not a backdated slot', () => {
    // handleInboundSms -> created item has start_date '2026-09-16' and
    // repeat_last_slot === null
  });
  test('a slot already sent is not re-sent across a DST change', () => {
    // repeat_last_slot from the day before the US fall-back, 08:00 daily
  });
});
```

The fifth test is Review Focus item 5.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest tests/reminders.test.js -t "start_date on a repeat"`
Expected: FAIL — the first case returns a slot.

- [ ] **Step 3: Make `dueRepeatSlot` respect `start_date`**

Return `null` when `fu.start_date` is later than the assignee's local date. Place it beside the existing `repeat_days` check, before `currentSlot`.

- [ ] **Step 4: Make the inbound path set `start_date`**

In the repeat branch of `handleInboundSms`, write `start_date: startDay` and stop computing the backdated `repeat_last_slot`. Keep `due_date` behaviour as it is — the spec's non-goals forbid changing how texts are parsed, and this only changes which column records the start.

- [ ] **Step 5: Run the tests**

Run: `npx jest tests/reminders.test.js -t "start_date on a repeat"`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add reminders.js tests/reminders.test.js
git commit -m "A repeat can start later without a backdated slot to hold it"
```

---

### Task 4: "Never — don't text them" silences every path

`no_text` is read only by `pickDueItems`. `dueRepeatSlot`, `timedDueNow` and `previewDay` ignore it, so the spec's "sends nothing on any path, ever" is false today.

**Files:**
- Modify: `reminders.js` — `dueRepeatSlot` (234), `timedDueNow` (333), `previewDay` (347), `notifyAssignment` (865)
- Test: `tests/reminders.test.js`

**Interfaces:**
- Consumes: Task 2's `one_time`, Task 3's `start_date` guard — same two functions are touched; do Tasks 2 and 3 first to avoid conflicting edits.

- [ ] **Step 1: Write the failing tests**

```js
describe('no_text silences everything', () => {
  test('a no_text item on a daily repeat sends no slot', () => { /* dueRepeatSlot -> null */ });
  test('a no_text item with a due time is never timed-due', () => { /* timedDueNow -> false */ });
  test('previewDay shows no text for a no_text item', () => { /* [] */ });
  test('notifyAssignment sends nothing for a no_text item', () => { /* no message claimed */ });
  test('runHourly sends a no_text item on no path at all', () => {
    // one person, one no_text item with repeat_times and due_time both set
    // -> store.messages stays empty
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest tests/reminders.test.js -t "no_text silences everything"`
Expected: FAIL on the repeat, timed and preview cases.

- [ ] **Step 3: Guard all four functions on `fu.no_text`**

An early return in each. This is what the flag's name already promises; no row created through POST can have both `no_text` and a repeat, so no live row changes behaviour.

- [ ] **Step 4: Run the tests**

Run: `npx jest tests/reminders.test.js -t "no_text silences everything"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add reminders.js tests/reminders.test.js
git commit -m "An item marked no-text really sends nothing, on any path"
```

---

### Task 5: The default choice fires no announcement text

`scheduledAhead` is false for "every morning, starts right away", so `server.js:373` texts the assignee on the spot. That makes the panel's safe default send a text — anti-goal 7, and it is also what makes the Region Matrix quick-add text people.

**Files:**
- Modify: `reminders.js:220-228` (`scheduledAhead`), `server.js:373`
- Test: `tests/reminders.test.js`

**Interfaces:**
- Produces: `scheduledAhead(fu, now)` returns `true` for a plain morning-list item, so `textAssignee` skips it.

- [ ] **Step 1: Write the failing tests**

```js
describe('the morning-list default sends nothing today', () => {
  test('a plain item with no time and no repeat counts as scheduled ahead', () => {
    // { assigned_to, due_date: null, due_time: null, repeat_times: null }
    expect(r.scheduledAhead(fu, TUE_930_ET)).toBe(true);
  });
  test('it still reaches them in the morning list', () => { /* pickDueItems includes it */ });
  test('"once, right now" is not scheduled ahead', () => { /* due_time today -> false */ });
  test('a matrix quick-add shape sends no assignment text', () => {
    // the exact body index.html:2570 posts: text + assigned_to + source only
  });
  test('an unsigned-up assignee gets no text but the item is still tracked', () => {
    // Review Focus 2
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest tests/reminders.test.js -t "the morning-list default"`
Expected: FAIL on the first and fourth.

- [ ] **Step 3: Make a plain morning-list item count as ahead**

An item with no `due_time` and no repeat is reached by the morning list, so announcing it separately is a second text for the same thing. Return `true` for that shape.

- [ ] **Step 4: Run the tests**

Run: `npx jest tests/reminders.test.js -t "the morning-list default"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add reminders.js server.js tests/reminders.test.js
git commit -m "Handing someone a follow-up waits for their morning list"
```

---

### Task 6: Harold sees and assigns in Matt's three regions

`allowedAssignees` (reminders.js:66) gives a VP the people whose `vp` is them. Harold is an RC under Matt and needs that same scope, as a roster marker rather than a name test.

**Files:**
- Modify: `people.json` (Harold Lacoste's entry), `reminders.js:66-74`
- Test: `tests/reminders.test.js`

**Interfaces:**
- Produces: a person may carry `"sees_vp_scope": true`, meaning "scope as your own VP". `allowedAssignees(sender)` returns the same list it would for that VP.

- [ ] **Step 1: Write the failing tests**

```js
describe('sees_vp_scope', () => {
  test('Harold reaches all three of Matt’s regions', () => {
    // allowedAssignees('Harold Lacoste') includes a Lori AC and a Preston AC
  });
  test('and reaches nobody of Tracy’s', () => { /* Review Focus 4 */ });
  test('an RC without the marker still reaches only their own region', () => {
    // allowedAssignees('Lori Schwartz') excludes Harold’s ACs
  });
  test('Matt’s own scope is unchanged', () => {});
  test('the marker widens inbound text assignment too', () => {
    // reminders.js:741 uses the same list; an inbound request from Harold
    // naming a Preston AC is allowed
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest tests/reminders.test.js -t "sees_vp_scope"`
Expected: FAIL — Harold reaches only his own region.

- [ ] **Step 3: Add the marker to the roster**

Set `"sees_vp_scope": true` on Harold Lacoste in `people.json`. Note in `scripts/import_alignment.py` that the field is hand-added and must survive a regeneration from the Master Alignment workbook — the roster is generated, so an unprotected field is lost on the next import.

- [ ] **Step 4: Honour it in `allowedAssignees`**

When `me.sees_vp_scope && me.vp`, return the list computed for `me.vp`. Keep the VP and RC branches as they are.

- [ ] **Step 5: Run the tests**

Run: `npx jest tests/reminders.test.js -t "sees_vp_scope"`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `tests/messages-scope.test.js` covers the same function — fix any fallout here, not later.

- [ ] **Step 7: Commit**

```bash
git add people.json reminders.js scripts/import_alignment.py tests/reminders.test.js
git commit -m "One roster marker lets an RC work across their VP's regions"
```

---

### Task 7: The setup panel — markup and state

One panel, used by every call site. Built and reachable, but nothing wired to it yet; Task 10 deletes the old forms.

**Files:**
- Create: `public/setup-fields.js` (pure choice table and field mapping, so tests can reach it — see the gap note at Step 4)
- Create: `tests/setup-fields.test.js`
- Modify: `public/index.html` — new modal markup beside the existing `reminderModal` (~line 875), new functions beside `openReminderModal` (~line 1727), and a `<script src="/setup-fields.js">` tag

**Interfaces:**
- Produces:
  - `openSetup(ctx)` where `ctx` is `{ fuId?, person?, people?, text?, source?, onSaved? }`. With `fuId` it edits that item's schedule; with `people` it starts multi-recipient.
  - `setupFields()` → `{ no_text?, one_time?, due_date?, due_time?, start_date?, repeat_times?, repeat_days?, remind_now?, track: boolean }`
  - `SETUP_WAYS` — the choice table, so Task 8's readback and Task 9's rows share one source of names.

- [ ] **Step 1: Write the markup**

Four numbered blocks (what · who · how they hear · dates), then a readback line, then Save. Follow the existing modal conventions: `.modal-overlay` / `.modal` / `.modal-header` / `.modal-body`, inline styles, `var(--border)` and friends.

Question 3 is three visible choices, `Every morning` checked:

| Value | Label | Sub-copy | Fields |
|---|---|---|---|
| `morning` | Every morning | In their morning follow-ups each day until they reply "done" | — |
| `once` | Once | One text and that's it | now, or a day + time |
| `never` | Never — don't text them | On your board only | — |

Behind a single `+ Other ways` disclosure, collapsed on open:

| Value | Label | Fields |
|---|---|---|
| `weekly` | Certain days each week | day picker (reuse `remDaysRender`'s button strip) + a time |
| `twice` | Twice a day | two times |
| `message` | Just a message — don't track it | now, or a day + time |

Question 4 is a prose line plus a `Change` link: `Starts right away, no deadline.` Opened, two radio pairs with the safe option checked — `Right away` / `Not yet, start it [date]`, and `No deadline` / `Needs doing by [date]`. No bare date input is visible until its radio is picked.

- [ ] **Step 2: Map each choice to fields in `setupFields()`**

| Choice | Fields posted |
|---|---|
| `morning` | `{ track: true, start_date, due_date }` |
| `once` | `{ track: true, one_time: true, ...(sendAt ? { due_date, due_time } : { remind_now: true }) }` |
| `never` | `{ track: true, no_text: true, repeat_times: [], due_time: null, one_time: false }` |
| `weekly` | `{ track: true, repeat_times: [time], repeat_days: [...], start_date, due_date }` |
| `twice` | `{ track: true, repeat_times: [t1, t2], start_date, due_date }` |
| `message` | `{ track: false }` — goes to `/api/messages/send`, not `/api/follow-ups` |

`never` clears the schedule, so when editing an item that has one, show the line "This stops the <existing schedule> reminder" above Save before it is pressed.

- [ ] **Step 3: Pre-fill correctly when editing**

Infer the choice from the row in this order: `no_text` → `never`; `repeat_days` non-empty → `weekly`; two `repeat_times` → `twice`; one `repeat_times` → `weekly` with no days, i.e. `morning` with a time; `due_time` + `one_time` → `once`; otherwise `morning`. Read `start_date` into question 4. Getting this order wrong is the bug in the spec's item 3 — a weekly item must not open as anything else.

- [ ] **Step 4: Verify by hand**

Open the panel from the browser console on a weekly item, a `no_text` item and a new item. Expected: the right choice pre-selected each time, `start_date` shown, and Save with nothing touched posts the same schedule the item already had.

**Known gap, flagged rather than hidden:** the spec requires a test proving that editing a weekly item preserves `repeat_days` and `start_date`, and there is no front-end test harness — `public/index.html` is a single file with no module boundary, so Jest cannot reach these two functions. The cheapest honest fix is to move `SETUP_WAYS`, `setupFields()` and the pre-fill inference into a small `public/setup-fields.js` that the page includes with a `<script>` tag and `tests/` can `require`, keeping them pure (row in, field set out; no DOM). That is the one new file this plan adds, and it exists only so the lossiest bug in the spec can be pinned by a test. Do it, and put the spec's required test on those pure functions here.

- [ ] **Step 5: Write the required tests against the pure functions**

```js
describe('setupFields', () => {
  test('editing a weekly item keeps its days and start date', () => {
    // inferWay({ repeat_times:['08:00'], repeat_days:[3], start_date:'2026-09-16' })
    //   === 'weekly', and fieldsFor('weekly', state) round-trips both
  });
  test('a no_text item opens as "never"', () => {});
  test('a one_time item opens as "once"', () => {});
  test('"never" clears repeat_times and due_time', () => {});
  test('"morning" posts no due_time and no repeat', () => {});
});
```

Run: `npx jest tests/setup-fields.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/setup-fields.js tests/setup-fields.test.js
git commit -m "One panel asks how someone hears about a follow-up"
```

---

### Task 8: The readback and the outcome-carrying Save button

**Files:**
- Modify: `public/index.html` (the panel from Task 7)

**Interfaces:**
- Consumes: `setupFields()`, `SETUP_WAYS` from Task 7; `/api/rc-schedule/:rc` (server.js:237) for which mornings the list actually goes out.
- Produces: `setupReadback()` → `{ sentence, buttonLabel }`.

- [ ] **Step 1: Build the sentence**

Plain words, and it must say "nothing goes out today" whenever that is true. For `morning` it names the real next morning by reading the assignee's RC schedule — `self_days` when the person is their own RC, `team_days` otherwise, no row meaning every morning. Never claim "tomorrow 8am" for an RC whose team only gets Mon/Wed.

- [ ] **Step 2: Put the outcome on the button**

`Save — he hears it tomorrow 8am`, pluralising to `Save — 5 people hear it Thu 7am`. Under it, fixed copy: `Nothing is sent until you press Save.`

- [ ] **Step 3: Verify by hand**

Set a team schedule of Mon/Wed only, pick `Every morning` on a Thursday, and check the button says Monday rather than tomorrow.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "The Save button says what it is about to do"
```

---

### Task 9: Set up by text

The right-hand pane of the Messages tab currently reads "Pick someone on the left".

**Files:**
- Modify: `public/index.html:4012-4016` (`renderMsgDetail`'s empty branch), plus a new `renderTextSetups()`
- Modify: `server.js:208-236` (`/api/data/:userId`) for the last-seen timestamp

**Interfaces:**
- Consumes: `openSetup({ fuId })` from Task 7; `msgFollowUps`, already loaded by `loadMessageCenter`.
- Produces: `renderTextSetups()`, rendering into `#msgDetail` when `msgOpenThread` is unset.

- [ ] **Step 1: Render the list**

Every `msgFollowUps` row with `source === 'sms'`, newest first. Per row: assignee, item text, a schedule pill built from the same `SETUP_WAYS` names the panel uses, when it was created, the region when more than one is in view, and `note_text` as "💬 they texted". `note_text` already holds the person's own words on both inbound paths — `trackedQuestionText` (reminders.js:1356) extracts them back out of our question — so no join and no new column.

- [ ] **Step 2: Add the three row actions**

`Change when` → `openSetup({ fuId, onSaved: () => loadMessageCenter(true) })`. `Mark done` → the existing `msgMarkDone`. `Stop reminding` → a PATCH of the same fields `never` posts, behind a confirm naming the schedule it ends. It does not mark the item done.

- [ ] **Step 3: Add the "N new" badge**

Store `textSetupsSeenAt` in the per-user blob `/api/data/:userId` already persists. Count rows created after it; clear on render.

- [ ] **Step 4: Verify by hand**

With no thread selected, the pane lists the SMS-created items. Selecting a person restores their conversation unchanged.

- [ ] **Step 5: Commit**

```bash
git add public/index.html server.js
git commit -m "Messages shows what people set up by texting back"
```

---

### Task 10: Every call site opens the panel

The point of the exercise. If any of the five keeps its own form, the redesign has failed.

**Files:**
- Modify: `public/index.html` — delete `reminderModal` markup (875-927), `addFollowUpModal`'s mode block (947-985), the broadcast `msgMode` block (480-515), the quick-reply mode controls (4095-4120), and the matrix inline `fetch` (2570)
- Delete: `remFields`, `remModeChanged`, `remMode`, `fuModeChanged`, `fuMode`, `msgModeChanged`, `msgQuickChanged`, `msgDaysToggle`, `msgSendAtPicked`, `msgQuickSendAtPicked` and their markup

**Interfaces:**
- Consumes: `openSetup(ctx)` from Task 7.

- [ ] **Step 1: Repoint every caller**

`openReminderModal` becomes an alias for `openSetup` so the ~8 existing call sites keep working; the matrix quick-add keeps its type-and-Add behaviour and posts the `morning` field set rather than opening a dialog, which Task 5 already made silent. The broadcast button opens the panel with `people: []`.

- [ ] **Step 2: Move attachments and delete the scheduled-send field**

Attachments move into the panel. The broadcast box's `msgSendAt` ("Schedule the text for") is deleted — it is `once` with a day and time.

- [ ] **Step 3: Grep for survivors**

Run: `grep -n "remMode\|fuMode\|msgMode\|msgQuickMode\|What should happen" public/index.html`
Expected: no matches.

- [ ] **Step 4: Verify by hand**

Walk all five entry points: Add Follow-Up, the ⏰ from a thread and a matrix card, Message several, the in-thread reply, the matrix quick-add. Expected: the same panel every time, except the quick-add which stays one box.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Five forms that disagreed are now one"
```

---

### Task 11: Many recipients, and the region chips

**Files:**
- Modify: `public/index.html` (the panel's question 2, and the `Set up by text` list from Task 9)

**Interfaces:**
- Consumes: `/api/sms-signups?user=` (server.js:873) for the roster and consent state; `allowedAssignees` scope from Task 6.
- Produces: `setupRegions()` → the distinct RCs in the viewer's scope; chips render only when it returns more than one.

- [ ] **Step 1: Make question 2 take one or many**

One person renders as today's single control. Chips `All regions · <RC first names>` with counts, then a name search, then `Everyone here` and `Only the RCs`. Each name shows its consent state; an opted-out or unsigned-up person can be picked, and the readback says they will be tracked but not texted.

- [ ] **Step 2: Write one follow-up per recipient**

As the broadcast box does today. For `message`, one `/api/messages/send` call.

- [ ] **Step 3: Report a partial send honestly**

Review Focus 3. When some recipients succeed and some fail, say which failed and why. Never show a bare success for a partial send.

- [ ] **Step 4: Add the same chips above the text-setups list**

Filter by region, each row naming its own region so "All" still reads correctly.

- [ ] **Step 5: Verify by hand**

As Harold: three chips. As Lori: none, and no layout change. Pick Preston → `Everyone here` → five names, and the button reads `Save — 5 people…`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "Pick a region, then everyone in it"
```

---

## Natural stopping point

Tasks 1–6 are server-side, fully tested, and fix every bug in the spec without touching the UI. They can ship on their own. Tasks 7–11 are one continuous front-end change and are worth less when split.
