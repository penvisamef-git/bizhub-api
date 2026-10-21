# Changes (API, after the first draft): additions only, nothing removed or renamed
- **Wrong PINs:** counted per link, not per IP, and stored in MongoDB (NotePinFail, with a TTL). After 10 wrong PINs in 15 minutes, everyone on that link gets 429 `pin_wait`.
- **Public GET `limits.send_max`:** how many bytes one send may carry. It is 4 MB on Vercel and 0 elsewhere (0 = no limit). There, `file_limit` is capped to it too. Clients check a send's total size before uploading.
- **Note JSON limit:** 4 MB on the note routes (2 MB elsewhere). An oversized body returns 413 `{ code: "too_large" }`; clients stop retrying.
- **`too_many_files`:** has its own message. In collect mode it also returns `left` (how many more files fit on the row).
- **Deletes:** every file and entry delete is conditional, so space is given back once. A second delete of the same file returns 404.

- **License grace:** like attendance and restaurant, the owner can still write for 7 days after the year ends. After that the book is read-only.
  - Writes are then refused with 402 `{ code: "locked", product: "digital_note" }`.
  - These still work while read-only: reading, pin/colour/tags, share settings, deleting (soft, forever, files, entries) and restoring from the bin.
- **Notes and rows carry `share.path`** = `"/n/<token>"`, so clients build the link as origin + path.
- **`GET ""`** also returns `templates: [...]`.
- **`POST /notes`** takes `lang` (`"en"` | `"km"`, default km) for the template text.
- **Owner entry rows** have `new: true` until the owner has opened them. `GET /notes/:nid/entries` marks the returned page as seen, which lowers `counts.entries_new`.
- **New: `GET /notes/:nid/history/:rid`** → `{ _id, version, by, at, title, blocks }`, to preview an old version before restoring it. A restore always makes its own new history row.
- **`DELETE /notes/:nid/files/:fid`:** also removes the file blocks that showed the file (version +1), and returns the updated note.
- **Duplicate** copies the text only. Files are not copied, and file blocks are left out.
- **`POST /notes/:nid/share/new-link`:** also clears "Seen by" for that note.
- **`POST /notes/:nid/files`** takes an optional `name`.
  - The `public_id` must be in the signed folder (`bizhub/note/<businessId>/…`); otherwise the call returns 400 `bad_file`.
  - The signed upload's `upload_url` is `…/auto/upload`, so the client can post any file type there.
- **The upload-sign response** also has `file_limit` and `storage_left`.
- **Public `GET`:**
  - Add `?poll=1` to the 15 s refresh. It then doesn't count as a new view.
  - The response also has `share.set_level` (the owner's level), `share.expires_at`, and `limits: { file_limit, files_per_entry: 5 }`.
  - Entries carry `mine: true` on the guest's own rows. `guest_key` is never sent.
  - Entries are also shown at the view level, read-only, when `show_entries` is on (e.g. after a link expired).
  - When `show_entries` is off, a guest sees their own rows plus the owner's replies; in collect mode, only their own row.
- **Public `PUT ""`:** `base_version` is required; when it's missing the call returns 409.
- **Public `PUT /entries/:eid`** takes `{ text, name, remove_files: [fileId] }`.
- **Public collect:** a second POST updates the guest's row. The text is replaced and new files are added, up to 5 files in total.
- **PIN errors:** 401 `{ code: "pin", wrong: true }` for a wrong PIN; after 10 wrong tries in 15 minutes, 429 `{ code: "pin_wait" }`.
- **The PIN** is stored with bcrypt.
- **Guest headers:** the guest key must match `/^[A-Za-z0-9_-]{8,64}$/`. Writing needs it (400 `no_guest`).

# Digital Note: product + API contract (shared by the API, web and app)

## What it is

A business type in the **Personal** group. Category key: `digital_note`. Homepage service key: `digital_note`.

Each note is a small live page the owner can share by link or QR. The people who open the link can view it, write under it, edit it, or fill in their own row, depending on the share level.

## Pricing

Pricing is **yearly**, like `restaurant` and `attendance`:

- `PRODUCTS.digital_note = { price_key: "digital_note", days: 365, category: "digital_note", service: "digital_note" }`
  - Default price: `digital_note: 10` coins per year.
  - Paid when the business is added (the existing yearly-type flow creates the license), then renewed on the Licenses page.
- Add-on `note_storage`: `{ price_key: "note_storage", days: 365, category: "digital_note", service: "note_storage" }`.
  - Default price: 15 coins per year.
  - Adds 10 GB of storage.

**Included:** 1 GB of storage, and up to 20 MB per file.

**When the license has expired** (locked):

- the owner can still read and export everything;
- creating, editing, uploading and replying are refused (402 or 403, with a Khmer message, as other modules do);
- shared links still open read-only, with a banner: "paused by the owner".

## Data (mongoose models in `bizhub-api/src/biz/note/note.models.js`)

### NoteBook (one per business)

- `business_id`
- `storage_used` (bytes)
- `settings`: `{ default_level: "view", ask_name: true }`
- `created_date` / `updated_date`

### Note

- `business_id`
- `title` (≤ 200 characters)
- `blocks`: `[{ id, t, text, done, file_id }]`
  - `t` is one of `p` (paragraph), `h` (heading), `bullet`, `check` (checkbox item; `done` is a bool), `quote`, `file` (points to a file in `files` by `file_id`).
  - `text` is plain text, ≤ 5000 characters.
  - At most 500 blocks.
- `color`: `default | yellow | green | blue | purple | pink | gray` (the card colour in lists)
- `pinned` (bool)
- `tags`: up to 10 strings
- `files`: `[{ _id, public_id, resource_type, url, name, size, mime, kind: image|pdf|doc|other, by: "owner"|guestName, at }]` (the owner's attachments)
- `share`:
  - `token`: 22 random URL-safe characters, unique, made when the note is created
  - `level`: one of
    - `off`: the link is closed
    - `view`
    - `reply`: can add entries below
    - `edit`: can edit title and blocks, and can also reply
    - `collect`: each guest submits one row; the owner sees all rows, a guest sees only their own
  - `pin_hash`: bcrypt of a 4–8 digit PIN, or null
  - `expires_at`: date or null; after it, the link is view-only
  - `allow_files`: bool, default true; guests may attach files to entries
  - `show_entries`: bool, default true; in reply mode, guests see each other's entries
  - `ask_name`: bool, default true
- `version`: number, +1 on every save of the title or blocks
- `updated_by`: "owner" or the guest's name
- `views`: total opens
- `entry_count`
- `deleted`: bool (soft delete, can be restored), `deleted_at`
- `created_date` / `updated_date`

### NoteEntry (things written under a note: replies and collect rows)

- `business_id`, `note_id`
- `kind`: `reply | collect`
- `guest_key`: random id kept in the guest's browser (localStorage `bh_note_guest`), so a guest can edit or delete their own entries
- `name` (≤ 80), `text` (≤ 3000), `files[]` (same shape as the note's files)
- `hidden`: the owner hid it
- `by_owner`: bool (the owner replied)
- `created_date`, `updated_date`

### NoteSeen

- `note_id`, `guest_key`, `name`
- `first_at`, `last_at`, `count`
- Unique on (`note_id`, `guest_key`).

### NoteRev (history)

- `note_id`, `version`, `title`, `blocks`, `by`, `at`
- Keep the last 50 per note.
- Save a revision at most once every 2 minutes per editor (merge rapid saves).

## Owner API

Base: `/api/user/businesses/:id/note`. The `customer_auth` guard is the same as the debt/flipbook owner guard. The response envelope is `{ success, data, message }`. Messages are in Khmer, like the other modules.

### Book and notes

- **`GET ""`**
  - Returns `{ book: { storage_used, storage_limit, file_limit, settings }, license, addons: { note_storage: status }, prices: { note_storage }, counts: { notes, shared, entries_new } }`.
- **`GET /notes?q&filter&sort&page`**
  - `filter`: `all | pinned | shared | deleted`
  - `sort`: `updated | created | title`
  - Returns rows **without blocks**: `{ _id, title, preview (first ~140 chars of text), color, pinned, tags, share: { level, has_pin, expires_at, token }, entry_count, views, files_count, updated_date, updated_by }`.
  - Pages of 30.
- **`POST /notes`** `{ title, blocks, color, tags, template? }` → the full note.
  - Templates (the server fills `blocks`): `blank | meeting | homework | checklist | room_rent | repair_job | trip | signup`.
  - `signup` and `homework` set `share.level` to `collect`.
- **`GET /notes/:nid`** → `{ note (full), entries_new }`.
- **`PUT /notes/:nid`** `{ title?, blocks?, color?, pinned?, tags?, base_version? }`
  - When blocks or the title change and `base_version` is not the current version, the call fails with **409** `{ code: "conflict", data: currentNote }`.
- **`DELETE /notes/:nid`**: soft delete. **`POST /notes/:nid/restore`** undoes it. **`DELETE /notes/:nid/forever`** removes the note and its files from storage.
- **`POST /notes/:nid/duplicate`**

### Sharing

- **`PUT /notes/:nid/share`** `{ level, pin (string, "" = remove), expires_at (ISO or null), allow_files, show_entries, ask_name }`
- **`POST /notes/:nid/share/new-link`**: a new token; the old link stops working.

### Files (owner attachments)

- **`GET /upload-sign`**: a signed Cloudinary upload, as flipbook does, in folder `note/<businessId>`.
- **`POST /notes/:nid/files`** `{ public_id, resource_type }`
  - The server checks the file info (size, format) with the Cloudinary admin API.
  - It enforces `file_limit` and `storage_limit`, adds the file, increases `storage_used`, and returns the file.
  - If the file is over a limit, the server deletes it from Cloudinary and returns 413 (the code is `storage_full` or `file_too_big`).
- **`DELETE /notes/:nid/files/:fid`**: removes the file and frees its space.
- Fallback: **`POST /notes/:nid/files/direct`**, multipart field `file`, for the app if signed upload is hard. Same limits.

### Entries, seen, history

- **`GET /notes/:nid/entries?page`** (newest first; includes hidden ones)
- **`POST /notes/:nid/entries`** `{ text }`: the owner replies (`by_owner`)
- **`PUT /entries/:eid`** `{ hidden }`. **`DELETE /entries/:eid`** frees the entry's file space.
- **`GET /notes/:nid/seen`**: `[{ name, first_at, last_at, count }]`
- **`GET /notes/:nid/history`**: `[{ _id, version, by, at, title }]`
- **`POST /notes/:nid/history/:rid/restore`**: makes a new version from the old one.
- **`PUT /settings`** `{ default_level, ask_name }`

## Public API (no login)

Base: `/api/public/note/:token`. A rate limit applies to the write calls.

These headers are sent on every call:

- `x-note-pin`: when the note has a PIN
- `x-note-guest`: the guest key (the client creates one if it has none)

### Endpoints

- **`GET ""`**
  - Returns `{ note: { title, blocks, files, color, version, updated_date, updated_by }, business: { name, logo? }, share: { level (the effective one: view when the link has expired or the license is locked), ask_name, allow_files, show_entries, expired, paused }, entries (for reply mode with show_entries: everyone's, not hidden, newest last, up to 200; for collect mode: only this guest's), me: { name } (from NoteSeen) }`.
  - Counts a view and updates NoteSeen.
  - **401** `{ code: "pin" }` when a PIN is needed or wrong.
  - **404** `{ code: "off" }` when the link is closed, the note is deleted, or the business is suspended.
- **`POST /seen`** `{ name }`: sets the guest's name on NoteSeen.
- **`PUT ""`** `{ title, blocks, base_version, name }`: edit level only. 409 on a conflict, with the current note. Saves a revision.
- **`POST /entries`** multipart: `text`, `name`, and `files` (up to 5).
  - Only at the reply, edit or collect levels.
  - In collect mode: one entry per `guest_key`; a second POST updates that entry instead.
  - File limits and the owner's storage limit apply.
  - Files go through the server to Cloudinary (resource type auto), in folder `note/<businessId>/guest`.
- **`PUT /entries/:eid`** and **`DELETE /entries/:eid`**: only by the same `guest_key`.

## Web

- **Public page:** `/n/:token` (like `/d/:token` for debt).
  - Shows the note in a clean reading layout, the "Seen by" name prompt (when `ask_name` is on), the entries list, and the add-below box with file attach.
  - At the edit level, an inline block editor. It saves itself 1.5 s after typing stops, or on blur. A conflict shows "Someone else changed this note" with a Reload button.
  - Polls every 15 s for new entries and versions.
  - A print button prints the page (export to PDF through the browser).
- **Owner dashboard** (like the other types):
  - a notes list (search, filters, pinned first, colour cards, "New note" with template chooser);
  - a note editor (blocks: paragraph, heading, bullet, checklist, quote, file; autosave; attach files);
  - a share dialog (level picker with the 5 levels explained, PIN, expiry, options, copy link, QR, share to Telegram);
  - tabs on the note for entries, seen by, files and history;
  - a storage meter, with buy/renew `note_storage` through the existing PurchaseModal and licenses flow.
- **Registrations everywhere** `debt_book` is registered: homepage, prices catalog, BizTypes, licenses texts, bizTypeInfo, BusinessModal, DashboardPage, AuthSlides, pages.js, the super admin text, HomepageSettings.

## App (Flutter owner app, fully native, no web links except for opening the public page itself)

- Register the type everywhere `debt_book` is: `site.dart`, `theme.dart` (icon and colour), `home_page`, `admin_homepage`, `admin_data`, `admin_dashboard`, `open_business`, `ui.dart`, the i18n JSON (through `tool/extract_texts.js`).
- Screens:
  - **Notes list:** search, filter chips, pinned first, colour cards.
  - **New note:** a template chooser bottom sheet.
  - **Block editor:** keyboard-friendly; Enter makes a new block; a toolbar to change the block type, check items and attach a file or photo; autosave; conflict handling.
  - **Share sheet:** the 5 levels as selectable cards, PIN, expiry date, toggles, copy link, QR, and share through the system sheet.
  - **Note tabs:** entries (hide, delete, reply), seen by, files (open in the in-app viewer for images; open the URL for others), history (restore).
  - **Storage meter:** buy `note_storage` with the same coin purchase sheet other add-ons use.
- Follow the app's existing style (`ui.dart` widgets, Riverpod, go_router, LookSheet patterns, `app_text.dart` for app-only words).
