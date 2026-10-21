// Table ordering (add-on rest_table_order): guests scan the QR on their table, fill a cart and send the order.
//
// Owner, base /api/user/businesses/:id/restaurant/table-order
//   GET    /                        settings + every table's ordering link + the last guest orders
//   PUT    /                        { enabled, lat, lng, radius: 0|50|100|200|500, require_open }
//   POST   /sound   (form-data "file": mp3, m4a, wav, ogg; ≤ 1 MB)      DELETE /sound   alert sound on the POS
//   POST   /tables/:tid/renew       new link for one table (the old QR stops working)
//
// Guest (no login), /api/public/order/:tableToken
//   GET    /                        menu + table + rules (is the table open, must the phone be near the shop)
//   POST   /                        { guest, name, lines: [{ item_id, size, addons: [{ group, name }], qty, note }], lat, lng, accuracy }
//   GET    /mine?guest=<key>        the table's whole bill + orders still waiting for staff (read only)
//
// POS device, header x-device-token
//   POST   /api/pos/guest-orders    { acks: [{ id, order_id, order_number }], open_tables: [tableId] }
//                                   → new guest orders for this device to add to its bills (each goes to one device only)
//
// Prices always come from the menu on the server — never from the guest's phone.
const crypto = require("crypto");
const multer = require("multer");
const M = require("./restaurant.models");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const { rate_limit } = require("../../util/rate_limit");
const License = require("../../license/license.model");
const { buy, LicenseError } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const calc = require("./pos.calc");
const rewards = require("./restaurant.rewards");

const T = {
  needAddon: "សូមដោះសោ “ភ្ញៀវកុម្ម៉ង់ពីតុ” ជាមុនសិន!",
  closed: "ការកុម្ម៉ង់តាមតុមិនទាន់បើកទេ។ សូមហៅបុគ្គលិក។",
  notOpen: "តុនេះមិនទាន់បើកទេ។ សូមហៅបុគ្គលិកឲ្យបើកតុជាមុនសិន។",
  needLocation: "សូមអនុញ្ញាតទីតាំង ដើម្បីកុម្ម៉ង់ (ការពារការកុម្ម៉ង់ពីខាងក្រៅហាង)។",
  tooFar: "អ្នកនៅឆ្ងាយពីហាងពេក ({d} m)។ សូមកុម្ម៉ង់ពេលអ្នកនៅក្នុងហាង។",
  empty: "កន្ត្រកទទេ",
  badItem: "មុខម្ហូបមួយមិនមានទៀតទេ។ សូមផ្ទុកម៉ឺនុយឡើងវិញ។",
  soldOut: "“{n}” អស់ហើយ",
  fewLeft: "“{n}” នៅសល់តែ {q} ប៉ុណ្ណោះ",
  needSize: "សូមជ្រើសទំហំសម្រាប់ “{n}”",
  badAddon: "ជម្រើសបន្ថែមមិនត្រឹមត្រូវសម្រាប់ “{n}”",
  needAddonPick: "សូមជ្រើស “{g}” សម្រាប់ “{n}”",
  tooMany: "មានការកុម្ម៉ង់កំពុងរង់ចាំច្រើនពេកសម្រាប់តុនេះ។ សូមរង់ចាំបន្តិច។",
  badGuest: "សូមបើកទំព័រនេះឡើងវិញ",
  needPlace: "សូមកំណត់ទីតាំងហាងជាមុនសិន (ឬបិទការត្រួតពិនិត្យចម្ងាយ)",
  badSound: "អាចបញ្ចូលបានតែឯកសារសំឡេង mp3, m4a, wav, ogg (អតិបរមា 1MB)",
  noSound: "សូមជ្រើសរើសឯកសារសំឡេង!",
  notFound: "រកមិនឃើញតុ!",
  sent: "បានផ្ញើការកុម្ម៉ង់",
  badPhone: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ",
  badTheme: "រចនាប័ទ្មមិនត្រឹមត្រូវ",
  lockedTheme: "សូមទិញរចនាប័ទ្មនេះជាមុនសិន",
  bought: "បានទិញរចនាប័ទ្ម!",
  already: "បានទិញរួចហើយ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  busy: "សូមព្យាយាមម្តងទៀត",
};
const fill = (s, v) => Object.entries(v).reduce((a, [k, x]) => a.replace(`{${k}}`, x), s);
const RADII = [0, 50, 100, 200, 500];
const MAX_LINES = 40;
const MAX_WAITING = 20; // guest orders not yet picked up by a POS, per table
const CLAIM_SECONDS = 90; // a POS that took an order but never confirmed it: someone else gets it
const TOKEN_RE = /^[A-Za-z0-9]{8,24}$/;
const GUEST_RE = /^[A-Za-z0-9-]{16,40}$/;
const AUDIO = ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/wave", "audio/ogg", "audio/webm"];
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (AUDIO.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});
const newToken = () => crypto.randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 12);
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const str = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

// metres between two places on Earth
function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

const settingsView = (s) => {
  const t = s.table_order || {};
  return { enabled: !!t.enabled, lat: t.lat ?? null, lng: t.lng ?? null, radius: t.radius ?? 100, require_open: t.require_open !== false, theme: t.theme || "fresh", sound: { url: t.sound?.url || "", name: t.sound?.name || "" } };
};
// paid looks: table stickers (qr) and the guest's page (order)
const THEMES = {
  qr: { product: "rest_qr_theme", free: M.QR_THEMES_FREE, paid: M.QR_THEMES_PAID, get: (s) => s.qr_theme || "classic", path: "qr_theme" },
  order: { product: "rest_order_theme", free: M.ORDER_THEMES_FREE, paid: M.ORDER_THEMES_PAID, get: (s) => s.table_order?.theme || "fresh", path: "table_order.theme" },
};
async function themeInfo(bid, settings, kind) {
  const k = THEMES[kind];
  const rows = await License.find({ business_id: bid, product: k.product }).select("item").lean();
  return { free: k.free, paid: k.paid, price: await priceOf(k.product), owned: rows.map((r) => r.item).filter((x) => k.paid.includes(x)), current: k.get(settings) };
}
// the table's bill as the guest sees it: every line (staff's and guests'), no costs or staff details
function billOf(orders) {
  if (!orders.length) return null;
  const sum = (k) => calc.round2(orders.reduce((a, o) => a + (Number(o.totals?.[k]) || 0), 0));
  const lines = orders.flatMap((o) =>
    (o.lines || [])
      .filter((l) => l.status !== "void")
      .map((l) => {
        const full = calc.lineTotal(l);
        return {
          name_km: l.name_km,
          name_en: l.name_en,
          size: l.size,
          addons: (l.addons || []).map((a) => ({ name: a.name })),
          qty: l.qty,
          note: l.note,
          from: l.from || "",
          guest_name: l.guest_name || "",
          full,
          amount: calc.round2(full - calc.lineOff(l)),
          at: l.created_at,
        };
      }),
  );
  return {
    numbers: orders.map((o) => o.number).filter(Boolean),
    lines,
    subtotal: sum("subtotal"),
    discount: sum("discount"),
    service: sum("service"),
    vat: sum("vat"),
    vat_included: !!orders[0].totals?.vat_included,
    total: sum("total"),
    paid: sum("paid"),
  };
}
// what a POS needs to know (null = table ordering is off)
const posInfo = (state, settings) => (state.addons.rest_table_order?.active && settings.table_order?.enabled ? { enabled: true, sound: settings.table_order.sound?.url || "" } : null);
const guestView = (g) => ({
  _id: g._id,
  table_name: g.table_name,
  guest_name: g.guest_name,
  lines: g.lines,
  total: g.total,
  status: g.status === "claimed" ? "new" : g.status,
  order_number: g.order_number,
  created_date: g.created_date,
  accepted_at: g.accepted_at,
});

// is someone sitting at this table (an open bill on the POS)?
async function tableOpen(bid, tableId) {
  const fresh = new Date(Date.now() - 3 * 60 * 1000);
  const [order, device] = await Promise.all([M.RestOrder.exists({ business_id: bid, status: "open", table_id: String(tableId) }), M.RestDevice.exists({ business_id: bid, revoked: false, open_tables: String(tableId), last_seen: { $gte: fresh } })]);
  return !!(order || device);
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, withSettings, licenseState, Bad, MSG, bool, validId, uploadBuffer, deleteFile } = kit;
  const path = `${base}/table-order`;
  // a map coordinate, kept exact (6 decimals ≈ 10 cm)
  const coord = (v, max, key) => {
    if (v === null || v === "") return null;
    const x = Number(v);
    if (!Number.isFinite(x) || Math.abs(x) > max) throw new Bad(`${MSG.badValue} (${key})`);
    return Math.round(x * 1e6) / 1e6;
  };
  const need = (ctx) => {
    if (!ctx.addons.rest_table_order?.active) throw new Bad(T.needAddon, 402, { product: "rest_table_order" });
  };
  // every active table gets a secret link the first time the owner looks
  async function tablesWithTokens(bid) {
    const tables = await M.RestTable.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).select("name zone_id order_token").lean();
    for (const t of tables.filter((x) => !x.order_token)) {
      t.order_token = newToken();
      await M.RestTable.updateOne({ _id: t._id, order_token: "" }, { $set: { order_token: t.order_token } });
    }
    return tables.map((t) => ({ _id: t._id, name: t.name, zone_id: t.zone_id, token: t.order_token }));
  }

  // ===================================== OWNER =====================================
  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      const bid = ctx.business._id;
      const [tables, zones, recent] = await Promise.all([
        tablesWithTokens(bid),
        M.RestZone.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("name").lean(),
        M.RestGuestOrder.find({ business_id: bid }).sort({ created_date: -1 }).limit(30).lean(),
      ]);
      const [qrT, orderT] = await Promise.all([themeInfo(bid, settings, "qr"), themeInfo(bid, settings, "order")]);
      res.json({ success: true, data: { active: !!ctx.addons.rest_table_order?.active, settings: settingsView(settings), tables, zones, recent: recent.map(guestView), themes: { qr: qrT, order: orderT } } });
    }),
  );

  prop.app.put(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      need(ctx);
      const b = req.body || {};
      const cur = settings.table_order || {};
      const next = {
        enabled: bool(b, "enabled") ?? !!cur.enabled,
        require_open: bool(b, "require_open") ?? cur.require_open !== false,
        radius: b.radius === undefined ? (cur.radius ?? 100) : Number(b.radius),
        lat: b.lat === undefined ? (cur.lat ?? null) : coord(b.lat, 90, "lat"),
        lng: b.lng === undefined ? (cur.lng ?? null) : coord(b.lng, 180, "lng"),
      };
      if (!RADII.includes(next.radius)) throw new Bad(`${MSG.badValue} (radius)`);
      if ((next.lat === null) !== (next.lng === null)) throw new Bad(`${MSG.badValue} (lat/lng)`);
      if (next.enabled && next.radius > 0 && next.lat === null) throw new Bad(T.needPlace);
      for (const [k, v] of Object.entries(next)) settings.set(`table_order.${k}`, v);
      await settings.save();
      res.json({ success: true, data: settingsView(settings), message: MSG.saved });
    }),
  );

  prop.app.post(
    `${path}/sound`,
    ...guard,
    (req, res, next) =>
      audioUpload.single("file")(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: T.badSound });
        next();
      }),
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      need(ctx);
      if (!req.file) throw new Bad(T.noSound);
      const saved = await uploadBuffer(req.file, "restaurant/sounds", "video");
      const old = settings.table_order?.sound?.public_id;
      settings.set("table_order.sound", { url: saved.url, public_id: saved.public_id, name: str(req.file.originalname, 80) });
      await settings.save();
      if (old) deleteFile(old, "video").catch(() => {});
      res.status(201).json({ success: true, data: settingsView(settings), message: MSG.saved });
    }),
  );

  prop.app.delete(
    `${path}/sound`,
    ...guard,
    handle(async (req, res) => {
      const { settings } = await withSettings(req, true);
      const old = settings.table_order?.sound?.public_id;
      settings.set("table_order.sound", { url: "", public_id: "", name: "" });
      await settings.save();
      if (old) deleteFile(old, "video").catch(() => {});
      res.json({ success: true, data: settingsView(settings), message: MSG.saved });
    }),
  );

  prop.app.post(
    `${path}/tables/:tid/renew`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.tid)) throw new Bad(MSG.badId);
      const t = await M.RestTable.findOneAndUpdate({ _id: req.params.tid, business_id: ctx.business._id }, { $set: { order_token: newToken() } }, { returnDocument: "after" }).lean();
      if (!t) throw new Bad(T.notFound, 404);
      res.json({ success: true, data: { _id: t._id, name: t.name, zone_id: t.zone_id, token: t.order_token }, message: MSG.saved });
    }),
  );

  // ---- paid looks: PUT /themes/:kind/current { theme } · POST /themes/:kind/:theme (buy) — kind: qr | order ----
  prop.app.put(
    `${path}/themes/:kind/current`,
    ...guard,
    handle(async (req, res) => {
      const k = THEMES[req.params.kind];
      if (!k) throw new Bad(`${MSG.badValue} (kind)`);
      const { ctx, settings } = await withSettings(req, true);
      const theme = String(req.body?.theme || "");
      if (![...k.free, ...k.paid].includes(theme)) throw new Bad(T.badTheme);
      if (k.paid.includes(theme) && !(await License.exists({ business_id: ctx.business._id, product: k.product, item: theme }))) throw new Bad(T.lockedTheme, 402, { product: k.product, item: theme });
      settings.set(k.path, theme);
      await settings.save();
      res.json({ success: true, data: await themeInfo(ctx.business._id, settings, req.params.kind), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${path}/themes/:kind/:theme`,
    ...guard,
    handle(async (req, res) => {
      const k = THEMES[req.params.kind];
      if (!k || !k.paid.includes(req.params.theme)) throw new Bad(T.badTheme);
      const ctx = await ctxOf(req, true);
      let r;
      try {
        r = await buy({ customer: req.customer, business: ctx.business, product: k.product, item: req.params.theme });
      } catch (err) {
        if (err instanceof LicenseError) throw new Bad(T[err.message] || err.message, err.status, err.extra);
        throw err;
      }
      res.json({ success: true, data: r.status, item: req.params.theme, charged: r.charged, balance: r.balance, message: T.bought });
    }),
  );

  // ===================================== GUEST (public) =====================================
  // the table + restaurant behind a link, only when ordering is really open
  async function tableOf(req) {
    const tok = String(req.params.token || "");
    const table = TOKEN_RE.test(tok) ? await M.RestTable.findOne({ order_token: tok, active: true }).lean() : null;
    if (!table) throw new Bad(T.closed, 404);
    const bid = table.business_id;
    const [settings, business, state] = await Promise.all([M.RestSettings.findOne({ business_id: bid }).lean(), Business.findOne({ _id: bid, deleted: false }).select("owner_id status").lean(), licenseState(bid)]);
    const owner = business && (await Customer.findOne({ _id: business.owner_id, deleted: false }).select("status").lean());
    if (!settings || !business?.status || !owner?.status || state.restaurant.locked || !posInfo(state, settings)) throw new Bad(T.closed, 404);
    return { table, settings, bid, state };
  }

  prop.app.get(
    "/api/public/order/:token",
    handle(async (req, res) => {
      const { table, settings, bid, state } = await tableOf(req);
      const [categories, items, groups, open] = await Promise.all([
        M.RestCategory.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("name_km name_en color").lean(),
        M.RestItem.find({ business_id: bid, active: true }).sort({ sort: 1 }).select("category_id name_km name_en description photo price sizes addon_group_ids available track_stock stock").lean(),
        M.RestAddonGroup.find({ business_id: bid }).select("name required min max options").lean(),
        tableOpen(bid, table._id),
      ]);
      const t = settingsView(settings);
      res.set("Cache-Control", "no-store");
      res.json({
        success: true,
        data: {
          restaurant: {
            name_km: settings.name_km,
            name_en: settings.name_en,
            logo: settings.logo?.url || "",
            cover: settings.cover?.url || "",
            color: settings.color,
            currency: settings.currency,
            khr_rate: settings.khr_rate,
            khr_rounding: settings.khr_rounding,
            wifi_name: settings.wifi_name,
          },
          table: { name: table.name },
          theme: t.theme,
          rules: { needs_location: t.radius > 0 && t.lat !== null, radius: t.radius, require_open: t.require_open, points: rewards.rewardsOn(state, settings) },
          open,
          categories,
          items: items.map(({ track_stock, stock, ...i }) => ({ ...i, photo: i.photo?.url || "", available: i.available !== false && !(track_stock && stock <= 0), left: track_stock ? Math.max(0, stock) : null })),
          addon_groups: groups,
        },
      });
    }),
  );

  const orderLimit = rate_limit({ windowMs: 60 * 1000, max: 10, message: "សូមរង់ចាំបន្តិច រួចកុម្ម៉ង់ម្តងទៀត" });
  prop.app.post(
    "/api/public/order/:token",
    orderLimit,
    handle(async (req, res) => {
      const { table, settings, bid, state } = await tableOf(req);
      const b = req.body || {};
      const guest = String(b.guest || "");
      if (!GUEST_RE.test(guest)) throw new Bad(T.badGuest);
      const rules = settingsView(settings);
      // 1) near the shop?
      let dist = null;
      if (rules.radius > 0 && rules.lat !== null) {
        const lat = Number(b.lat);
        const lng = Number(b.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Bad(T.needLocation, 403, { code: "location" });
        dist = distance(lat, lng, rules.lat, rules.lng);
        const slack = Math.min(50, Math.max(0, Number(b.accuracy) || 0)); // phones indoors are a bit off
        if (dist - slack > rules.radius) throw new Bad(fill(T.tooFar, { d: dist }), 403, { code: "far", distance: dist });
      }
      // 2) table open?
      if (rules.require_open && !(await tableOpen(bid, table._id))) throw new Bad(T.notOpen, 409, { code: "not_open" });
      const waiting = await M.RestGuestOrder.countDocuments({ business_id: bid, table_id: String(table._id), status: { $in: ["new", "claimed"] } });
      if (waiting >= MAX_WAITING) throw new Bad(T.tooMany, 429);
      // 3) the cart, priced from the menu
      const raw = Array.isArray(b.lines) ? b.lines.slice(0, MAX_LINES + 1) : [];
      if (!raw.length) throw new Bad(T.empty);
      if (raw.length > MAX_LINES) throw new Bad(`${MSG.badValue} (lines)`);
      const ids = [...new Set(raw.map((l) => String(l?.item_id || "")))];
      if (ids.some((id) => !validId(id))) throw new Bad(T.badItem);
      const [items, groups] = await Promise.all([M.RestItem.find({ _id: { $in: ids }, business_id: bid, active: true }).lean(), M.RestAddonGroup.find({ business_id: bid }).lean()]);
      const itemOf = new Map(items.map((i) => [String(i._id), i]));
      const groupOf = new Map(groups.map((g) => [String(g._id), g]));
      const wanted = {};
      const lines = raw.map((l) => {
        const it = itemOf.get(String(l.item_id));
        if (!it) throw new Bad(T.badItem);
        const name = it.name_en || it.name_km;
        if (it.available === false || (it.track_stock && it.stock <= 0)) throw new Bad(fill(T.soldOut, { n: name }));
        const qty = Math.round(Number(l.qty));
        if (!Number.isFinite(qty) || qty < 1 || qty > 50) throw new Bad(`${MSG.badValue} (qty)`);
        wanted[it._id] = (wanted[it._id] || 0) + qty;
        if (it.track_stock && wanted[it._id] > it.stock) throw new Bad(fill(T.fewLeft, { n: name, q: it.stock }));
        let size = null;
        if (it.sizes?.length) {
          size = it.sizes.find((s) => s.name === l.size);
          if (!size) throw new Bad(fill(T.needSize, { n: name }));
        }
        // add-ons: only the item's own groups, within each group's limits
        const picked = Array.isArray(l.addons) ? l.addons.slice(0, 30) : [];
        const addons = [];
        const count = {};
        for (const a of picked) {
          const g = groupOf.get(String(a?.group || ""));
          const opt = g && (it.addon_group_ids || []).map(String).includes(String(g._id)) && g.options.find((o) => o.name === a.name);
          if (!opt) throw new Bad(fill(T.badAddon, { n: name }));
          count[g._id] = (count[g._id] || 0) + 1;
          addons.push({ group: g.name, name: opt.name, price: Number(opt.price) || 0 });
        }
        for (const gid of it.addon_group_ids || []) {
          const g = groupOf.get(String(gid));
          if (!g) continue;
          const c = count[g._id] || 0;
          const min = g.required ? Math.max(1, g.min || 1) : g.min || 0;
          if (c < min) throw new Bad(fill(T.needAddonPick, { g: g.name, n: name }));
          if (g.max && c > g.max) throw new Bad(fill(T.badAddon, { n: name }));
        }
        const unit = size ? Number(size.price) : Number(it.price);
        return { item_id: String(it._id), name_km: it.name_km || "", name_en: it.name_en || "", size: size?.name || "", unit_price: unit, addons, qty, note: str(l.note, 120), station_id: String(it.station_id || ""), cost: Number(it.cost) || 0 };
      });
      const total = round2(lines.reduce((s, l) => s + (l.unit_price + l.addons.reduce((a, x) => a + x.price, 0)) * l.qty, 0));
      // reward points: the guest's phone finds (or makes) their member card; the POS puts it on the bill
      let member;
      const phone = b.phone ? rewards.normPhone(b.phone) : "";
      if (b.phone && !phone) throw new Bad(T.badPhone);
      if (phone && rewards.rewardsOn(state, settings)) {
        const m =
          (await M.RestMember.findOne({ business_id: bid, phone }).lean()) ||
          (await M.RestMember.findOneAndUpdate({ business_id: bid, phone }, { $setOnInsert: { name: str(b.name, 60), token: rewards.newToken(), points: 0 } }, { upsert: true, returnDocument: "after" }).lean());
        member = { id: String(m._id), name: m.name || str(b.name, 60), phone: rewards.maskPhone(phone) };
      }
      const doc = await M.RestGuestOrder.create({ business_id: bid, table_id: String(table._id), table_name: table.name, guest_key: guest, guest_name: str(b.name, 40), lines, total, distance: dist, member });
      res.status(201).json({ success: true, data: guestView(doc.toObject()), message: T.sent });
    }),
  );

  prop.app.get(
    "/api/public/order/:token/mine",
    handle(async (req, res) => {
      const { table, bid } = await tableOf(req);
      const guest = String(req.query.guest || "");
      if (!GUEST_RE.test(guest)) throw new Bad(T.badGuest);
      const since = new Date(Date.now() - 12 * 3600 * 1000);
      const tid = String(table._id);
      const [rows, waiting, openOrders, open] = await Promise.all([
        M.RestGuestOrder.find({ business_id: bid, table_id: tid, guest_key: guest, created_date: { $gte: since } })
          .sort({ created_date: -1 })
          .limit(30)
          .lean(),
        M.RestGuestOrder.find({ business_id: bid, table_id: tid, status: { $in: ["new", "claimed"] }, created_date: { $gte: since } })
          .sort({ created_date: 1 })
          .limit(30)
          .lean(),
        M.RestOrder.find({ business_id: bid, table_id: tid, status: "open" }).sort({ opened_at: 1 }).lean(),
        tableOpen(bid, table._id),
      ]);
      res.set("Cache-Control", "no-store");
      // orders: this phone's · waiting: everyone's at this table not on the bill yet · bill: the whole table bill (staff + guests)
      res.json({ success: true, data: { orders: rows.map(guestView), waiting: waiting.map((g) => ({ ...guestView(g), mine: g.guest_key === guest })), bill: billOf(openOrders), open } });
    }),
  );

  // ===================================== POS DEVICE =====================================
  prop.app.post(
    "/api/pos/guest-orders",
    prop.api_auth,
    handle(async (req, res) => {
      const { device, business, state, settings } = await kit.deviceOf(req);
      const bid = business._id;
      const b = req.body || {};
      const now = new Date();
      // tables with an open bill on this device (so guests there may order)
      device.open_tables = (Array.isArray(b.open_tables) ? b.open_tables : [])
        .map((x) => str(x, 40))
        .filter(Boolean)
        .slice(0, 500);
      device.last_seen = now;
      await device.save();
      // orders this device has put on a bill
      const acks = (Array.isArray(b.acks) ? b.acks : []).slice(0, 100).filter((a) => validId(a?.id));
      for (const a of acks) {
        await M.RestGuestOrder.updateOne(
          { _id: a.id, business_id: bid, status: { $in: ["claimed", "new"] } },
          { $set: { status: "accepted", accepted_at: now, order_id: str(a.order_id, 40), order_number: str(a.order_number, 20), claimed_by: device._id } },
        );
      }
      const info = posInfo(state, settings);
      if (!info) return res.json({ success: true, data: { orders: [], table_order: null, acked: acks.map((a) => a.id) } });
      // taken by a POS that went quiet → back in the queue
      await M.RestGuestOrder.updateMany({ business_id: bid, status: "claimed", claimed_at: { $lt: new Date(now - CLAIM_SECONDS * 1000) }, claimed_by: { $ne: device._id } }, { $set: { status: "new", claimed_by: null, claimed_at: null } });
      // each new order goes to exactly one device
      for (let i = 0; i < 20; i++) {
        const got = await M.RestGuestOrder.findOneAndUpdate({ business_id: bid, status: "new" }, { $set: { status: "claimed", claimed_by: device._id, claimed_at: now } }, { sort: { created_date: 1 } });
        if (!got) break;
      }
      const mine = await M.RestGuestOrder.find({ business_id: bid, status: "claimed", claimed_by: device._id }).sort({ created_date: 1 }).limit(50).lean();
      res.json({
        success: true,
        data: {
          orders: mine.map((g) => ({ _id: g._id, table_id: g.table_id, table_name: g.table_name, guest_name: g.guest_name, member: g.member?.id ? g.member : null, lines: g.lines, created_date: g.created_date })),
          table_order: info,
          acked: acks.map((a) => a.id),
        },
      });
    }),
  );
};

module.exports.posInfo = posInfo;
module.exports.distance = distance;
