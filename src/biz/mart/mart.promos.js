// Promotions (mart_promos, yearly) — owner dashboard: base/promos
//   GET    /promos                   every promotion (+ how often each was used)
//   POST   /promos { name, kind: percent | amount | bxgy, value, buy_qty, get_qty, target: all | categories | products,
//                    category_ids, product_ids, min_spend, code, where: both | pos | online, days, time_from, time_to, date_from, date_to, max_uses, active }
//   PUT    /promos/:pid   DELETE /promos/:pid
//   POST   /promos/check { items: [{ product_id, price, qty }], coupon }  (both doors) what this cart gets right now
// Applied by themselves on the POS (also offline: the POS has the same maths) and on the website; a code = a coupon.
const { applyPromos } = require("./mart.promo-calc");

const T = {
  need: "សូមដោះសោ “ប្រូម៉ូសិន” ជាមុនសិន!",
  coupon: {
    invalid: "កូដបញ្ចុះតម្លៃមិនត្រឹមត្រូវ!",
    expired: "កូដនេះផុតកំណត់ ឬមិនអាចប្រើពេលនេះបានទេ!",
    min_spend: "ទិញមិនទាន់គ្រប់ចំនួនសម្រាប់កូដនេះ!",
    no_match: "កូដនេះមិនត្រូវនឹងទំនិញក្នុងកន្ត្រកទេ!",
  },
  codeTaken: "កូដនេះមានរួចហើយ!",
  needValue: "សូមបំពេញចំនួនបញ្ចុះ!",
  needBxgy: "សូមបំពេញ ទិញ X ថែម Y!",
  needTargets: "សូមជ្រើសរើសទំនិញ ឬប្រភេទ!",
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9_-]{3,20}$/;
const MAX = 100;

module.exports = (prop, kit) => {
  const { own, dual, Bad, MSG, text, num, bool, oneOf, validId, roundOf, M } = kit;
  const on = (ctx) => !!ctx.addons?.mart_promos?.active;
  const need = (ctx) => {
    if (!on(ctx)) throw new Bad(T.need, 402, { product: "mart_promos" });
  };
  const ids = async (list, Model, bid, key) => {
    if (!Array.isArray(list) || list.length > 500 || !list.every(validId)) throw new Bad(`${MSG.badValue} (${key})`);
    const uniq = [...new Set(list.map(String))];
    if ((await Model.countDocuments({ business_id: bid, _id: { $in: uniq } })) !== uniq.length) throw new Bad(`${MSG.badValue} (${key})`);
    return uniq;
  };
  const read = async (ctx, b, cur) => {
    const bid = ctx.business._id;
    const out = {};
    const name = text(b, "name", 60, { required: !cur });
    if (name !== undefined) {
      if (!name) throw new Bad(`${MSG.required}: name`);
      out.name = name;
    }
    const kind = oneOf(b, "kind", M.PROMO_KINDS);
    if (kind) out.kind = kind;
    for (const [k, max] of [
      ["value", 1000000000],
      ["min_spend", 1000000000],
    ]) {
      const v = num(b, k, 0, max);
      if (v !== undefined) out[k] = v;
    }
    for (const k of ["buy_qty", "get_qty", "max_uses"]) {
      const v = num(b, k, 0, 100000, { int: true });
      if (v !== undefined) out[k] = v;
    }
    const target = oneOf(b, "target", ["all", "categories", "products"]);
    if (target) out.target = target;
    if (b.category_ids !== undefined) out.category_ids = await ids(b.category_ids, M.MartCategory, bid, "category_ids");
    if (b.product_ids !== undefined) out.product_ids = await ids(b.product_ids, M.MartProduct, bid, "product_ids");
    if (b.code !== undefined) {
      const code = String(b.code || "")
        .trim()
        .toUpperCase();
      if (code && !CODE_RE.test(code)) throw new Bad(`${MSG.badValue} (code)`, 400, { code: "bad_code" });
      if (code && (await M.MartPromo.exists({ business_id: bid, code, ...(cur ? { _id: { $ne: cur._id } } : {}) }))) throw new Bad(T.codeTaken, 409, { code: "code_taken" });
      out.code = code;
    }
    const where = oneOf(b, "where", ["both", "pos", "online"]);
    if (where) out.where = where;
    if (b.days !== undefined) {
      if (!Array.isArray(b.days) || !b.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Bad(`${MSG.badValue} (days)`);
      out.days = [...new Set(b.days)].sort();
    }
    for (const k of ["time_from", "time_to"]) {
      if (b[k] === undefined) continue;
      const v = String(b[k] || "");
      if (v && !TIME_RE.test(v)) throw new Bad(`${MSG.badValue} (${k})`);
      out[k] = v;
    }
    for (const k of ["date_from", "date_to"]) {
      if (b[k] === undefined) continue;
      const v = String(b[k] || "");
      if (v && !DAY_RE.test(v)) throw new Bad(`${MSG.badValue} (${k})`);
      out[k] = v;
    }
    const active = bool(b, "active");
    if (active !== undefined) out.active = active;
    // the whole promotion must make sense
    const x = { ...(cur ? cur.toObject() : { kind: "percent", target: "all", value: 0, buy_qty: 0, get_qty: 0, category_ids: [], product_ids: [] }), ...out };
    if (x.kind === "percent" && !(x.value > 0 && x.value <= 100)) throw new Bad(T.needValue, 400, { code: "need_value" });
    if (x.kind === "amount" && !(x.value > 0)) throw new Bad(T.needValue, 400, { code: "need_value" });
    if (x.kind === "bxgy" && !(x.buy_qty > 0 && x.get_qty > 0)) throw new Bad(T.needBxgy, 400, { code: "need_bxgy" });
    if (x.target === "categories" && !x.category_ids.length) throw new Bad(T.needTargets, 400, { code: "need_targets" });
    if (x.target === "products" && !x.product_ids.length) throw new Bad(T.needTargets, 400, { code: "need_targets" });
    if (x.kind === "amount") out.value = roundOf(ctx.settings.currency)(x.value);
    return out;
  };

  own("get", "/promos", false, async (ctx, req, res) => {
    const rows = await M.MartPromo.find({ business_id: ctx.business._id }).sort({ active: -1, created_date: -1 }).lean();
    res.json({ success: true, data: rows, on: on(ctx) });
  });
  own("post", "/promos", true, async (ctx, req, res) => {
    need(ctx);
    if ((await M.MartPromo.countDocuments({ business_id: ctx.business._id })) >= MAX) throw new Bad(MSG.tooMany);
    const row = await M.MartPromo.create({ business_id: ctx.business._id, ...(await read(ctx, req.body || {}, null)) });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  const load = async (ctx, pid) => {
    if (!validId(pid)) throw new Bad(MSG.badId);
    const row = await M.MartPromo.findOne({ _id: pid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  own("put", "/promos/:pid", true, async (ctx, req, res) => {
    need(ctx);
    const row = await load(ctx, req.params.pid);
    row.set(await read(ctx, req.body || {}, row));
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  own("delete", "/promos/:pid", true, async (ctx, req, res) => {
    const row = await load(ctx, req.params.pid);
    await row.deleteOne();
    res.json({ success: true, message: MSG.deleted });
  });

  // the promotions a cart can get (the POS and the website ask; the POS also works it out offline)
  const live = async (bid) => M.MartPromo.find({ business_id: bid, active: true }).lean();
  const categoriesOf = async (bid, lines) => {
    const pids = [...new Set(lines.filter((l) => l.product_id).map((l) => String(l.product_id)))];
    const prods = pids.length
      ? await M.MartProduct.find({ business_id: bid, _id: { $in: pids } })
          .select("category_id")
          .lean()
      : [];
    return Object.fromEntries(prods.map((p) => [String(p._id), p.category_id ? String(p.category_id) : ""]));
  };
  // what a sale / order gets: { discount, applied, coupon }; strict = a wrong coupon is an error
  async function forSale(ctx, lines, { at = new Date(), where = "pos", coupon = "", categoryOf, strict = true } = {}) {
    const none = { discount: 0, applied: [], coupon: "" };
    const code = String(coupon || "").trim();
    if (!on(ctx)) {
      if (code && strict) throw new Bad(T.need, 402, { product: "mart_promos", code: "coupon_off" });
      return none;
    }
    const bid = ctx.business?._id || ctx.bid;
    const promos = await live(bid);
    if (!promos.length && !code) return none;
    const out = applyPromos({ lines, promos, at, where, coupon: code, currency: ctx.settings.currency, categoryOf: categoryOf || (await categoriesOf(bid, lines)) });
    if (code && out.coupon !== "ok" && strict) throw new Bad(T.coupon[out.coupon] || T.coupon.invalid, 400, { code: `coupon_${out.coupon}` });
    return out;
  }
  // count the uses (coupons with a limit stop by themselves)
  const used = async (applied) => {
    const list = (applied || []).filter((x) => validId(x.id));
    if (list.length) await M.MartPromo.updateMany({ _id: { $in: list.map((x) => x.id) } }, { $inc: { uses: 1 } });
  };

  dual("post", "/promos/check", false, async (ctx, req, res) => {
    const b = req.body || {};
    const lines = (Array.isArray(b.items) ? b.items : []).slice(0, 300).map((x) => ({ product_id: validId(x?.product_id) ? String(x.product_id) : null, price: Number(x?.price) || 0, qty: Number(x?.qty) || 0 }));
    const out = await forSale(ctx, lines, { coupon: b.coupon, strict: false });
    res.json({ success: true, data: { ...out, message: out.coupon && out.coupon !== "ok" ? T.coupon[out.coupon] : "" } });
  });

  // what the POS keeps (offline too): every live promotion for the counter
  const forPos = async (ctx) => (on(ctx) ? (await live(ctx.business._id)).filter((p) => p.where !== "online").map(({ business_id, created_date, updated_date, __v, ...p }) => p) : []);
  return { on, live, forSale, used, forPos, T };
};
