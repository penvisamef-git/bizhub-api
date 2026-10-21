// Mini Mart POS (/pos/mini-mart): cashiers with PINs, paired devices, payment QR, logo + shop details.
// Owner (base /api/user/businesses/:id/mart):
//   GET/POST /staff   PUT/DELETE /staff/:rid      (2 cashiers free)
//   POST /pos/pair-code   GET /pos/devices   DELETE /pos/devices/:did
//   POST/DELETE /pay-qr (multipart "file")   POST/DELETE /logo   PUT /profile { name, phone, address }
// Device (x-api-key + x-mart-device [+ x-mart-session]):
//   POST /api/martpos/pair { code, name }   → { token }   (kept on the device)
//   POST /api/martpos/login { pin }         → { session, staff }
//   GET  /api/martpos/boot                  everything the sale screen needs (products, categories, settings)
//   GET  /api/martpos/sync                  PIN checks for offline login + today's sales
const crypto = require("crypto");
const { rate_limit } = require("../../util/rate_limit");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");
const License = require("../../license/license.model");
const { buy } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");

const SESSION_HOURS = 14;

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, posCtx, withFile, Bad, MSG, text, bool, oneOf, validId, localDay, sha, jwt, unitsOf, M, Business } = kit;
  const T = {
    badPin: "PIN ត្រូវមាន 4 ខ្ទង់!",
    pinTaken: "PIN នេះមានបុគ្គលិកផ្សេងប្រើហើយ!",
    staffLimit: "អ្នកគិតលុយឥតគិតថ្លៃមានតែ 2 នាក់។ សូមដោះសោ “អ្នកគិតលុយមិនកំណត់”។",
    themeLocked: "សូមទិញគំរូវិក្កយបត្រនេះជាមុនសិន!",
    badCode: "លេខកូដមិនត្រឹមត្រូវ ឬផុតកំណត់ហើយ!",
    badLogin: "PIN មិនត្រឹមត្រូវ!",
  };
  const pinCheck = (pin) => {
    const salt = crypto.randomBytes(8).toString("hex");
    return { pin_salt: salt, pin_check: crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex") };
  };
  const pinKey = (bid, pin) =>
    crypto
      .createHmac("sha256", process.env.JWT_SECRET || "bizhub")
      .update(`mart:${bid}:${pin}`)
      .digest("hex");
  const staffOut = (s) => ({ _id: s._id, name: s.name, role: s.role, phone: s.phone, active: s.active, created_date: s.created_date });
  const pinOf = (b, required) => {
    if (b.pin === undefined || b.pin === "") {
      if (required) throw new Bad(T.badPin, 400, { code: "bad_pin" });
      return undefined;
    }
    if (!/^\d{4}$/.test(String(b.pin))) throw new Bad(T.badPin, 400, { code: "bad_pin" });
    return String(b.pin);
  };

  // ---------------- owner: cashiers ----------------
  prop.app.get(
    `${base}/staff`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const rows = await M.MartStaff.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 }).lean();
      res.json({ success: true, data: rows.map(staffOut), limit: ctx.limits.staff });
    }),
  );
  prop.app.post(
    `${base}/staff`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const bid = ctx.business._id;
      const b = req.body || {};
      if ((await M.MartStaff.countDocuments({ business_id: bid })) >= ctx.limits.staff) throw new Bad(T.staffLimit, 402, { code: "staff_limit", product: "mart_staff", limit: ctx.limits.staff });
      const pin = pinOf(b, true);
      if (await M.MartStaff.exists({ business_id: bid, pin_key: pinKey(bid, pin) })) throw new Bad(T.pinTaken, 409, { code: "pin_taken" });
      try {
        const row = await M.MartStaff.create({
          business_id: bid,
          name: text(b, "name", 60, { required: true }),
          role: oneOf(b, "role", M.STAFF_ROLES) || "cashier",
          phone: text(b, "phone", 30) || "",
          pin_key: pinKey(bid, pin),
          ...pinCheck(pin),
          active: bool(b, "active") !== false,
        });
        res.status(201).json({ success: true, data: staffOut(row), message: MSG.saved });
      } catch (err) {
        if (err.code === 11000) throw new Bad(T.pinTaken, 409, { code: "pin_taken" });
        throw err;
      }
    }),
  );
  prop.app.put(
    `${base}/staff/:rid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      const row = await M.MartStaff.findOne({ _id: req.params.rid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      const b = req.body || {};
      const name = text(b, "name", 60);
      if (name) row.name = name;
      const role = oneOf(b, "role", M.STAFF_ROLES);
      const roleChanged = role && role !== row.role;
      if (role) row.role = role;
      const phone = text(b, "phone", 30);
      if (phone !== undefined) row.phone = phone;
      const active = bool(b, "active");
      if (active !== undefined) row.active = active;
      const pin = pinOf(b, false);
      if (pin) {
        if (await M.MartStaff.exists({ business_id: ctx.business._id, pin_key: pinKey(ctx.business._id, pin), _id: { $ne: row._id } })) throw new Bad(T.pinTaken, 409, { code: "pin_taken" });
        row.pin_key = pinKey(ctx.business._id, pin);
        Object.assign(row, pinCheck(pin));
      }
      if (pin || active === false || roleChanged) row.pin_v = (row.pin_v || 0) + 1; // log them out
      try {
        await row.save();
      } catch (err) {
        if (err.code === 11000) throw new Bad(T.pinTaken, 409, { code: "pin_taken" });
        throw err;
      }
      res.json({ success: true, data: staffOut(row), message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/staff/:rid`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      const r = await M.MartStaff.deleteOne({ _id: req.params.rid, business_id: ctx.business._id });
      if (!r.deletedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, message: MSG.deleted });
    }),
  );

  // ---------------- owner: devices ----------------
  prop.app.post(
    `${base}/pos/pair-code`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      ctx.settings.pair_code = code;
      ctx.settings.pair_expires = new Date(Date.now() + 10 * 60000);
      await ctx.settings.save();
      res.json({ success: true, data: { code, expires: ctx.settings.pair_expires } });
    }),
  );
  prop.app.get(
    `${base}/pos/devices`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: await M.MartDevice.find({ business_id: ctx.business._id, revoked: false }).sort({ created_date: -1 }).select("name last_seen created_date").lean() });
    }),
  );
  prop.app.delete(
    `${base}/pos/devices/:did`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.did)) throw new Bad(MSG.badId);
      const r = await M.MartDevice.updateOne({ _id: req.params.did, business_id: ctx.business._id }, { $set: { revoked: true } });
      if (!r.matchedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, message: MSG.deleted });
    }),
  );

  // ---------------- owner: payment QR, logo, shop details ----------------
  prop.app.post(
    `${base}/pay-qr`,
    ...guard,
    withFile("file"),
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!req.file) throw new Bad(MSG.noFile);
      const saved = await uploadBuffer(req.file, "mart");
      const old = ctx.settings.pay_qr?.public_id;
      ctx.settings.pay_qr = { url: saved.url, public_id: saved.public_id || "" };
      await ctx.settings.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: ctx.settings.pay_qr, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/pay-qr`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const old = ctx.settings.pay_qr?.public_id;
      ctx.settings.pay_qr = { url: "", public_id: "" };
      await ctx.settings.save();
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, message: MSG.deleted });
    }),
  );
  prop.app.post(
    `${base}/logo`,
    ...guard,
    withFile("file"),
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!req.file) throw new Bad(MSG.noFile);
      const saved = await uploadBuffer(req.file, "mart");
      const old = ctx.settings.logo_public_id;
      ctx.business.logo_url = saved.url;
      ctx.settings.logo_public_id = saved.public_id || "";
      await Promise.all([ctx.business.save(), ctx.settings.save()]);
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, data: { url: saved.url }, message: MSG.saved });
    }),
  );
  prop.app.delete(
    `${base}/logo`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const old = ctx.settings.logo_public_id;
      ctx.business.logo_url = "";
      ctx.settings.logo_public_id = "";
      await Promise.all([ctx.business.save(), ctx.settings.save()]);
      if (old) deleteFile(old).catch(() => {});
      res.json({ success: true, message: MSG.deleted });
    }),
  );
  prop.app.put(
    `${base}/profile`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      const name = text(b, "name", 100);
      if (name !== undefined) {
        if (!name) throw new Bad(`${MSG.required}: name`);
        ctx.business.name = name;
      }
      const phone = text(b, "phone", 30);
      if (phone !== undefined) ctx.business.phone = phone;
      const address = text(b, "address", 300);
      if (address !== undefined) ctx.business.address = address;
      await ctx.business.save();
      res.json({ success: true, data: ctx.business, message: MSG.saved });
    }),
  );

  // ---------------- owner: printing (mart_printer) + receipt templates (mart_print_theme) ----------------
  const ownedThemes = async (bid) => ["classic", ...(await License.find({ business_id: bid, product: "mart_print_theme", expires_at: null }).select("item").lean()).map((l) => l.item)];
  const printInfo = async (ctx) => ({
    on: !!ctx.addons.mart_printer?.active,
    themes: M.PRINT_THEMES,
    owned: await ownedThemes(ctx.business._id),
    current: ctx.settings.print_theme || "classic",
    size: ctx.settings.print_size || "80",
    auto: !!ctx.settings.print_auto,
    price: await priceOf("mart_print_theme"),
    addon_price: await priceOf("mart_printer"),
  });
  prop.app.get(
    `${base}/print`,
    ...guard,
    handle(async (req, res) => res.json({ success: true, data: await printInfo(await ctxOf(req, false)) })),
  );
  prop.app.post(
    `${base}/print-themes/:theme/buy`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const theme = req.params.theme;
      if (!M.PRINT_THEMES.includes(theme) || theme === "classic") throw new Bad(MSG.badValue);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "mart_print_theme", item: theme, expect: null });
      ctx.settings.print_theme = theme;
      await ctx.settings.save();
      res.json({ success: true, data: await printInfo(ctx), charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );
  // { theme?, size?, auto? }
  prop.app.put(
    `${base}/print`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      if (b.theme !== undefined) {
        const theme = String(b.theme);
        if (!M.PRINT_THEMES.includes(theme)) throw new Bad(MSG.badValue);
        if (!(await ownedThemes(ctx.business._id)).includes(theme)) throw new Bad(T.themeLocked, 402, { product: "mart_print_theme", item: theme });
        ctx.settings.print_theme = theme;
      }
      if (b.size !== undefined) {
        if (!["80", "58"].includes(String(b.size))) throw new Bad(`${MSG.badValue} (size)`);
        ctx.settings.print_size = String(b.size);
      }
      if (b.auto !== undefined) ctx.settings.print_auto = !!b.auto;
      await ctx.settings.save();
      res.json({ success: true, data: await printInfo(ctx), message: MSG.saved });
    }),
  );

  // ---------------- device ----------------
  const pairLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 15 });
  const loginLimit = rate_limit({ windowMs: 5 * 60 * 1000, max: 30 });

  prop.app.post(
    "/api/martpos/pair",
    prop.api_auth,
    pairLimit,
    handle(async (req, res) => {
      const code = String(req.body?.code || "").trim();
      if (!/^\d{6}$/.test(code)) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const s = await M.MartSettings.findOneAndUpdate({ pair_code: code, pair_expires: { $gt: new Date() } }, { $set: { pair_code: "", pair_expires: null } });
      if (!s) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const business = await Business.findOne({ _id: s.business_id, deleted: false, category: "mart" }).lean();
      if (!business) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const token = crypto.randomBytes(32).toString("hex");
      await M.MartDevice.create({ business_id: business._id, name: text(req.body || {}, "name", 60) || "Counter", token_hash: sha(token), last_seen: new Date() });
      res.status(201).json({ success: true, data: { token, business: { name: business.name, logo_url: business.logo_url || "" } } });
    }),
  );

  prop.app.post(
    "/api/martpos/login",
    prop.api_auth,
    loginLimit,
    handle(async (req, res) => {
      const raw = String(req.headers["x-mart-device"] || "");
      const device = raw && (await M.MartDevice.findOne({ token_hash: sha(raw), revoked: false }));
      if (!device) throw new Bad(MSG.posLogin, 401, { code: "no_device" });
      const pin = String(req.body?.pin || "");
      if (!/^\d{4}$/.test(pin)) throw new Bad(T.badLogin, 400, { code: "bad_pin" });
      const staff = await M.MartStaff.findOne({ business_id: device.business_id, pin_key: pinKey(device.business_id, pin), active: true }).lean();
      if (!staff) throw new Bad(T.badLogin, 401, { code: "bad_pin" });
      const session = jwt.sign({ type: "mart_staff", sid: String(staff._id), did: String(device._id), v: staff.pin_v || 0 }, process.env.JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
      res.json({ success: true, data: { session, staff: staffOut(staff) } });
    }),
  );

  prop.app.get(
    "/api/martpos/boot",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await posCtx(req, false);
      const bid = ctx.business._id;
      const debtOn = !!ctx.addons.mart_debt?.active;
      // shifts add-on: the shift open on this device (the POS asks to count the drawer when there is none)
      const shift = ctx.addons.mart_shifts?.active ? await M.MartShift.findOne({ business_id: bid, device_id: ctx.device._id, status: "open" }).select("no float_usd float_khr opened_at opened_by").lean() : null;
      const [categories, products, units, debtors] = await Promise.all([
        M.MartCategory.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean(),
        M.MartProduct.find({ business_id: bid, active: true }).sort({ fav: -1, sort: 1, name: 1 }).limit(ctx.limits.products).select("name barcode category_id price unit_id photo.url fav stock low_stock track_stock plu").lean(),
        unitsOf(bid),
        debtOn ? M.MartDebtor.find({ business_id: bid, active: true }).sort({ name: 1 }).limit(800).select("name phone balance").lean() : [],
      ]);
      const stockOn = !!ctx.addons.mart_stock?.active;
      const s = ctx.settings;
      res.json({
        success: true,
        data: {
          business: { _id: bid, name: ctx.business.name, logo_url: ctx.business.logo_url || "", phone: ctx.business.phone || "", address: ctx.business.address || "", status: ctx.business.status },
          license: ctx.license,
          settings: {
            currency: s.currency,
            khr_rate: s.khr_rate,
            khr_round: s.khr_round || 100,
            methods: s.methods,
            custom_methods: (s.custom_methods || []).map((x) => ({ key: x.key, name: x.name, color: x.color, qr: x.qr?.url || "" })),
            receipt_note: s.receipt_note,
            pay_qr: s.pay_qr?.url || "",
            pay_qr_label: s.pay_qr_label || "",
          },
          categories,
          products: products.map((p) => ({
            _id: p._id,
            name: p.name,
            barcode: p.barcode,
            category_id: p.category_id,
            price: p.price,
            unit_id: p.unit_id,
            photo: p.photo?.url || "",
            fav: p.fav,
            ...(p.plu ? { plu: p.plu } : {}),
            ...(stockOn && p.track_stock ? { stock: p.stock, low_stock: p.low_stock ?? 5 } : {}),
          })),
          units,
          limits: ctx.limits,
          lists: { methods: M.METHODS },
          pos_theme: await kit.methods.posTheme(ctx),
          pos_color: s.pos_color || "",
          pos_customers: !!s.pos_customers && !!ctx.addons.mart_shop?.active, // the cashier may open online customers
          stock: stockOn,
          debt: debtOn,
          debtors: debtOn ? debtors : [],
          shifts: !!ctx.addons.mart_shifts?.active,
          shift,
          shop: !!ctx.addons.mart_shop?.active, // online orders: the POS shows them and rings on a new one
          print: { on: !!ctx.addons.mart_printer?.active, theme: s.print_theme || "classic", size: s.print_size || "80", auto: !!s.print_auto },
          promos: await kit.promos.forPos(ctx), // promotions (mart_promos): worked out on the POS, also offline
          loyalty: kit.loyalty.on(ctx) ? kit.loyalty.rules(s) : null, // loyalty points (mart_loyalty)
          members: await kit.loyalty.forPos(ctx),
          scale: ctx.addons.mart_scale?.active && s.scale?.on ? kit.scale.scaleOf(s) : null, // weighing-scale barcodes (mart_scale)
          display: !!ctx.addons.mart_display?.active, // customer screen (mart_display)
          addons_on: Object.fromEntries(["mart_expiry", "mart_purchase", "mart_profit", "mart_delivery", "mart_suppliers"].map((k) => [k, !!ctx.addons[k]?.active])), // sections a manager can open on the POS
          staff: { _id: ctx.staff._id, name: ctx.staff.name, role: ctx.staff.role },
          device: { _id: ctx.device._id, name: ctx.device.name },
        },
      });
    }),
  );

  // offline copy: PIN checks (never the PIN) + today's sales, so the day total still adds up with no internet
  prop.app.get(
    "/api/martpos/sync",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await posCtx(req, false);
      const bid = ctx.business._id;
      const today = localDay();
      const start = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 3600000);
      const [staff, sales] = await Promise.all([
        M.MartStaff.find({ business_id: bid, active: true }).select("name role pin_salt pin_check").lean(),
        M.MartSale.find({ business_id: bid, at: { $gte: start } })
          .sort({ at: -1 })
          .limit(3000)
          .lean(),
      ]);
      res.json({
        success: true,
        data: {
          server_time: new Date(),
          today,
          staff: staff.filter((x) => x.pin_check).map((x) => ({ _id: x._id, name: x.name, role: x.role, pin_salt: x.pin_salt, pin_check: x.pin_check })),
          sales,
        },
      });
    }),
  );
};
