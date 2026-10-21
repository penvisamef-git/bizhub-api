// Payment methods + POS looks (owner, /api/user/businesses/:id/mart):
//   Free: Cash, ABA, KHQR. With mart_payments (forever) the shop makes its own methods — any name, a colour, its own QR picture.
//   POST   /pay-methods { name, color }          PUT /pay-methods/:key { name, color }          DELETE /pay-methods/:key
//   POST   /pay-methods/:key/qr (multipart "file")   DELETE /pay-methods/:key/qr
//   POS looks: 24, "classic" free, each other one bought once (mart_pos_theme, 15 coins)
//   GET /pos-themes      PUT /pos-theme { theme }      POST /pos-themes/:theme/buy
const crypto = require("crypto");
const License = require("../../license/license.model");
const { buy } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");

const MAX_CUSTOM = 20;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, withFile, Bad, MSG, text, M } = kit;
  const T = {
    needPayments: "សូមដោះសោ “វិធីបង់ប្រាក់បន្ថែម” ដើម្បីបង្កើតវិធីបង់ប្រាក់ផ្ទាល់ខ្លួន!",
    tooMany: `វិធីបង់ប្រាក់ផ្ទាល់ខ្លួនបានត្រឹម ${MAX_CUSTOM}។`,
    nameTaken: "មានវិធីបង់ប្រាក់ឈ្មោះនេះរួចហើយ!",
    themeLocked: "សូមទិញរចនា POS នេះជាមុនសិន!",
  };
  const need = (ctx) => {
    if (!ctx.addons.mart_payments?.active) throw new Bad(T.needPayments, 402, { product: "mart_payments" });
  };
  const out = (s) => ({ methods: s.methods, custom_methods: s.custom_methods });
  const readColor = (b) => {
    if (b.color === undefined) return undefined;
    if (b.color && !COLOR_RE.test(String(b.color))) throw new Bad(`${MSG.badValue} (color)`);
    return String(b.color || "").toUpperCase();
  };
  const sameName = (s, name, key) => s.custom_methods.some((x) => x.key !== key && x.name.toLowerCase() === name.toLowerCase());
  const find = (ctx, key) => {
    const row = ctx.settings.custom_methods.find((x) => x.key === key);
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };

  prop.app.post(
    `${base}/pay-methods`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const s = ctx.settings;
      const b = req.body || {};
      const name = text(b, "name", 40, { required: true });
      if (s.custom_methods.length >= MAX_CUSTOM) throw new Bad(T.tooMany);
      if (sameName(s, name)) throw new Bad(T.nameTaken, 409, { code: "name_taken" });
      let key;
      do key = `x_${crypto.randomBytes(3).toString("hex")}`;
      while (s.custom_methods.some((x) => x.key === key));
      s.custom_methods.push({ key, name, color: readColor(b) || "" });
      s.methods = [...new Set([...s.methods, key])]; // on straight away
      await s.save();
      res.status(201).json({ success: true, data: out(s), key, message: MSG.saved });
    }),
  );
  prop.app.put(
    `${base}/pay-methods/:key`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const row = find(ctx, req.params.key);
      const b = req.body || {};
      const name = text(b, "name", 40);
      if (name) {
        if (sameName(ctx.settings, name, row.key)) throw new Bad(T.nameTaken, 409, { code: "name_taken" });
        row.name = name;
      }
      const color = readColor(b);
      if (color !== undefined) row.color = color;
      await ctx.settings.save();
      res.json({ success: true, data: out(ctx.settings), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/pay-methods/:key`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const s = ctx.settings;
      const row = find(ctx, req.params.key);
      if (row.qr?.public_id) deleteFile(row.qr.public_id).catch(() => {});
      s.custom_methods = s.custom_methods.filter((x) => x.key !== row.key);
      s.methods = s.methods.filter((k) => k !== row.key);
      if (!s.methods.length) s.methods = ["cash"];
      await s.save(); // old sales keep the name they were paid with
      res.json({ success: true, data: out(s), message: MSG.deleted });
    }),
  );
  prop.app.post(
    `${base}/pay-methods/:key/qr`,
    ...guard,
    withFile("file"),
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const row = find(ctx, req.params.key);
      if (!req.file) throw new Bad(MSG.noFile);
      const saved = await uploadBuffer(req.file, "mart");
      const old = row.qr?.public_id;
      row.qr = { url: saved.url, public_id: saved.public_id || "" };
      await ctx.settings.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: out(ctx.settings), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/pay-methods/:key/qr`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const row = find(ctx, req.params.key);
      const old = row.qr?.public_id;
      row.qr = { url: "", public_id: "" };
      await ctx.settings.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: out(ctx.settings), message: MSG.deleted });
    }),
  );

  // ---------------- POS looks ----------------
  const ownedThemes = async (bid) => ["classic", ...(await License.find({ business_id: bid, product: "mart_pos_theme", expires_at: null }).select("item").lean()).map((l) => l.item)];
  const themeInfo = async (ctx) => ({ themes: M.POS_THEMES, owned: await ownedThemes(ctx.business._id), current: ctx.settings.pos_theme || "classic", color: ctx.settings.pos_color || "", price: await priceOf("mart_pos_theme") });
  prop.app.get(
    `${base}/pos-themes`,
    ...guard,
    handle(async (req, res) => res.json({ success: true, data: await themeInfo(await ctxOf(req, false)) })),
  );
  prop.app.put(
    `${base}/pos-theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      if (b.theme !== undefined) {
        const theme = String(b.theme || "");
        if (!M.POS_THEMES.includes(theme)) throw new Bad(MSG.badValue);
        if (!(await ownedThemes(ctx.business._id)).includes(theme)) throw new Bad(T.themeLocked, 402, { product: "mart_pos_theme", item: theme });
        ctx.settings.pos_theme = theme;
      }
      if (b.color !== undefined) {
        if (b.color && !COLOR_RE.test(String(b.color))) throw new Bad(`${MSG.badValue} (color)`);
        ctx.settings.pos_color = String(b.color || "").toUpperCase();
      }
      await ctx.settings.save();
      res.json({ success: true, data: await themeInfo(ctx), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${base}/pos-themes/:theme/buy`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const theme = req.params.theme;
      if (!M.POS_THEMES.includes(theme) || theme === "classic") throw new Bad(MSG.badValue);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "mart_pos_theme", item: theme, expect: null });
      ctx.settings.pos_theme = theme;
      await ctx.settings.save();
      res.json({ success: true, data: await themeInfo(ctx), charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );

  // the POS look a device should show (a look no longer owned → classic)
  return { posTheme: async (ctx) => ((ctx.settings.pos_theme || "classic") === "classic" || (await ownedThemes(ctx.business._id)).includes(ctx.settings.pos_theme) ? ctx.settings.pos_theme || "classic" : "classic") };
};
