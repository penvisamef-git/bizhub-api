# Digital Note — custom links (`note_link`, 10 coins once, forever)

The owner's own words in a link: `/n/<slug>` for a note and `/n/g/<slug>` for a group. Random token links keep working.

## Rules

- **Allowed characters:** 3–40 of `a-z 0-9 -`, with no leading, trailing or double `-`.
- **How input is cleaned:** it is made lowercase, spaces and `_` and `.` become `-`, and Khmer letters and symbols are dropped (`dropped: true`).
- **Reserved words** can't be used: g, n, new, edit, admin, api, login, app, help, bizhub, … (`RESERVED` in `note.shared.js`).

## Uniqueness

There is **one namespace across every note and group of every business**.

- The `NoteSlug` collection has a unique `slug`, so two saves at once can't both win.
- There are also unique partial indexes on `share.slug` in `Note` and `NoteGroup`.
- A slug that equals an existing random token is also taken.
- A soft-deleted note or group keeps its slug, so it can be restored. Delete forever frees it.
- `New link` removes the slug as well, because its job is to kill every old link.

## Owner API

Base path: `/api/user/businesses/:id/note`.

- **`GET /link-check?slug=&kind=note|group&id=`** returns `{ slug, ok, reason: ""|mine|taken|reserved|short|bad, dropped, suggestions[3], owned }`.
  - It works without the license.
  - It is rate limited to 60 per minute.
- **`PUT /notes/:nid/share { slug }`** and **`PUT /groups/:gid/share { slug }`**:
  - setting or changing a slug needs `note_link`, otherwise 403 `need_link`;
  - `""` removes it, which is free;
  - keeping the same slug is free;
  - errors: 409 `slug_taken` (with `suggestions`), 400 `slug_reserved` / `slug_short` / `slug_bad`.
- **`POST /link/unlock`** buys `note_link`. Not enough coins gives 402 `coins`.
- **`GET ""`** includes `link: { owned, price }`, `prices.note_link` and `addons.note_link`.
- **Share reads** (notes, list rows and groups) include `slug`, plus `path` (the slug path when one is set) and `token_path` (always the random link).

## Public

- `/api/public/note/:token` and `/api/public/note-group/:gtoken` accept the random token OR the slug. The token wins.
- **Wrong PINs** are counted per note or group (`n:<id>` / `g:<id>`), so the random link and the custom link share one counter.
