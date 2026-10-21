# Digital Note v4: the calls the WEB makes (written by the web agent)

If the API differs, the web follows NOTE_V4.md, "Changes (API, as built)".

## Owner (base /api/user/businesses/:id/note)

### Book read

`GET ""` returns:

- `telegram`: `{ configured, active, connected, chat_name, replies: "now"|"batch"|"off", signups, edits, acks, daily, reminders }`
- `addons`: the existing ones, plus `note_telegram`, `note_ack`, `note_form`, `note_voice` and `note_pdf`, each `{ active, expires_at? }`
- `prices`: plus `note_telegram`, `note_ack`, `note_form`, `note_voice`, `note_pdf`
- `my_templates`: a count (the list comes from `GET /templates`)

### Telegram

- `POST /telegram/link` → `{ url, group_url, bot, expires_at }`
- `POST /telegram/test`
- `PUT /telegram { replies, signups, edits, acks, daily, reminders }` → telegram state
- `DELETE /telegram` → telegram state

### Notes

- **`GET /notes?filter=due`:** notes with open checklist items due today, overdue or due this week. Each row has `due: { overdue, today, week }` (counts). Other filters may also carry `due` on rows.
- **`PUT /notes/:nid`:**
  - `{ form: { fields: [...] } }` → 403 `need_form` (new fields without the license);
  - blocks may hold check `due` / `who` and `audio` blocks → 403 `need_voice` (new audio blocks without the license).
- **`PUT /notes/:nid/share`** and **`PUT /groups/:gid/share`** gain:
  - `ack: bool` → 403 `need_ack`;
  - `opens_at: ISO|null`.

### Confirmations

`GET /notes/:nid/acks` returns:

```
{ data: [{ name, at, guest? }],
  not_yet: [{ name, last_at }],
  counts: { acks, opened_not } }
```

### Entries

- `GET /notes/:nid/entries`: rows have `fields: { fieldId: value }`, plus `audio` files (kind audio).
- Excel export happens in the browser. The web only offers it when `addons.note_form.active`.

### Voice

The owner records into a note like a file: `GET /upload-sign`, then the Cloudinary upload, then:

`POST /notes/:nid/files { public_id, resource_type: "video", name, voice: true }`

This returns 403 `need_voice` without the license. The web then adds the block `{ t: "audio", file_id }`.

### Templates

- `GET /templates` → `[{ _id, name, title, color, paper, blocks_count, created_date }]`
- `POST /templates { note_id, name }`: saves that note as a template.
- `PUT /templates/:tid { name }` and `DELETE /templates/:tid`
- `POST /notes { my_template: tid, lang, share_level? }`

### Views per day

`GET /notes/:nid/stats?days=30` and `GET /groups/:gid/stats?days=30` return:

```
{ data: [{ day: "YYYY-MM-DD", views, people }],
  total: { views, people },
  best: { day, views } }
```

## Public (/api/public/note/:token, and /api/public/note-group/:gtoken/notes/:nid)

### Read (`GET`)

- `share`:
  - `ack: bool`
  - `opens_at`
  - `not_open: bool`: when `not_open` is true the read has no content: `note: { title? }`, `blocks: []`, no files, no entries.
- `me`: `{ name, ack_at }`
- `note.form`: `{ fields }`, for collect notes.
- `features`: `{ sign, style, voice }`

### Writes

- `POST /ack { name }` → `{ data: { at } }`. Through a group: `POST /api/public/note-group/:g/notes/:nid/ack`.
- `POST /entries` (multipart):
  - `fields`: a JSON string, as `{ fieldId: value }`;
  - `voice`: one audio file (needs the owner's `note_voice`; 403 `need_voice`).
- **Errors:** 400 `{ code: "bad_field", field: id, message }`.

### Group read

`GET /api/public/note-group/:g` returns `share.opens_at` and `share.not_open` (no notes listed until it opens), plus `share.ack`.
