# Digital Note v3: agreed with the owner (Mr Black)

## Changes (API, as built)

These apply to the web side.

- **Downloads (§5):**
  - **Cause:** the Cloudinary account refuses plain delivery of PDF files. Tested on the real account: a PDF's `secure_url` returns `401 "deny or ACL failure"`, while docx/raw files deliver fine. Every PDF link in a note was broken.
  - **Fix:** the download routes return `{ url, name, expires_at }`, a signed `private_download_url` (api.cloudinary.com/…/download) that works for every type. It is valid for 1 hour.
  - **Query options:** `?inline=1` opens the file instead of saving it; `?redirect=1` answers with a 302.
  - **Auth:** these routes need the auth / PIN / guest headers, so the web calls them with fetch/axios, then opens `data.url`. Don't use `<a href>` straight to the route.
  - **Previews:** a file's `url` still works for image previews. Never link a PDF's `url`.
  - **Routes:**
    - Owner: `GET /notes/:nid/files/:fid/download` and `GET /entries/:eid/files/:fid/download`.
    - Public: `GET /api/public/note/:token/files/:fid/download` and `…/entries/:eid/files/:fid/download`. The same two exist under `/api/public/note-group/:gtoken/notes/:nid/…`.
    - An entry file is downloadable when the entries list would show that entry to this person.
- **Business name and logo (§3):**
  - **Name:** use the existing `PUT /api/user/businesses/:id { name }`.
  - **Logo:** new `POST /logo` (multipart `file`, JPG/PNG/WEBP, ≤ 2 MB, resized to 512 px) and `DELETE /logo` → `{ logo_url }`. The upload also sets `Business.logo_url`, so the My businesses list and the public pages pick it up.
  - **Read:** `GET ""` returns `business: { _id, name, logo_url }`.
  - **Errors:** a bad image returns 400 `code: "bad_image"`.
- **Style pack (§1):**
  - **Book read:** `GET ""` has `addons.note_style.active` and `prices.note_style`.
  - **Buying:** through the generic licenses route, like `note_sign`.
  - **Block shape:** `style: { color?, bg?, size?, align?, bold?, italic? }`, and only set fields are stored and returned (`size: "md"` and `align: "left"` are the defaults and are dropped).
  - **Callout:** `icon` defaults to "💡".
  - **Divider and sticker:** their `text` is always "".
  - **Stickers:**
    - the size goes in `style.size` (`sm | lg`; no size = md), plus optional `style.align`;
    - the colour, bg and bold styles are ignored;
    - a sticker key must match `[a-z0-9_-]{1,40}`, otherwise the block is dropped.
  - **Paper:** `note.paper` is on notes, list rows, public reads and group list rows.
  - **need_style:** 403 `{ code: "need_style", product: "note_style" }` when:
    - a styled block is new;
    - a styled block's look changes (type, style, icon or sticker key);
    - the paper changes to something other than plain.

    Text edits to styled blocks the note already has are allowed. Removing styled blocks is allowed.
  - **Duplicate:** keeps the styles and the paper.
  - **Public reads:** `features.style`.
- **share_level (§2):** `POST /notes { share_level }`. Without it, a template's own level applies (signup/homework → collect), otherwise `off` (Closed). `PUT /settings` still exists, but the web shouldn't use it.
- **Group icon (§4):**
  - **Buying:** generic licenses can't buy item products without days, so the web buys through `POST /groups/:gid/icon/unlock`.
    - Returns 201 with `charged`, or 200 with `already: true, charged: 0`, or 402 `code: "coins"`.
    - Double clicks are safe.
  - **Uploading:** `POST /groups/:gid/icon` (multipart `file`, JPG/PNG/WEBP ≤ 2 MB, resized to 256 px).
    - Without the license: 403 `{ code: "need_group_icon", product: "note_group_icon", item: gid }`.
    - The picture counts toward storage.
    - `DELETE /groups/:gid/icon` frees its space.
  - **Where it shows:** `group.icon_image` (a URL, "" for none) on group rows, the public group read and the public note read via a group.
  - **Owned groups:** `addons.note_group_icon.items` lists the group ids whose icon is unlocked.
- **Media (§6):**
  - **Read:** `GET /media` always answers 200. Not unlocked → `{ locked: true, data: [], totals, price }`, for the locked preview.
  - **Pages:** 50 rows a page.
  - **Rows:** `{ _id, where: "note"|"entry", note_id, note_title, note_deleted, entry_id, entry_name, name, kind, size, mime, url, at, by, sign }`. `_id` is the file id.
  - **Totals:**
    - `{ used, limit, count, bytes, kinds: { <kind>: { count, bytes } }, top_notes: [{ note_id, note_title, note_deleted, count, bytes }] }`;
    - `used` (the storage meter) also includes group icons, which are not listed in the media table.
  - **Deleting:** `DELETE /media` needs `note_media` (403 `need_media`).
    - The body goes in axios `data` (`{ items }`), and items that don't exist are skipped.
    - Answers `{ removed: [...], freed, storage_used, storage_limit }`.
    - More than 100 items gives 400 `too_many`.
- **v3b:** see NOTE_V3B.md "Changes (API, as built)".


The new prices are editable in admin Prices. Register them everywhere the earlier note products are registered:

- **API:** `license.products`, `homepage.defaults`, `homepage.model`.
- **Web:** prices catalog, Licenses page texts and icons, admin price labels.

| Key | Coins | What |
|---|---|---|
| `note_style` | 5, forever, once per business | Style pack: every extra formatting option below |
| `note_group_icon` | 2, forever, per group (`item` = group id) | Use an uploaded picture as a group's icon |
| `note_media` | 8, forever, once per business | Media manager page |

## 1. Style pack (`note_style`)

Free notes keep what exists today: paragraph, heading, bullet, checklist, quote, file, draw (if `note_sign`) and colour. The pack unlocks the following.

### Block styles

`block.style = { color, bg, size, align, bold, italic }`

- `color`: text colour. One of 10 named colours: `red orange amber green teal blue indigo purple pink gray`.
- `bg`: highlight background, the same 10 names.
- `size`: `sm | md | lg | xl`.
- `align`: `left | center | right`.
- `bold` and `italic`: booleans. They apply to the whole block.
- Shown through a small style popover on each block (an "Aa" button in the block toolbar).

### New block types

- `callout`: `{ text, icon (an emoji), style.bg }`. A boxed tip or warning.
- `divider`: a horizontal line.
- `sticker`: `{ sticker: key }`. A built-in set of about 48 original SVG stickers. They are simple, friendly and brand-free, in groups:
  - reactions: star, heart, fire, clap, thumbs-up, 100, check, cross;
  - office: pin, clip, calendar, clock, bell, megaphone, warning, idea;
  - school: book, pencil, A+, trophy, medal, apple, ruler, backpack;
  - shop: cart, tag, gift, money, receipt, truck, box, sale;
  - celebration: balloon, cake, party, confetti, firework, flower, sun, moon;
  - Cambodia-friendly: lotus, temple silhouette (generic, not a real logo), mango, rice, coconut, tuk-tuk, boat, palm.

  Sizes: `sm | md | lg`. Ship the stickers as one JS module of inline SVG strings, shared by the editor and the public view.

### Emoji

- An emoji picker button in the editor toolbar inserts an emoji at the caret.
- Categories: smileys, people, nature, food, activities, travel, objects, symbols, flags (a curated ~300 list is fine), plus "recent" (localStorage, try/catch).
- Typing emoji from the keyboard always stays free. Only the picker UI is part of the pack.

### Note paper

`note.paper` is one of `plain | lined | grid | dots | kraft | night`. It changes the note background on both the editor and the public page.

### Server rules

- Clean and validate the new fields.
- Without `note_style`:
  - refuse NEW styled blocks, callouts, dividers, stickers and paper changes with 403 `{ code: "need_style", product: "note_style" }`;
  - keep the ones the note already has, so a note never becomes unsaveable (the same rule as draw blocks).

### Locked state

The style button, emoji picker, sticker and callout entries show a lock. Clicking one opens the unlock dialog with a preview of what the pack contains.

### Where it applies

The public page and the edit-together level render all of it. Guests at the edit level can use the pack only if the owner owns it.

## 2. Remove the global "Settings → New notes are shared as"

- **Remove** the Settings section from the dashboard menu, and the default-level setting.
- **New note dialog:** gets a "Share as" choice (Closed / View only / Write below / Edit together / Sign-up list). The default is Closed, or the template's own default (sign-up and homework → Sign-up list).
- **Note in a group:** a note created inside a group, or added to one, shows a hint in its share dialog: "People who open the group link use the group's setting". The group's own share dialog sets the group level.
- **`ask_name`:** stays per note and per group, as it is in the share dialogs now.
- **API:** `PUT /settings` can stay for compatibility, but the web no longer calls it. `POST /notes` accepts `share_level`.

## 3. Business name and logo

The Digital Note dashboard needs a Business card or profile section, the same as the other business types. Find how debt, flipbook and attendance let the owner change the business name and logo, and reuse the same API routes and components. There may be a generic business update route.

- The logo shows in:
  - the dashboard header;
  - the My businesses list;
  - the public note page and the group page top bar (unless `hide_owner`).
- Place it in the "More" part of the menu, e.g. "Business profile", next to Storage & plan.

## 4. Group icon picture (`note_group_icon`)

- **Upload:** `POST /groups/:gid/icon` (multipart `file`, image only, ≤ 2 MB, resized to 256 px on upload) and `DELETE /groups/:gid/icon`.
  - The picture is stored on the group as `icon_image: { public_id, url }`.
  - It counts toward storage.
- **Paying:** the first upload for a group needs `note_group_icon` for that group, 2 coins, forever.
  - The web shows the unlock dialog, then uploads.
  - The server refuses without the license with 403 `{ code: "need_group_icon", product: "note_group_icon", item: gid }`.
- **Changing the picture later** for an unlocked group is free.
- **Where it shows:** wherever the group shows (groups list, group page, the public group page, the New note group picker, the Licenses page). The colour and emoji icon stay as the fallback.

## 5. Downloads (bug)

Files in notes (PDF, docx, xlsx, zip, images) can't be downloaded. Find the real cause, probably one of:

- Cloudinary refuses PDF/ZIP delivery by default (401);
- `download` attributes are ignored across sites;
- raw URLs are wrong.

Fix it for both the owner and guests:

- **API routes:**
  - `GET /notes/:nid/files/:fid/download` (owner) and the public equivalents for files the guest is allowed to see: note files, plus entry files visible to that guest. The same applies through group links.
  - These answer with a redirect, or `{ url }`, to a short-lived signed Cloudinary download URL with `attachment` and the original file name. For example `cloudinary.utils.private_download_url` (works even when PDF delivery is restricted), or an `fl_attachment` delivery URL when that works. Test which one works on the real Cloudinary account with one small PDF and one docx, then delete them.
- **Web:** every file chip or row gets a Download button that uses this route. Clicking a PDF or image still opens a preview where possible.

## 6. Media manager (`note_media`)

A "Media" page in the menu, near Storage & plan. Without the unlock it shows a locked preview and the unlock dialog: 8 coins, forever.

### API

**`GET /media?sort=size|date|name&kind=all|image|pdf|doc|other|sign&q&page`** lists every stored file of the business: note files, guest entry files and signatures. Each row is `{ _id, where: "note"|"entry", note_id, note_title, entry_id, entry_name, name, kind, size, mime, url, at, by }`, plus:

- `totals`:
  - `used` and `limit`;
  - `count`;
  - per kind: `count` and `bytes`;
  - the top 10 largest notes by bytes.

**`DELETE /media`** with body `{ items: [{ where, note_id, entry_id?, file_id }] }` (bulk delete, up to 100):

- Each removal is conditional and releases its storage exactly once (reuse the existing safe delete code).
- Removing a note file also removes the `file`/`draw` blocks that point to it.
- It returns what was removed and the bytes freed.

### Web

- The used/limit bar with the per-kind breakdown, shown in GB or MB as fits.
- A "Biggest notes" list.
- A filterable, sortable table or cards: preview thumbnail, name, size, type, the note it belongs to (a link that opens the note), who added it and when.
- Checkboxes for bulk delete, behind a confirm dialog that says how much space will be freed.
- Download buttons.

## Tests

- **API tests:** extend `$HOME/notetest`, test database only, never the real one.
- **Web:** run the vite build, plus mocked-API screenshots of every new screen at 390 px and desktop width.
