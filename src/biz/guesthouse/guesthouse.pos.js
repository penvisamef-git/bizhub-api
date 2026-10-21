// Guest House desk POS (/pos/guest-house): staff with PINs, paired desk devices, the guest display, the payment QR.
// Owner (base /api/user/businesses/:id/guesthouse):
//   GET/POST /staff   PUT/DELETE /staff/:rid      (2 staff free; "gh_staff" yearly = more)
//   POST /pos/pair-code   GET /pos/devices   DELETE /pos/devices/:did
//   POST /pay-qr (multipart file)   DELETE /pay-qr
// Device (x-api-key + x-gh-device [+ x-gh-session]):
//   POST /api/ghpos/pair { code, name }     → { token }  (keep it on the device)
//   POST /api/ghpos/login { pin }           → { session, staff }
//   GET  /api/ghpos/boot                    everything the desk needs
//   POST /api/ghpos/display/key             a key for a guest display on another tablet ("gh_display")
//   PUT  /api/ghpos/display { state }       GET /api/ghpos/display/:key (the display reads it)
// Booking routes (/api/ghpos/stays…, /today, /guests) are shared with the owner in guesthouse.route.js.
const crypto = require("crypto");
const multer = require("multer");
const { rate_limit } = require("../../util/rate_limit");
const { uploadBuffer, deleteFile } = require("../../util/cloudinary");
const License = require("../../license/license.model");
const { buy } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");

const SESSION_HOURS = 14;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("type"), { code: "INVALID_TYPE" }))),
});

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, posCtx, Bad, MSG, text, bool, oneOf, validId, licenseState, settingsOf, sha, jwt, ownerName, M, Business } = kit;
  const T = {
    badPin: "PIN ត្រូវមាន 4 ខ្ទង់!",
    pinTaken: "PIN នេះមានបុគ្គលិកផ្សេងប្រើហើយ!",
    staffLimit: "បុគ្គលិកឥតគិតថ្លៃមានតែ 2 នាក់។ សូមដោះសោ “បុគ្គលិកបន្ថែម”។",
    badCode: "លេខកូដមិនត្រឹមត្រូវ ឬផុតកំណត់ហើយ!",
    badLogin: "PIN មិនត្រឹមត្រូវ!",
    needDisplay: "សូមដោះសោ “អេក្រង់សម្រាប់ភ្ញៀវ” ជាមុនសិន!",
    noFile: "សូមជ្រើសរើសរូបភាព!",
    themeLocked: "សូមទិញរចនាប័ទ្មនេះជាមុនសិន!",
    badImage: "អាចបញ្ចូលបានតែរូបភាព jpg, png, webp (អតិបរមា 4MB)",
  };
  const pinCheck = (pin) => {
    const salt = crypto.randomBytes(8).toString("hex");
    return { pin_salt: salt, pin_check: crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex") };
  };
  const pinKey = (bid, pin) =>
    crypto
      .createHmac("sha256", process.env.JWT_SECRET || "bizhub")
      .update(`gh:${bid}:${pin}`)
      .digest("hex");
  const needHk = (ctx) => {
    if (!ctx.addons.gh_housekeeping?.active) throw new Bad("សូមដោះសោ “ការសម្អាតបន្ទប់” ជាមុនសិន!", 402, { product: "gh_housekeeping" });
  };
  const staffOut = (s) => ({ _id: s._id, name: s.name, role: s.role, phone: s.phone, active: s.active, created_date: s.created_date });
  const pinOf = (b, required) => {
    if (b.pin === undefined || b.pin === "") {
      if (required) throw new Bad(T.badPin, 400, { code: "bad_pin" });
      return undefined;
    }
    if (!/^\d{4}$/.test(String(b.pin))) throw new Bad(T.badPin, 400, { code: "bad_pin" });
    return String(b.pin);
  };

  // ---------------- owner: staff ----------------
  prop.app.get(
    `${base}/staff`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const rows = await M.GhStaff.find({ business_id: ctx.business._id }).sort({ sort: 1, created_date: 1 }).lean();
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
      if ((await M.GhStaff.countDocuments({ business_id: bid })) >= ctx.limits.staff) throw new Bad(T.staffLimit, 402, { code: "staff_limit", product: "gh_staff", limit: ctx.limits.staff });
      if (b.role === "housekeeper") needHk(ctx);
      const pin = pinOf(b, true);
      if (await M.GhStaff.exists({ business_id: bid, pin_key: pinKey(bid, pin) })) throw new Bad(T.pinTaken, 409, { code: "pin_taken" });
      try {
        const row = await M.GhStaff.create({
          business_id: bid,
          name: text(b, "name", 60, { required: true }),
          role: oneOf(b, "role", M.STAFF_ROLES) || "desk",
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
      const row = await M.GhStaff.findOne({ _id: req.params.rid, business_id: ctx.business._id });
      if (!row) throw new Bad(MSG.rowNotFound, 404);
      const b = req.body || {};
      const name = text(b, "name", 60);
      if (name) row.name = name;
      const role = oneOf(b, "role", M.STAFF_ROLES);
      if (role === "housekeeper" && row.role !== "housekeeper") needHk(ctx);
      if (role) row.role = role;
      const phone = text(b, "phone", 30);
      if (phone !== undefined) row.phone = phone;
      const active = bool(b, "active");
      if (active !== undefined) row.active = active;
      const pin = pinOf(b, false);
      if (pin) {
        if (await M.GhStaff.exists({ business_id: ctx.business._id, pin_key: pinKey(ctx.business._id, pin), _id: { $ne: row._id } })) throw new Bad(T.pinTaken, 409, { code: "pin_taken" });
        row.pin_key = pinKey(ctx.business._id, pin);
        Object.assign(row, pinCheck(pin));
        row.pin_v = (row.pin_v || 0) + 1;
      }
      if (active === false || role) row.pin_v = (row.pin_v || 0) + (pin ? 0 : 1); // log them out
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
      const r = await M.GhStaff.deleteOne({ _id: req.params.rid, business_id: ctx.business._id });
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
      const rows = await M.GhDevice.find({ business_id: ctx.business._id, revoked: false }).sort({ created_date: -1 }).select("name last_seen created_date display_at").lean();
      res.json({ success: true, data: rows });
    }),
  );
  prop.app.delete(
    `${base}/pos/devices/:did`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.did)) throw new Bad(MSG.badId);
      const r = await M.GhDevice.updateOne({ _id: req.params.did, business_id: ctx.business._id }, { $set: { revoked: true, display_key: "" } });
      if (!r.matchedCount) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, message: MSG.deleted });
    }),
  );

  // ---------------- owner: payment QR (shown on the guest display) ----------------
  const withFile = (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" || err.code === "INVALID_TYPE" ? T.badImage : err.message });
      next();
    });
  prop.app.post(
    `${base}/pay-qr`,
    ...guard,
    withFile,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!req.file) throw new Bad(T.noFile);
      const saved = await uploadBuffer(req.file, "guesthouse");
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

  // ---------------- owner: pictures (guest display image, logo, cover) + profile ----------------
  const PICS = {
    "display-image": { get: (st) => st.display_image, set: (st, v) => (st.display_image = v) },
    cover: { get: (st) => st.cover, set: (st, v) => (st.cover = v) },
  };
  for (const [path, pic] of Object.entries(PICS)) {
    prop.app.post(
      `${base}/${path}`,
      ...guard,
      withFile,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        if (!req.file) throw new Bad(T.noFile);
        const saved = await uploadBuffer(req.file, "guesthouse");
        const old = pic.get(ctx.settings)?.public_id;
        pic.set(ctx.settings, { url: saved.url, public_id: saved.public_id || "" });
        await ctx.settings.save();
        if (old) deleteFile(old).catch(() => {});
        res.json({ success: true, data: pic.get(ctx.settings), message: MSG.saved });
      }),
    );
    prop.app.delete(
      `${base}/${path}`,
      ...guard,
      handle(async (req, res) => {
        const ctx = await ctxOf(req, true);
        const old = pic.get(ctx.settings)?.public_id;
        pic.set(ctx.settings, { url: "", public_id: "" });
        await ctx.settings.save();
        if (old) deleteFile(old).catch(() => {});
        res.json({ success: true, message: MSG.deleted });
      }),
    );
  }
  // logo: saved on the business, so the dashboard list shows it like every other business
  prop.app.post(
    `${base}/logo`,
    ...guard,
    withFile,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!req.file) throw new Bad(T.noFile);
      const saved = await uploadBuffer(req.file, "guesthouse");
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
      for (const [k, max] of [
        ["email", 120],
        ["website", 200],
        ["facebook", 200],
        ["telegram", 100],
        ["map_url", 500],
        ["description", 1000],
      ]) {
        const v = text(b, k, max);
        if (v !== undefined) ctx.settings[k] = v;
      }
      if (ctx.settings.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ctx.settings.email)) throw new Bad(`${MSG.badValue} (email)`);
      await Promise.all([ctx.business.save(), ctx.settings.save()]);
      res.json({ success: true, data: { business: ctx.business, settings: ctx.settings }, message: MSG.saved });
    }),
  );

  // ---------------- owner: guest display looks ----------------
  const ownedThemes = async (bid) => ["classic", ...(await License.find({ business_id: bid, product: "gh_display_theme", expires_at: null }).select("item").lean()).map((l) => l.item)];
  prop.app.get(
    `${base}/display-themes`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: { themes: M.DISPLAY_THEMES, owned: await ownedThemes(ctx.business._id), current: ctx.settings.display_theme || "classic", price: await priceOf("gh_display_theme") } });
    }),
  );
  prop.app.post(
    `${base}/display-themes/:theme/buy`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const theme = req.params.theme;
      if (!M.DISPLAY_THEMES.includes(theme) || theme === "classic") throw new Bad(MSG.badValue);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "gh_display_theme", item: theme, expect: null });
      ctx.settings.display_theme = theme;
      await ctx.settings.save();
      res.json({ success: true, data: { theme, owned: await ownedThemes(ctx.business._id) }, charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );
  prop.app.put(
    `${base}/display-theme`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const theme = String(req.body?.theme || "");
      if (!M.DISPLAY_THEMES.includes(theme)) throw new Bad(MSG.badValue);
      if (!(await ownedThemes(ctx.business._id)).includes(theme)) throw new Bad(T.themeLocked, 402, { product: "gh_display_theme", item: theme });
      ctx.settings.display_theme = theme;
      await ctx.settings.save();
      res.json({ success: true, data: { theme }, message: MSG.saved });
    }),
  );

  // ---------------- owner: printing (gh_printer) + receipt templates (gh_print_theme) ----------------
  const ownedPrint = async (bid) => ["classic", ...(await License.find({ business_id: bid, product: "gh_print_theme", expires_at: null }).select("item").lean()).map((l) => l.item)];
  const printInfo = async (ctx) => ({
    on: !!ctx.addons.gh_printer?.active,
    themes: M.PRINT_THEMES,
    owned: await ownedPrint(ctx.business._id),
    current: ctx.settings.print_theme || "classic",
    size: ctx.settings.print_size || "80",
    auto: !!ctx.settings.print_auto,
    qr: ctx.settings.print_qr !== false,
    price: await priceOf("gh_print_theme"),
    addon_price: await priceOf("gh_printer"),
  });
  prop.app.get(
    `${base}/print`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: await printInfo(ctx) });
    }),
  );
  prop.app.post(
    `${base}/print-themes/:theme/buy`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const theme = req.params.theme;
      if (!M.PRINT_THEMES.includes(theme) || theme === "classic") throw new Bad(MSG.badValue);
      const r = await buy({ customer: req.customer, business: ctx.business, product: "gh_print_theme", item: theme, expect: null });
      ctx.settings.print_theme = theme;
      await ctx.settings.save();
      res.json({ success: true, data: await printInfo(ctx), charged: r.charged, balance: r.balance, message: MSG.saved });
    }),
  );
  // { theme?, size?, auto?, qr? }
  prop.app.put(
    `${base}/print`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      const b = req.body || {};
      if (b.theme !== undefined) {
        const theme = String(b.theme);
        if (!M.PRINT_THEMES.includes(theme)) throw new Bad(MSG.badValue);
        if (!(await ownedPrint(ctx.business._id)).includes(theme)) throw new Bad(T.themeLocked, 402, { product: "gh_print_theme", item: theme });
        ctx.settings.print_theme = theme;
      }
      if (b.size !== undefined) {
        if (!["80", "58", "a4"].includes(String(b.size))) throw new Bad(`${MSG.badValue} (size)`);
        ctx.settings.print_size = String(b.size);
      }
      if (b.auto !== undefined) ctx.settings.print_auto = !!b.auto;
      if (b.qr !== undefined) ctx.settings.print_qr = !!b.qr;
      await ctx.settings.save();
      res.json({ success: true, data: await printInfo(ctx), message: MSG.saved });
    }),
  );

  // ---------------- device ----------------
  const pairLimit = rate_limit({ windowMs: 10 * 60 * 1000, max: 15 });
  const loginLimit = rate_limit({ windowMs: 5 * 60 * 1000, max: 30 });
  const deviceOf = async (req) => {
    const raw = String(req.headers["x-gh-device"] || "");
    const device = raw && (await M.GhDevice.findOne({ token_hash: sha(raw), revoked: false }));
    if (!device) throw new Bad(MSG.posLogin, 401, { code: "no_device" });
    return device;
  };

  prop.app.post(
    "/api/ghpos/pair",
    prop.api_auth,
    pairLimit,
    handle(async (req, res) => {
      const code = String(req.body?.code || "").trim();
      if (!/^\d{6}$/.test(code)) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const s = await M.GhSettings.findOneAndUpdate({ pair_code: code, pair_expires: { $gt: new Date() } }, { $set: { pair_code: "", pair_expires: null } });
      if (!s) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const business = await Business.findOne({ _id: s.business_id, deleted: false, category: "guest_house" }).lean();
      if (!business) throw new Bad(T.badCode, 400, { code: "bad_code" });
      const token = crypto.randomBytes(32).toString("hex");
      await M.GhDevice.create({ business_id: business._id, name: text(req.body || {}, "name", 60) || "Desk", token_hash: sha(token), last_seen: new Date() });
      res.status(201).json({ success: true, data: { token, business: { name: business.name, logo_url: business.logo_url || "" } } });
    }),
  );

  prop.app.post(
    "/api/ghpos/login",
    prop.api_auth,
    loginLimit,
    handle(async (req, res) => {
      const device = await deviceOf(req);
      const pin = String(req.body?.pin || "");
      if (!/^\d{4}$/.test(pin)) throw new Bad(T.badLogin, 400, { code: "bad_pin" });
      const staff = await M.GhStaff.findOne({ business_id: device.business_id, pin_key: pinKey(device.business_id, pin), active: true }).lean();
      if (!staff) throw new Bad(T.badLogin, 401, { code: "bad_pin" });
      if (!staff.pin_check) await M.GhStaff.updateOne({ _id: staff._id }, { $set: pinCheck(pin) }); // staff made before offline PINs
      const session = jwt.sign({ type: "gh_staff", sid: String(staff._id), did: String(device._id), v: staff.pin_v || 0 }, process.env.JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
      res.json({ success: true, data: { session, staff: staffOut(staff) } });
    }),
  );

  prop.app.get(
    "/api/ghpos/boot",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await posCtx(req, false, { hk: true });
      const bid = ctx.business._id;
      const [types, rooms] = await Promise.all([M.GhRoomType.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean(), M.GhRoom.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean()]);
      const s = ctx.settings;
      const active = rooms.filter((r) => r.active);
      res.json({
        success: true,
        data: {
          business: { _id: bid, name: ctx.business.name, logo_url: ctx.business.logo_url || "", phone: ctx.business.phone || "", address: ctx.business.address || "", status: ctx.business.status },
          license: ctx.license,
          settings: {
            currency: s.currency,
            check_in: s.check_in,
            check_out: s.check_out,
            methods: s.methods,
            receipt_note: s.receipt_note,
            pay_qr: s.pay_qr?.url || "",
            pay_qr_label: s.pay_qr_label || "",
            display_image: s.display_image?.url || "",
            cover: s.cover?.url || "",
            khr_rate: s.khr_rate,
            email: s.email,
            website: s.website,
          },
          types,
          rooms: rooms.map((r) => ({ ...r, usable: !r.active || active.indexOf(r) < ctx.limits.rooms })),
          counts: { rooms: active.length },
          limits: ctx.limits,
          lists: { sources: M.SOURCES, methods: M.METHODS, id_types: M.ID_TYPES, amenities: M.AMENITIES },
          staff: { _id: ctx.staff._id, name: ctx.staff.name, role: ctx.staff.role },
          device: { _id: ctx.device._id, name: ctx.device.name },
          display: { on: !!ctx.addons.gh_display?.active, theme: s.display_theme || "classic" },
          services: ctx.addons.gh_services?.active ? (s.services || []).filter((x) => x.active) : [],
          police: !!ctx.addons.gh_police?.active,
          housekeeping: !!ctx.addons.gh_housekeeping?.active,
          expenses: !!ctx.addons.gh_expenses?.active,
          longstay: !!ctx.addons.gh_longstay?.active,
          reviews: !!ctx.addons.gh_reviews?.active,
          loyalty: !!ctx.addons.gh_loyalty?.active,
          print: { on: !!ctx.addons.gh_printer?.active, theme: s.print_theme || "classic", size: s.print_size || "80", auto: !!s.print_auto, qr: s.print_qr !== false },
        },
      });
    }),
  );

  // offline copy for the desk: everything the screens need + the bookings that matter (live, or ended in the last 30 days)
  prop.app.get(
    "/api/ghpos/sync",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await posCtx(req, false, { hk: true });
      const bid = ctx.business._id;
      const { billOf } = require("./guesthouse.route");
      const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
      const since = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
      const [rooms, staff, stays] = await Promise.all([
        M.GhRoom.find({ business_id: bid }).lean(),
        M.GhStaff.find({ business_id: bid, active: true }).select("name role pin_salt pin_check").lean(),
        M.GhStay.find({ business_id: bid, $or: [{ status: { $in: M.LIVE } }, { to: { $gte: since } }] })
          .sort({ from: -1 })
          .limit(2000)
          .lean(),
      ]);
      const name = new Map(rooms.map((r) => [String(r._id), r]));
      const cur = ctx.settings.currency;
      res.json({
        success: true,
        data: {
          server_time: new Date(),
          today,
          staff: staff.filter((x) => x.pin_check).map((x) => ({ _id: x._id, name: x.name, role: x.role, pin_salt: x.pin_salt, pin_check: x.pin_check })),
          stays: stays.map((x) => ({ ...x, room_name: name.get(String(x.room_id))?.name || "?", type_id: name.get(String(x.room_id))?.type_id || null, bill: billOf(x, cur) })),
        },
      });
    }),
  );

  // guest display on another tablet: the desk pushes, the tablet polls
  prop.app.post(
    "/api/ghpos/display/key",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await posCtx(req, false);
      if (!ctx.addons.gh_display?.active) throw new Bad(T.needDisplay, 402, { product: "gh_display" });
      if (!ctx.device.display_key) {
        ctx.device.display_key = crypto.randomBytes(12).toString("base64url");
        await ctx.device.save();
      }
      res.json({ success: true, data: { key: ctx.device.display_key } });
    }),
  );
  prop.app.put(
    "/api/ghpos/display",
    prop.api_auth,
    handle(async (req, res) => {
      const device = await deviceOf(req);
      if (!device.display_key) return res.json({ success: true });
      const state = req.body?.state ?? null;
      if (JSON.stringify(state || {}).length > 30000) throw new Bad(MSG.tooLong);
      await M.GhDevice.updateOne({ _id: device._id }, { $set: { display_state: state, display_at: new Date() } });
      res.json({ success: true });
    }),
  );
  prop.app.get(
    "/api/ghpos/display/:key",
    prop.api_auth,
    handle(async (req, res) => {
      const key = String(req.params.key || "");
      const device = key.length >= 10 && (await M.GhDevice.findOne({ display_key: key, revoked: false }).select("display_state display_at business_id").lean());
      if (!device) throw new Bad(MSG.rowNotFound, 404);
      const state = await licenseState(device.business_id);
      if (!state.addons.gh_display?.active) throw new Bad(T.needDisplay, 402, { product: "gh_display" });
      res.json({ success: true, data: { state: device.display_state, at: device.display_at } });
    }),
  );
};
