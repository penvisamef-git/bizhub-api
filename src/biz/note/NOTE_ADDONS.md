# Digital Note add-ons (v2): agreed with the owner

## Changes (API, as built) — read these first

**Owner `GET ""` (the book):**
- `book` adds `storage_included` (5 GB) and `storage_pack` (5 GB) in bytes.
- `prices` = `{ note_storage, note_group, note_sign, digital_note }`.
- `addons` changed shape:
  - `note_storage` = `{ packs (active), slots (all), active, gb_each: 5 }`;
  - `note_sign` = license status (`active`, `forever`…);
  - `note_group` = `{ owned }`.
- New `storage_slots: [{ item: "slot-N", active, expires_at, days_left, status… }]`.
- `counts.groups`.

**Buying packs: `POST /storage`.**
- `{ qty: 1…20 }` buys N new packs, one purchase each. Ended slots are reused first.
- `{ item: "slot-N", expect }` renews one pack. Renewing also works on the generic `POST /businesses/:id/licenses/note_storage { item, expect }`.
- Response `{ data: { bought: [items], storage_slots, addons, limits }, charged, balance }`.
- **Not enough coins:**
  - before any pack is bought: 402 `{ code: "coins", price, balance }`;
  - part-way: 402 `{ code: "coins", … }`, with `data.bought` listing what did go through.
- At most 200 active packs.

**Groups.**
- `POST /groups { name, color, icon, note_ids }` charges 25 coins. Response 201 `{ data: group, charged, balance }`.
  - Not enough coins: 402 `{ code: "coins", price, balance }`, and nothing is created.
  - No name: 400 `{ code: "need_name" }` (no charge).
  - Plan locked: 402 `{ code: "locked" }`.
- Group object:
  - `{ _id, name, color, icon, sort, note_ids: [string], notes_count, share: { token, path: "/n/g/<token>", level, has_pin, expires_at, ask_name, hide_owner, no_copy }, views, deleted, deleted_at }`.
  - Group levels are `off | view | reply | edit` (no `collect`; anything else gives 400).
- `GET /groups` returns `{ data: [groups], price }`. `?deleted=1` gives the bin.
- Restore after 30 days: 400 `{ code: "too_late" }`.
- `PUT /groups/:gid` also takes `sort`. `note_ids` are filtered to this business's notes, without repeats.
- `GET /groups/:gid/seen` returns `[{ name, first_at, last_at, count }]`.
- A note deleted forever leaves every group.

**Safety on both note share and group share:** `hide_owner` and `no_copy` (booleans) on `PUT …/share`, and in share outputs.

**Signature / draw (`note_sign`).**
- Owner upload: send `sign: true` on `POST /notes/:nid/files` (signed upload) or as a field on `/files/direct`.
- It must be a PNG of 2 MB or less, otherwise 400 `{ code: "bad_sign" }`.
- Without `note_sign`: 403 `{ code: "need_sign", product: "note_sign" }`, and the uploaded file is deleted from Cloudinary.
- The file object gains `sign: true`.
- Then a block `{ id, t: "draw", file_id }`. Saving draw blocks without `note_sign` gives 403 `need_sign`.
- Deleting the file removes its draw blocks. Duplicate leaves draw blocks out. Draw blocks are not part of the preview text.

**Public single note — the read adds:**
- `share.hide_owner` and `share.no_copy`;
- `business: { name: "", logo: "", hidden: true }` when hidden;
- `features: { sign }`;
- `limits.sign_max` (2 MB).

**Guest signature:** multipart field `sign` (one PNG) on `POST …/entries`. It counts as one of the 5 files per entry.
- Without `note_sign`: 403 `need_sign`.
- Not a PNG, or too big: 400 `bad_sign`.
- The entry's file gets `sign: true` and is named `signature-<time>.png`.

**Public group link.**
- `GET /api/public/note-group/:gtoken` returns:
  - `{ group: { name, color, icon }, business, share: { level, set_level, ask_name, hide_owner, no_copy, expired, paused, expires_at }, notes: [{ _id, title, preview, color, updated_date }], me, features }`.
  - `?poll=1` doesn't count as a view.
- `POST /api/public/note-group/:gtoken/seen { name }`.
- A note inside the group uses the same calls as a single note under `/api/public/note-group/:gtoken/notes/:nid` (GET, `/seen`, PUT, `/entries`, `/entries/:eid`).
  - Their GET also returns `group: { name, color, icon }`.
  - A note not in the group (or deleted): 404 `{ code: "off" }`.
- **Access rules:**
  - The group's level, PIN (`x-note-pin`), end date and `ask_name` apply. The note's own share level and PIN are ignored.
  - The note's `allow_files` / `show_entries` still apply.
  - `hide_owner` / `no_copy` are on when the group or the note sets them.
- **Wrong PINs** are counted per group link (10 per 15 minutes, then 429 `pin_wait`), separately from the note links.

**Licenses page rows:**
- `note_storage` rows have `item: "slot-N"` (renewable).
- `note_group` rows have `item: <group id>` (forever). Look the name up from `GET /groups`.


## Prices (Homepage.prices, editable in admin prices)

| Price key | Coins | What it is |
|---|---|---|
| `digital_note` | 10 per year | The plan. Now includes **5 GB** of storage (was 1 GB). The per-file limit stays 20 MB, or the Vercel cap as built. |
| `note_storage` | 15 per year **per pack** | +5 GB per pack. Buy as many packs as wanted. Each pack is its own yearly slot (`item` = slot key), exactly like `att_staff` in license.products.js. Changes the old `note_storage` (+10 GB single) to this pack model. |
| `note_group` | 25, forever, **per group** | `item` = group id. Each group the owner creates is paid once. |
| `note_sign` | 5, forever, once per business | The signature / pen pop-up. |

### Storage packs

```
storage_limit = 5 GB + 5 GB × (number of active note_storage slots)
```

- When a pack slot expires, existing files stay. New uploads are refused while `storage_used` is over the limit.
- Renewing works per slot on the Licenses page, like `att_staff`.
- Show the packs with their own expiry dates on the add-ons page. Allow buying N packs in one go: a quantity stepper, then one purchase per slot, in sequence, through the existing license buy route. If the slot pattern has a bulk route (check how `att_staff` is bought on the web), use it.

## 1. Add-ons page (web)

An **Add-ons** tab in the Digital Note dashboard, the same pattern and style as the other modules' add-ons pages. Look at debt's DebtMore / the restaurant add-ons tab and reuse their components.

It has these cards:

- **Extra storage:** a meter (used / limit), a "+5 GB · 15 coins / year" stepper with a buy button, and the list of owned packs with their expiry dates and a Renew button.
- **Note groups:** "25 coins per group". Owned count, plus a "Create a group" button that goes to the Groups tab.
- **Signature & pen:** "5 coins, forever". A preview of the pad, and Unlock / Owned.
- **Plan:** the `digital_note` yearly status, with Renew.

Buying uses PurchaseModal: preview, price, buy. That means a dialog, not a page.

## 2. Groups (folders of notes) + send a whole group

### Model: NoteGroup

- `business_id`
- `name` (≤ 80), `color`, `icon`, `sort`
- `note_ids` (order matters; a note can be in several groups)
- `share`: `{ token, level: off|view|reply|edit, pin_hash, expires_at, ask_name }`
- `paid`: bool (license `note_group` with `item` = group `_id`)
- `deleted`
- `created_date` / `updated_date`

### Creating and paying

- `POST /groups { name, color }` creates the group, and in the same request **charges 25 coins**.
  - Reuse the license buy service (product `note_group`, `item` = new id) so the coin transaction and history are like other purchases.
  - If the coins are not enough: 402 `{ code: "coins" }` with the balance, and no group is created.
- A deleted group is not refunded. Restoring it within 30 days keeps the payment.

### Owner routes

- `GET /groups`
- `PUT /groups/:gid { name, color, note_ids }`
- `POST /groups/:gid/notes { note_id }` and `DELETE /groups/:gid/notes/:nid`
- `PUT /groups/:gid/share { level, pin, expires_at, ask_name }`
- `POST /groups/:gid/share/new-link`
- `DELETE /groups/:gid` and `POST /groups/:gid/restore`
- `GET /groups/:gid/seen` (who opened the group link)

### Sending a whole group

The group gets its own link: `/n/g/<token>`, with a QR code and a Telegram share. The public page shows the group name, the list of its notes (title, preview, colour), and opens each note inside the group page.

- **Access level:** the group's level applies to every note opened through the group link.
  - The level is the group's, not the note's own share level.
  - `level: off` on the group closes the group link only.
- **Same rules as single-note sharing:** reply/edit with the same entry/edit APIs, plus "Seen by" (per group plus per note).
- **Public API:**
  - `GET /api/public/note-group/:token` (lists the notes)
  - `GET /api/public/note-group/:token/notes/:nid`
  - `PUT /api/public/note-group/:token/notes/:nid` and `POST /api/public/note-group/:token/notes/:nid/entries`

  Reuse the single-note public handlers internally, with the effective level coming from the group. A note that is not in the group returns 404.

## 3. Safety: lock what you send

- **A group link can have a PIN** (4–8 digits, bcrypt), using the same NotePinFail limiter keyed by the group token.
- **Single notes keep their own PIN.**
- **Opening a note through a group link** never asks for that note's own PIN; the group PIN covers it.
- **"Safety" options on both note and group share:**
  - an end date;
  - "hide the owner's name/business";
  - "stop copying" (CSS user-select none plus no print button; this is light protection, so word it honestly as "makes copying harder").
- **Revoke instantly:** "New link" stops the old one.

## 4. Signature / pen pop-up (`note_sign`)

- **New block type `draw`:** `{ id, t: "draw", file_id }`.
  - The drawing is a PNG uploaded like any file (counts toward storage) and shown inline.
  - Allowed in owner notes and in guest entries.
- **The editor's "Sign / Draw" button** opens a pop-up pad with:
  - pen colours (black, blue, red);
  - 2 pen widths;
  - undo and clear;
  - "Signature" mode (a thin line on a baseline, with a "Signed by <name> · date" caption) or "Draw" mode;
  - Save.
- **Guests:** at reply/collect level, guests get a "Sign" button in the reply box that adds a signature PNG to their entry. They don't need an account. Use case: a room rent agreement or a homework sign-off.
- **Locked:** when `note_sign` is not owned, the button shows a lock. For the owner, it opens the unlock dialog (5 coins). For guests, it is hidden.
- **Server:** refuse `draw` blocks or signature uploads when the business has no `note_sign` (403 `code: "need_sign"`).

## Registration

Add the new products to the same places as before:

- **API:** `license.products`, `homepage.defaults` and `homepage.model` prices.
- **Web:** the admin prices catalog and the Licenses page texts.
