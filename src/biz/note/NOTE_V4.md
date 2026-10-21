# Changes (API, as built)

Owner base: `/api/user/businesses/:id/note`. Public bases: `/api/public/note/:token` and `/api/public/note-group/:gtoken/notes/:nid`. Every error is `{ success: false, message (Khmer), code }`.

## Buying the 5 add-ons

Buy `note_telegram`, `note_ack`, `note_form`, `note_voice` and `note_pdf` through the generic Licenses route, exactly like `note_sign` and `note_style` (`licenseService.buy(id, product, expires_at ?? null)`). `note_telegram` is yearly and renews there.

`GET ""` adds:

- `addons.note_telegram`, `note_ack`, `note_form`, `note_voice`, `note_pdf` (license statuses);
- `prices.note_telegram`, `note_ack`, `note_form`, `note_voice`, `note_pdf`;
- `telegram`: the state from § 1;
- `counts.due`: `{ overdue, today, week }`, the open checklist items over all notes.

## 1. Telegram

- **Calls:**
  - `POST /telegram/link` returns `{ url, group_url, bot, expires_at }`. The link is valid for 15 minutes, and the owner opens it in Telegram.
  - `POST /telegram/test`
  - `PUT /telegram { lang: km|en, replies, replies_batch, signups, edits, acks, daily, reminders }` (all booleans except `lang`)
  - `DELETE /telegram`
  - Every call returns `data` = the state.
- **State:** `{ configured, active, expires_at, connected, chat_name, connected_at, lang, replies, replies_batch, signups, edits, acks, daily, reminders }`.
- **Errors:**
  - `need_telegram` (403) on link/test without the add-on. `PUT` and `DELETE` always work.
  - `tg_not_configured` (503), `tg_not_connected` (400), `tg_blocked` / `tg_unreachable`.
- **Defaults:** replies on (sent at once), sign-ups on, edits off, confirmations on, daily on, reminders on.
- **Batching:** `replies_batch = true` merges replies into one message every 15 minutes, sent by the scheduler. Everything else goes out at once, at most one message a minute per note per kind; the rest are merged into the next one.
- **Scheduling:**
  - The scheduler runs on `/api/cron/daily-report`, which is called every 15–60 minutes by an outside scheduler, and also on `/api/cron/note-telegram`.
  - So the daily summary arrives at the first scheduler run after 08:00.
  - "1 hour before" means a due time 0–75 minutes away at a scheduler run.
  - "Due today" items arrive with the 08:00 message.
- **Message links** go to `<WEB_URL>/app/business/<id>?tab=notes&note=<nid>`.

## 2. "I've read it"

- **Settings:** `PUT /notes/:nid/share { ack }` and `PUT /groups/:gid/share { ack }`.
  - Turning it on needs `note_ack`: 403 `need_ack`.
  - Turning it off is free, and a note that already has it keeps it.
- **Public read** adds `ack: { on, mine: { name, at } | null }`. Through a group link, `on` is the group's setting.
- **Public confirm:** `POST …/ack { name }`.
  - Needs the guest key. The name is required when `ask_name` is on.
  - It returns 200 `{ name, at }`. Confirming again returns the same row.
  - Errors: 403 `no_ack` when ack is off, 403 `paused` when the plan is locked.
- **Owner:** `GET /notes/:nid/acks` returns:
  - `data: [{ name, at, by_group }]`, newest first;
  - `not_confirmed: [{ name, first_at, last_at }]`, people from Seen by who haven't confirmed;
  - `counts: { confirmed, opened_not_confirmed }`.
- **CSV:** `GET /notes/:nid/acks?format=csv` returns `text/csv` (name, confirmed at, through group).

## 3. Sign-up list fields

- **Saving fields:** `PUT /notes/:nid { form: { fields: [{ id, label, type, required, options, max }] } }`.
  - `type` is one of `text|number|phone|email|date|choice|checkbox`.
  - `options` (1–30 items) only for `choice`, and `max` (1–1000, default 200) only for `text`. Up to 20 fields.
  - New or changed fields need `note_form`: 403 `need_form`. Removing fields is free.
- **The form on a note:** both `noteOut` (owner) and the public note read contain `form: { fields }`.
- **Public answers:** at the collect level, `POST …/entries` takes the multipart field `fields`, a JSON string `{ fieldId: value }`.
  - Values are checked on the server: 400 `field_required` / `field_bad` with `field: id`, and the message names the label.
  - Number becomes a number, checkbox a boolean, date `YYYY-MM-DD`, choice must be one of the options.
  - With fields, the text is optional.
  - Sending again updates the guest's row, as before. The answers are replaced as a whole.
- **Entries** (owner list, public list, `mine`) carry `fields` (an object, or absent).
- **Export:** `GET /notes/:nid/entries/export?format=csv|xlsx`.
  - `csv` is free and returns `text/csv` with UTF-8 BOM, so Excel opens Khmer correctly. The columns are name, time, every field label, text, file names.
  - `xlsx` needs `note_form` (403 `need_form`). It returns JSON `{ columns: [labels], rows: [[…]] }` with the same columns, and the web builds the .xlsx.

## 4. Checklist due dates and assignees

- **Blocks:** check blocks keep `due` (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, Cambodia time) and `who` (≤ 60 characters). Bad values are dropped silently.
- **Note list filter:** `GET /notes?filter=due` lists notes with open items that are overdue or due today through the next 6 days. Sort: the most overdue first.
- **Due counts:** every row of `GET /notes` carries `due: { overdue, today, week }` counts (zeros when none).
  - `overdue` means past the due moment; a date alone falls due at the end of that day.
  - `today` means due today and not past.
  - `week` means due in the next 6 days after today.
- **Names list:** `GET /people` returns `{ data: [names] }`. These are names from Seen by plus earlier assignees, for the editor's datalist, up to 200.

## 5. Voice notes

- **New block:** `{ t: "audio", file_id }`. The file must be an audio file of the note (`file.voice` or an audio type).
  - New audio blocks without `note_voice` get 403 `need_voice`. Existing ones are kept.
- **Owner upload:** upload as now (signed Cloudinary upload, then `POST /notes/:nid/files { …, voice: true }`), or `POST …/files/direct` with the multipart field `voice=true`.
  - `voice: true` needs `note_voice` (403 `need_voice`), an audio file, and at most 15 MB (`bad_voice`).
  - Files carry `voice`.
  - Signed uploads of audio come back from Cloudinary as `resource_type: "video"`. Send that `resource_type` back as is.
  - Give the file a name with an audio extension (`voice-….webm`, `.m4a`, `.ogg`, `.mp3`, `.wav`), so its type is recognised.
- **Guest voice clip:** the multipart field `voice` (one file) on `POST …/entries`.
  - Needs the business to own `note_voice` (403 `need_voice`). Audio only, ≤ 15 MB, counts as one of the 5 files.
  - The public read's `features.voice` says whether it's on.
- **Media:** voice files are kind `audio`. Duplicating a note leaves audio blocks out.

## 6. Your own templates

- **Calls:**
  - `GET /templates` returns `{ data: [{ _id, name, title, color, paper, theme, share, form, blocks_count, created_date }] }`.
  - `POST /templates { note_id, name }` saves the note as a template. It copies title, blocks (without file/draw/audio blocks and without due dates; `who` is kept), colour, paper, theme, share defaults (level, allow_files, show_entries, ask_name, ack) and form. At most 50 templates (`too_many_templates`).
  - `PUT /templates/:tid { name }` renames; `DELETE /templates/:tid` deletes.
- **Creating from one:** `POST /notes { my_template: tid, share_level? }`.
  - Paid parts are kept only if they're owned now. Otherwise they're dropped quietly: style-pack looks, paper, theme, form fields, ack.
  - `share_level` wins over the template's level.

## 7. "Open from" date

- **Setting it:** `PUT /notes/:nid/share { opens_at: ISO | null }` and `PUT /groups/:gid/share { opens_at }`.
- **Before that time,** every public call for the link (reads, writes, downloads, the group list and files) answers **403 `{ code: "not_open", opens_at, business, title: "" }`**, with no content. `business` respects `hide_owner`.
- **Through a group link,** the group's `opens_at` applies. A note's own `opens_at` also applies when it is opened through a group. The group list shows such notes with `locked_until` and no preview.
- **Order:** the check runs before the PIN check, so the countdown shows without a PIN.

## 8. PDF export

- `GET /notes/:nid/print` (needs `note_pdf`: 403 `need_pdf`) returns:
  - `note` (noteOut);
  - `business: { name, logo_url }`;
  - `entries` (not hidden, oldest first, up to 1000, with `fields`);
  - `acks: [{ name, at }]`;
  - `theme`;
  - `printed_at`.
- The web lays out the page (print stylesheet). The free Print button stays as it is.

## 9. Views per day

- `GET /notes/:nid/stats?days=30` and `GET /groups/:gid/stats?days=30` (1–365) return:
  - `days: [{ day, views, people }]`, oldest first, every day present;
  - `total: { views, people }`;
  - `best: { day, views } | null`.
- A counted view is a public read without `?poll=1`. People means different guest keys that day.
- A note opened through a group link counts for the note; the group page counts for the group.

## Other

- **Public read:** also has `share.ack`, `features.voice` and `limits.voice_max` (bytes; on Vercel capped at the 4 MB send limit).
- **Merged replies (`replies_batch`):** they go out at the first scheduler run when no reply message for that note went in the last 15 minutes.

- **Share outputs:** `shareOut` / `groupShareOut` now include `ack` and `opens_at`.
- **Data change:** `NoteEntry.fields`. The new collections are listed in the models.

---

# Digital Note v4: everything Mr Black approved ("do it all")

All prices are editable in admin Prices. Register the new products everywhere the earlier note products are registered:

- **API:** `license.products`, `homepage.defaults`, `homepage.model`.
- **Web:** prices catalog, Licenses page texts and icons, admin price labels, an Add-ons card for each.

| Key | Coins | What |
|---|---|---|
| `note_telegram` | 10 per year | Telegram alerts for the owner plus checklist reminders |
| `note_ack` | 5, forever | "I've read it" confirmations |
| `note_form` | 5, forever | Sign-up list with custom fields, plus Excel export |
| `note_voice` | 5, forever | Voice notes in notes and replies |
| `note_pdf` | 5, forever | Branded PDF export |

These are **free for everyone**: checklist due dates and assignees, your own templates, the "Open from" date, views per day.

## 1. Telegram alerts (`note_telegram`, yearly)

Reuse the existing Telegram bot module and how debt (`debt_remind`) links an owner's Telegram: a link code or deep link, a test message, unlinking.

The owner links their Telegram once per Digital Note business, then chooses:

- **New replies:** sent at once, or batched every 15 minutes.
- **New sign-up rows.**
- **Edits by guests** at the edit level.
- **"I've read it" confirmations.**
- **A daily summary at 08:00** Cambodia time (UTC+7): new replies, sign-ups and confirmations per note, plus checklist items due today.
- **Checklist reminders:** items with a due date are reminded on the due day at 08:00, and again 1 hour before when the item has a due time. An item that is ticked is never reminded.

Messages are in the owner's language (Khmer by default) and include the note title and a link to the note in the dashboard.

- **Delivery:** use a queue or batching so a busy note doesn't spam (at most 1 message a minute per note per kind; merge the rest).
- **Scheduler:** hook into the existing daily cron, the way debt `dailyReports()` is called from `/api/cron/daily-report`. If there is a more frequent cron, use it for the 15-minute batches and the hour-before reminders. Otherwise send the replies immediately, with a per-note cooldown.
- **API:**
  - `POST /telegram/link`, `POST /telegram/test`, `PUT /telegram { replies, signups, edits, acks, daily, reminders }`, `DELETE /telegram`.
  - The `GET ""` book read includes the Telegram state.

## 2. "I've read it" (`note_ack`, forever)

- **Share option:** a new per-note and per-group option, `share.ack: bool`. It can only be turned on with `note_ack`; without it the server returns 403 `need_ack`.
- **Public page:** when `ack` is on, the page shows a big "I've read it" button.
  - It needs a name, so it uses the name prompt.
  - After tapping it, the visitor sees "You confirmed on <date>".
  - One confirmation per guest key per note: `NoteAck { note_id, group_id?, guest_key, name, at }`.
- **Owner:** a new "Confirmed" tab on the note shows:
  - who confirmed, and when;
  - who opened the note but didn't confirm yet (from Seen by);
  - a count, e.g. "12 confirmed · 5 opened but not confirmed".
  - Export to CSV.
- **Groups:** a group with `ack` on asks for a confirmation on each note opened through it.

## 3. Sign-up list with custom fields (`note_form`, forever)

- **Fields:** `note.form = { fields: [{ id, label, type: text|number|phone|email|date|choice|checkbox, required, options[] (for choice), max }] }`, up to 20 fields.
  - Editable on collect-level notes, in a "Form fields" section of the note's share area or editor, with drag to reorder.
- **Public form:** a collect-level note shows these fields instead of, or above, the free text box. They are validated on the server.
  - Rows are stored on `NoteEntry.fields = { fieldId: value }`.
  - Files are still allowed if `allow_files` is on.
- **Without `note_form`:**
  - adding fields gives 403 `need_form`;
  - a note that already has fields keeps working.
- **Owner view of the rows:** a table in the Replies tab for collect notes, with one column per field, plus name, time, files and the text.
  - Export to Excel (.xlsx) with the same columns. Use a library already in the web, or SheetJS if present, or add exceljs to the web.
  - CSV is free; Excel needs `note_form`.
  - Sort and filter by a column.

## 4. Checklist due dates and assignees (free)

- **Check blocks** gain `due: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"` (local time, UTC+7) and `who: string` (≤ 60 characters, a name).
- **Editor:** a small "📅 Friday · 👤 Dara" line under the item, edited through a little popover with a date, an optional time and a name.
  - The name list is a datalist built from Seen by names plus earlier assignees.
- **Public page:** shows the due date and the person. Items that are overdue and not done are shown in red.
- **Dashboard:** a "Due" filter in My notes: notes with open items due today, overdue, or due this week, with counts.
- **Reminders** come through `note_telegram` (section 1).

## 5. Voice notes (`note_voice`, forever)

- **Recording:** record audio in the browser (MediaRecorder, with webm/opus or mp4 fallback, max 5 minutes), with a timer, pause, cancel and a preview before saving.
- **New block type `audio`:** `{ id, t: "audio", file_id }`. It plays with a player that has waveform-like progress, speed 1× / 1.5× / 2×, and Download.
- **Guests:** at reply or collect level, guests can add one voice clip per reply, only when the owner owns `note_voice`.
- **Storage and server rules:**
  - recordings count toward storage;
  - kind `audio` in Media;
  - without `note_voice`, new audio blocks and guest voice uploads are refused with 403 `need_voice`;
  - existing audio blocks are kept.

## 6. Your own templates (free)

- **Saving:** "Save as template" in the note menu stores `NoteTemplate { business_id, name, title, blocks (no files, no draw or audio), color, paper, theme, share defaults, form }`, up to 50 per business.
- **New note dialog:** shows "My templates" above the built-in ones, with rename and delete.
- **API:** `GET`, `POST`, `PUT` and `DELETE /templates`. `POST /notes { my_template: id }` creates from one.
- **Style pack:** styled blocks in a template are kept only if `note_style` is owned when used, following the existing cleanBlocks rules.

## 7. "Open from" date (free)

- **Share option:** `share.opens_at`, a date and time, next to the end date, for notes and groups.
- **Before that time,** the public page shows a friendly countdown: "This note opens on Friday 24 Oct, 8:00" (counting down when under 24 hours). No content, files or entries are sent.
- **At that time it opens itself,** so the page should refresh when the countdown reaches zero.

## 8. Branded PDF export (`note_pdf`, forever)

- **Export PDF** in the note menu (owner) produces a nicely laid out A4 PDF with:
  - the business logo and name (unless hidden);
  - the note in its theme's colours (a print-friendly version);
  - the title, blocks, checklist states, images, signatures (draw blocks), stickers;
  - optionally the replies and sign-up rows (a table), and the "Confirmed" list;
  - a footer with the date, page numbers and "Made with BizHub" (removed only if a future no-brand option exists; keep it for now).
- **How to generate it:** in the browser. Use a print-layout route plus `window.print()` with a dedicated print stylesheet. Or a client-side PDF library already present in the web: check for jspdf, pdf-lib or html2pdf, and add one only if needed. Choose whatever gives a reliable A4 result. Text must stay as real text where possible, and Khmer must render (canvas-based libraries break Khmer shaping, so prefer the print-stylesheet route).
- **Without `note_pdf`:** the menu item shows a lock and the unlock dialog. The free "Print" stays as it is.

## 9. Views per day (free)

- **Storage:** `NoteView` daily counters `{ note_id, group_id?, day: "YYYY-MM-DD" (UTC+7), views, people (unique guest keys) }`, updated with $inc on each counted view. Polls (`?poll=1`) don't count.
- **Owner:** a small 30-day bar chart in the Seen by tab (views and people), with the total and the best day. Groups have the same in their "Opened the group link" section.
- **API:** `GET /notes/:nid/stats?days=30` and `GET /groups/:gid/stats?days=30`.

## Rules for all sections

- The new block types (`audio`, check `due`/`who`) and fields go through cleanBlocks and server validation. Duplicating a note keeps due dates and assignees, but not files or audio.
- Every new paid feature follows the same pattern:
  - 403 `need_<x>` without the license;
  - existing content stays saveable;
  - the web shows a lock and the unlock dialog with a preview.
- Texts in en + km.

## Tests

- **API tests:** extend `$HOME/notetest` with `runall.js` (in-memory MongoDB or the test database only, never the real one; Telegram stubbed; Cloudinary stubbed).
- **Web:** run the vite build, plus mocked screenshots of every new screen at 390px and desktop width.
