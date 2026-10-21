// Receipt looks + the customer display (the screen facing the guest).
//
// Owner, base /api/user/businesses/:id/restaurant
//   GET  /receipt-themes                 { free, paid, price, owned, current }
//   PUT  /receipt-themes/current         { theme }  (a paid one must be bought first)
//   POST /receipt-themes/:theme          buy a paid look (rest_receipt_theme, 45 coins, forever)
//   GET  /pos-themes   PUT /pos-themes/current { theme }   POST /pos-themes/:theme   POS looks (rest_pos_theme, 45 coins, forever)
//
//   GET  /display                        settings + looks (free, paid, price, owned) + add-on state
//   PUT  /display                        { theme, color, header, welcome, thanks, footer, show_logo, slide_seconds, thanks_blur }   needs rest_display
//   POST /display/image                  form-data file + slot=banner (waiting, up to 6) | side (beside the order, up to 3) | thanks (behind "thank you")
//   DELETE /display/image                { slot, index }
//   POST /display/themes/:theme          buy a paid look (rest_display_theme, 75 coins, forever)
//
// Linked POS devices get these with their setup (bootstrap); a change here makes them download it again.
const M = require("./restaurant.models");
const License = require("../../license/license.model");
const { buy, LicenseError } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");

const X = {
  badTheme: "រចនាប័ទ្មមិនត្រឹមត្រូវ",
  locked: "សូមទិញរចនាប័ទ្មនេះជាមុនសិន",
  needDisplay: "សូមបើកមុខងារ “អេក្រង់សម្រាប់ភ្ញៀវ” ជាមុនសិន",
  bannersFull: `រូបភាពអតិបរមា ${M.MAX_BANNERS}`,
  sideFull: `រូបភាពស្លាយខាងចំហៀងអតិបរមា ${M.MAX_SIDE_BANNERS}`,
  bought: "បានទិញរចនាប័ទ្ម!",
  already: "បានទិញរួចហើយ!",
  noCoins: "កាក់មិនគ្រប់គ្រាន់! សូមបញ្ចូលកាក់ជាមុនសិន។",
  busy: "សូមព្យាយាមម្តងទៀត",
};

async function owned(businessId, product, list) {
  const rows = await License.find({ business_id: businessId, product }).select("item").lean();
  return rows.map((r) => r.item).filter((t) => list.includes(t));
}
const bump = (businessId) => M.RestCounter.updateOne({ business_id: businessId }, { $inc: { setup: 1 } }, { upsert: true });

// what a POS / customer display needs (banners as plain URLs)
function displayOf(settings) {
  const d = settings.display || {};
  return {
    theme: d.theme || "clean",
    header: d.header || "",
    welcome: d.welcome || "",
    thanks: d.thanks || "",
    footer: d.footer || "",
    show_logo: d.show_logo !== false,
    banners: (d.banners || []).map((b) => b.url).filter(Boolean),
    side_banners: (d.side_banners || []).map((b) => b.url).filter(Boolean),
    slide_seconds: d.slide_seconds || 6,
    color: d.color || "",
    thanks_bg: d.thanks_bg?.url || "",
    thanks_blur: d.thanks_blur ?? 30,
  };
}

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, withSettings, Bad, MSG, text, bool, withUpload, uploadBuffer, deleteFile } = kit;

  const buyItem = async (req, ctx, product, item) => {
    try {
      return await buy({ customer: req.customer, business: ctx.business, product, item });
    } catch (err) {
      if (err instanceof LicenseError) throw new Bad(X[err.message] || err.message, err.status, err.extra);
      throw err;
    }
  };

  // ---------------- receipt looks ----------------
  const receiptInfo = async (bid, settings) => ({
    free: M.RECEIPT_THEMES_FREE,
    paid: M.RECEIPT_THEMES_PAID,
    price: await priceOf("rest_receipt_theme"),
    owned: await owned(bid, "rest_receipt_theme", M.RECEIPT_THEMES_PAID),
    current: settings.receipt_theme || "classic",
  });

  prop.app.get(
    `${base}/receipt-themes`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      res.json({ success: true, data: await receiptInfo(ctx.business._id, settings) });
    }),
  );

  prop.app.put(
    `${base}/receipt-themes/current`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      const theme = String(req.body?.theme || "");
      if (![...M.RECEIPT_THEMES_FREE, ...M.RECEIPT_THEMES_PAID].includes(theme)) throw new Bad(X.badTheme);
      if (M.RECEIPT_THEMES_PAID.includes(theme) && !(await owned(ctx.business._id, "rest_receipt_theme", [theme])).length) throw new Bad(X.locked, 402, { product: "rest_receipt_theme", item: theme });
      settings.receipt_theme = theme;
      await settings.save();
      res.json({ success: true, data: await receiptInfo(ctx.business._id, settings), message: MSG.saved });
    }),
  );

  prop.app.post(
    `${base}/receipt-themes/:theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!M.RECEIPT_THEMES_PAID.includes(req.params.theme)) throw new Bad(X.badTheme);
      const r = await buyItem(req, ctx, "rest_receipt_theme", req.params.theme);
      res.json({ success: true, data: r.status, item: req.params.theme, charged: r.charged, balance: r.balance, message: X.bought });
    }),
  );

  // ---------------- POS looks ----------------
  const posInfo = async (bid, settings) => ({
    free: M.POS_THEMES_FREE,
    paid: M.POS_THEMES_PAID,
    price: await priceOf("rest_pos_theme"),
    owned: await owned(bid, "rest_pos_theme", M.POS_THEMES_PAID),
    current: settings.pos_theme || "classic",
  });
  prop.app.get(
    `${base}/pos-themes`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      res.json({ success: true, data: await posInfo(ctx.business._id, settings) });
    }),
  );
  prop.app.put(
    `${base}/pos-themes/current`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      const theme = String(req.body?.theme || "");
      if (![...M.POS_THEMES_FREE, ...M.POS_THEMES_PAID].includes(theme)) throw new Bad(X.badTheme);
      if (M.POS_THEMES_PAID.includes(theme) && !(await owned(ctx.business._id, "rest_pos_theme", [theme])).length) throw new Bad(X.locked, 402, { product: "rest_pos_theme", item: theme });
      settings.pos_theme = theme;
      await settings.save();
      await bump(ctx.business._id); // linked POS devices download the new look
      res.json({ success: true, data: await posInfo(ctx.business._id, settings), message: MSG.saved });
    }),
  );
  prop.app.post(
    `${base}/pos-themes/:theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!M.POS_THEMES_PAID.includes(req.params.theme)) throw new Bad(X.badTheme);
      const r = await buyItem(req, ctx, "rest_pos_theme", req.params.theme);
      res.json({ success: true, data: r.status, item: req.params.theme, charged: r.charged, balance: r.balance, message: X.bought });
    }),
  );

  // ---------------- customer display ----------------
  const needDisplay = (ctx) => {
    if (!ctx.addons.rest_display?.active) throw new Bad(X.needDisplay, 402, { product: "rest_display" });
  };
  const displayInfo = async (ctx, settings) => ({
    display: displayOf(settings),
    banners: (settings.display?.banners || []).map((b) => ({ url: b.url })),
    side_banners: (settings.display?.side_banners || []).map((b) => ({ url: b.url })),
    colors: M.DISPLAY_COLORS,
    max_side: M.MAX_SIDE_BANNERS,
    themes: { free: M.DISPLAY_THEMES_FREE, paid: M.DISPLAY_THEMES_PAID, price: await priceOf("rest_display_theme"), owned: await owned(ctx.business._id, "rest_display_theme", M.DISPLAY_THEMES_PAID) },
    active: !!ctx.addons.rest_display?.active,
    max_banners: M.MAX_BANNERS,
  });

  prop.app.get(
    `${base}/display`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      res.json({ success: true, data: await displayInfo(ctx, settings) });
    }),
  );

  prop.app.put(
    `${base}/display`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      needDisplay(ctx);
      const b = req.body || {};
      if (b.theme !== undefined) {
        const theme = String(b.theme);
        if (![...M.DISPLAY_THEMES_FREE, ...M.DISPLAY_THEMES_PAID].includes(theme)) throw new Bad(X.badTheme);
        if (M.DISPLAY_THEMES_PAID.includes(theme) && !(await owned(ctx.business._id, "rest_display_theme", [theme])).length) throw new Bad(X.locked, 402, { product: "rest_display_theme", item: theme });
        settings.set("display.theme", theme);
      }
      for (const [k, max] of [
        ["header", 80],
        ["welcome", 80],
        ["thanks", 80],
        ["footer", 120],
      ]) {
        const v = text(b, k, max);
        if (v !== undefined) settings.set(`display.${k}`, v);
      }
      if (b.show_logo !== undefined) settings.set("display.show_logo", bool(b, "show_logo"));
      if (b.color !== undefined) {
        const c = String(b.color || "");
        if (c && !M.DISPLAY_COLORS.includes(c)) throw new Bad(`${MSG.badValue} (color)`);
        settings.set("display.color", c);
      }
      if (b.thanks_blur !== undefined) {
        const v = Number(b.thanks_blur);
        if (!Number.isFinite(v) || v < 0 || v > 100) throw new Bad(`${MSG.badValue} (thanks_blur)`);
        settings.set("display.thanks_blur", Math.round(v));
      }
      if (b.slide_seconds !== undefined) {
        if (![4, 6, 10, 15].includes(Number(b.slide_seconds))) throw new Bad(`${MSG.badValue} (slide_seconds)`);
        settings.set("display.slide_seconds", Number(b.slide_seconds));
      }
      await settings.save();
      await bump(ctx.business._id);
      res.json({ success: true, data: await displayInfo(ctx, settings), message: MSG.saved });
    }),
  );

  prop.app.post(
    `${base}/display/image`,
    ...guard,
    withUpload,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      needDisplay(ctx);
      if (!req.file) throw new Bad(MSG.noFile);
      const slot = ["banner", "side", "thanks"].includes(req.body?.slot) ? req.body.slot : "banner";
      if (slot === "banner" && (settings.display?.banners || []).length >= M.MAX_BANNERS) throw new Bad(X.bannersFull);
      if (slot === "side" && (settings.display?.side_banners || []).length >= M.MAX_SIDE_BANNERS) throw new Bad(X.sideFull);
      const saved = await uploadBuffer(req.file, "restaurant/display");
      const value = { url: saved.url, public_id: saved.public_id };
      let old = null;
      if (slot === "banner") settings.display.banners.push(value);
      if (slot === "side") settings.display.side_banners.push(value);
      if (slot === "thanks") {
        old = settings.display.thanks_bg?.public_id;
        settings.set("display.thanks_bg", value);
      }
      await settings.save();
      if (old) deleteFile(old).catch(() => {});
      await bump(ctx.business._id);
      res.status(201).json({ success: true, data: await displayInfo(ctx, settings), message: MSG.saved });
    }),
  );

  prop.app.delete(
    `${base}/display/image`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      const slot = ["banner", "side", "thanks"].includes(req.body?.slot) ? req.body.slot : "banner";
      let old = null;
      if (slot === "thanks") {
        old = settings.display?.thanks_bg?.public_id;
        settings.set("display.thanks_bg", { url: "", public_id: "" });
      } else {
        const i = Number(req.body?.index);
        const list = (slot === "side" ? settings.display?.side_banners : settings.display?.banners) || [];
        if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Bad(`${MSG.badValue} (index)`);
        old = list[i].public_id;
        list.splice(i, 1);
      }
      await settings.save();
      await bump(ctx.business._id);
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: await displayInfo(ctx, settings), message: MSG.deleted });
    }),
  );

  prop.app.post(
    `${base}/display/themes/:theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      needDisplay(ctx);
      if (!M.DISPLAY_THEMES_PAID.includes(req.params.theme)) throw new Bad(X.badTheme);
      const r = await buyItem(req, ctx, "rest_display_theme", req.params.theme);
      res.json({ success: true, data: r.status, item: req.params.theme, charged: r.charged, balance: r.balance, message: X.bought });
    }),
  );
};

module.exports.displayOf = displayOf;
