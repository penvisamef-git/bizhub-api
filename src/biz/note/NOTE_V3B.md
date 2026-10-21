# Digital Note v3b: more requests from Mr Black (on top of NOTE_V3.md)

## Changes (API, as built)

- **A. Note groups:** `GET /notes/:nid` returns `data.group_ids` (paid, non-deleted groups that contain the note) next to `data.note`.
- **B. Group search:** `GET /groups?q=` matches the name, case-insensitive. It combines with `deleted=1`.
- **C. Media kinds:**
  - The `kind` on media rows, the `?kind=` filter and the `totals.kinds` keys are `image, video, audio, pdf, word, excel, slides, text, zip, sign, other`, in that order. All keys are always present.
  - The kind is worked out on read from mime and name, so there is no migration. Signatures are `sign`, not `image`.
- **E. Page themes:**
  - **Product:** `note_theme` (item = theme key, 3 coins, forever).
  - **Keys:** read from `bizhub-api/src/biz/note/noteThemes.json`, the copy of the web's `bizhub/src/note/noteThemes.json` (shape `{ note, free, themes: [{ key, en, km, accent, tags }] }`). "default" is free. `noteThemes.fallback.json` is used only if the copy is missing. **Re-copy that file when themes are added.**
  - **Book read:** `GET ""` has `themes: { owned: [keys], price, keys: [paid keys] }` and `prices.note_theme`.
  - **Buying:** `POST /themes/unlock { key }`.
    - Returns 201 `{ data: { key, owned }, charged, balance }`, or 200 `already: true` (charged 0).
    - Errors: 402 `code: "coins"`, 400 `bad_theme`.
    - Double clicks are safe.
  - **Saving:** `PUT /notes/:nid { theme: { key?, color? } }` and `PUT /groups/:gid { theme }`.
    - The `color` is "" or `#RRGGBB`, stored uppercase. A missing field keeps the current value.
    - Errors:
      - 400 `bad_theme` for an unknown key or a bad colour;
      - 403 `{ code: "need_theme", product: "note_theme", item: key }` for a NEW locked key.

      A key the note or group already has stays saveable, even after its license is gone, and the colour can still change.
  - **Outputs:** `theme: { key, color }` on notes, groups, the public note read (a group link gives the GROUP's theme) and the public group read.


## A. In the note editor: add to / change groups

- The note's top bar gets a "Groups" button. It shows chips for the groups the note is in, and opens a picker: search, tick or untick groups, and a link to create a new group.
- It uses the existing `POST /groups/:gid/notes` and `DELETE /groups/:gid/notes/:nid`.
- `GET /notes/:nid` should also return `group_ids`, i.e. the groups that contain the note.

## B. Groups tab: search

- A search box filters groups by name: client side, or `GET /groups?q=`.
- It works for hundreds of groups.

## C. Media: file type filter

The `kind` filter values are:

`all | image | video | audio | pdf | word | excel | slides | text | zip | sign | other`

- Map each one from mime type and file extension:
  - word: doc, docx, odt, rtf
  - excel: xls, xlsx, ods, csv
  - slides: ppt, pptx, odp
  - text: txt, md
  - zip: zip, rar, 7z
- `totals.kinds` uses these keys.
- The web shows filter chips with counts and a matching icon per type.
- Existing files store `kind` as image | pdf | doc | other. Work the fine type out on read, from mime and name, so no migration is needed.

## D. Bug: deleting a note shows the confirm dialog twice and freezes the screen

Find the cause: probably a double trigger (a menu item plus a button, or a confirm opening another confirm) and an overlay or scroll lock that is never released. Fix it.

Check every Confirm in the Digital Note dashboard for the same problem: delete note, delete forever, delete group, delete file, delete entry, and the Media bulk delete.

## E. Public page themes (`note_theme`, 3 coins per theme, forever, per business, `item` = theme key)

24 distinct, designed themes for the public note page and the public group page. Each one changes:

- the page background (gradients, patterns, paper, dark modes);
- the card style;
- the font pairing (system and serif families plus the existing Kantumruy for Khmer);
- headings, buttons, reply bubbles, checkbox and quote styles;
- the top bar.

Each theme also takes an **accent colour** from a colour panel: 12 preset swatches plus a custom colour picker. The theme uses that accent.

### Free and paid themes

- **Free:** the current look, called "Default", which keeps working without coins.
- **Paid:** the 24 themes cost 3 coins each, once, forever, per business.

### Theme list

| Key | Name |
|---|---|
| paper | Paper |
| linen | Linen |
| notebook | Notebook |
| chalk | Chalkboard |
| midnight | Midnight |
| ocean | Ocean |
| forest | Forest |
| sunset | Sunset |
| lotus | Lotus |
| temple | Angkor Stone (generic stone texture, no real logos) |
| mango | Mango |
| mint | Mint |
| lavender | Lavender |
| coffee | Coffee |
| newsprint | Newsprint |
| blueprint | Blueprint |
| neon | Neon |
| glass | Glass |
| kraft | Kraft |
| sakura | Sakura |
| corporate | Corporate |
| school | School |
| wedding | Wedding |
| festival | Festival |

Make them truly different from each other.

### Data and API

- **Data:** `note.theme = { key, color }` and `group.theme = { key, color }`.
  - The default is `{ key: "default", color: "" }`, where an empty colour means the business or default accent.
  - A group link shows the group's theme for every note opened through it. A single-note link uses the note's theme.
- **Unlocking:** `POST /themes/unlock { key }` buys `note_theme` with `item` = key. It returns 402 `coins` on failure.
- **Saving a theme:**
  - `PUT /notes/:nid { theme }` and `PUT /groups/:gid { theme }`.
  - Saving a locked theme key fails with 403 `{ code: "need_theme", item: key }`.
  - Changing the colour is always free.
  - A theme saved before a license was removed is kept; only new locked keys are refused.
- **Reads:**
  - `GET ""` returns `themes: { owned: [keys], price }`.
  - The public reads return `theme: { key, color }`.

### Web

- **Theme picker:** a "Look" button next to Share, for notes and for groups. It opens a gallery with live mini previews of the note's real content in each theme, plus the colour panel.
- **Previewing and buying:** tapping a locked theme opens the existing unlock or purchase dialog with a big preview; there is no page scrolling. Owned themes apply at once.
- **Add-ons page:** add a "Page themes" card.
- **Licenses page:** show theme names for `note_theme` items.
- **Where the CSS lives:** themes are CSS classes on the public page root (`.np-th-<key>`), with the accent passed as CSS variables (`--acc`, `--acc-dark`, `--acc-soft` via `shade()`).
- **Shared theme list:** keep the theme list in one shared JS/JSON module (key, en/km names, tags), so the API can import the keys. Put it at `bizhub/src/note/noteThemes.json`, and copy it to `bizhub-api/src/biz/note/noteThemes.json`.
