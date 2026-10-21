# BizHub API

Node.js + Express + MongoDB (Mongoose) + Cloudinary + JWT.

## Setup

```bash
npm install
cp .env.example .env      # fill in Mongo, API key, JWT secret, Cloudinary, seed admin
npm run seed              # API key record + first super admin + homepage defaults (safe to re-run)
npm run dev               # http://localhost:8086
```

## Folder structure

```
src/
  homepage/          website content: contact, coins, payment methods, app links, services, text   ← done
  user/              client sign-up (public)                                                         ← next
  biz_category/      business categories                                                              ← later
  biz/
    digital_name_card/
    restaurant/
    ...
  v1/admin/          core: auth, session, users (BizHub team), activity log, upload
  v1/public/         public route prefix (/api/public)
  util/              db, auth middleware, permission, log, cloudinary, helpers
scripts/seed.js
```

## Headers

Every admin request: `x-api-key: <API_AUTH_KEY>`. After login also: `Authorization: Bearer <access_token>`.
Public routes (`/api/public/...`) need neither.

## Response format

```json
{ "success": true, "data": {}, "message": "...", "pagination": { "total": 0, "totalPages": 0, "currentPage": 1, "pageSize": 10 } }
```

## Roles (BizHub team)

| Role | Can do |
|---|---|
| Super admin (`is_super_admin`) | Everything, including website (homepage) settings |
| `អ្នកគ្រប់គ្រងប្រព័ន្ធ` (admin) | Users, activity log, upload |
| `បុគ្គលិក` (staff) | View only |

## Homepage — `src/homepage`

| Method | Path | Who |
|---|---|---|
| GET | `/api/public/homepage` | anyone (the website), cached 60 s |
| GET | `/api/admin/homepage` | super admin |
| PUT | `/api/admin/homepage` | super admin |

PUT body: any of these sections. Only the sections you send change.

```json
{
  "contact": { "phones": ["010 288 105", "089 288 105"], "telegram": "089 288 105", "telegram_url": "https://t.me/+85589288105",
               "email": "bizhubcambodia@gmail.com", "address": "", "facebook_url": "", "map_url": "" },
  "coin": { "pack_coins": 100, "pack_price_usd": 10, "signup_bonus": 100 },
  "payment_methods": ["KHQR", "ABA", "Card"],
  "app": { "status": "coming_soon", "android_url": "", "ios_url": "" },
  "services": [{ "key": "namecard", "enabled": true, "coming_soon": false, "sort_order": 0 }],
  "texts": { "en": { "heroSub": "..." }, "km": { "heroSub": "..." } }
}
```

- `services[].key`: `namecard | restaurant | mart | guest | warehouse | attend`
- `texts.en` / `texts.km` replace that language's overrides. Keys are the website text keys
  (bizhub web: `src/homepage/content.js`); a key that is not sent uses the default text.
- Links must start with `http://` or `https://`. Every change is written to the activity log (`homepage`).

## Core endpoints — `/api/admin`

- Auth: `POST /auth/login` (`client: "app"` = the BizHub app's own session, so the website stays logged in), `GET /auth/me`, `POST /auth/logout`, `PUT /auth/change-password`
- QR login (super admin): `POST /auth/login-qr` → `{ id, code, seconds }`, `GET /auth/login-qr/:id` → `{ state }`
- Users: `POST/GET /users`, `GET /users-all`, `GET /users-roles`, `GET/PUT/DELETE /users/:id`, `PUT /users/reset-password/:id`, `PUT /users/restore/:id`
- Session / log: `GET /session`, `DELETE /session/:id`, `GET /activity_log?category=homepage`, `GET /activity_log/category-all`
- Upload: `POST /upload` (form-data `files`, `folder` = `homepage | setting | others`), `GET /upload/signature`, `DELETE /upload`

## Log in with a QR code (website → BizHub app)

- Owner: `POST /api/user/login-qr` → `{ id, code, seconds: 60 }` (a new code stops the older one), `GET /api/user/login-qr/:id` → `{ state: waiting | used | expired }`
- App: `POST /api/user/login-qr/scan { code, device? }` (no login) → `{ account_type: customer | team, data }` — same data as the normal login.
- The QR holds `bizhub-login:<code>`. A code works once, for 60 seconds; only its hash is stored (`loginqrs`, removed after 10 minutes).

## List query (all list routes)

`page`, `limit` (max 200), `sort`, `order`, `q`, `q_key`, `q_id`, `q_key_id`, `includeDeleted`
