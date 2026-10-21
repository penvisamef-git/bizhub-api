// Shifts & cash drawer (mart_shifts, forever) — both doors. A shift belongs to one POS device
// (or to the owner dashboard, which counts every device).
//   GET  /shifts                      the open shift for this door (with live expected cash) + the last 60 closed
//   POST /shifts/open { float_usd, float_khr, note }
//   POST /shifts/:sid/cash { kind: in|out, amount_usd, amount_khr, note }     money put in / taken out
//   POST /shifts/:sid/close { counted_usd, counted_khr, note }                count the drawer → expected, difference
// Expected cash = float + cash received (+ in − out); riel also minus the change given back.
const T = {
  needShifts: "សូមដោះសោ “វេន និងថតលុយ” ជាមុនសិន!",
  alreadyOpen: "មានវេនកំពុងបើករួចហើយ!",
  notOpen: "វេននេះបានបិទរួចហើយ!",
  nothing: "សូមបញ្ចូលចំនួនប្រាក់!",
};
const R2 = (v) => Math.round(v * 100) / 100;
const RK = (v) => Math.round(v);

module.exports = (prop, kit) => {
  const { dual, Bad, MSG, text, num, oneOf, validId, M } = kit;
  const need = (ctx) => {
    if (!ctx.addons.mart_shifts?.active) throw new Bad(T.needShifts, 402, { product: "mart_shifts" });
  };
  const doorOf = (ctx) => ({ business_id: ctx.business._id, device_id: ctx.device?._id || null });

  // the cash that went through the drawer while the shift was open
  async function cashOf(shift, until = new Date()) {
    const q = { business_id: shift.business_id, status: "paid", at: { $gte: shift.opened_at, $lte: until } };
    if (shift.device_id) q.device_id = shift.device_id;
    const methods = await M.MartSale.aggregate([{ $match: q }, { $group: { _id: "$method", total: { $sum: "$total" } } }]);
    const [sums] = await M.MartSale.aggregate([
      { $match: q },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          total: { $sum: "$total" },
          cash_usd: { $sum: "$paid_usd" },
          cash_khr: { $sum: "$paid_khr" },
          change_khr: { $sum: { $cond: [{ $eq: ["$method", "cash"] }, "$change_khr", 0] } },
        },
      },
    ]);
    const s = sums || { count: 0, total: 0, cash_usd: 0, cash_khr: 0, change_khr: 0 };
    const inUsd = shift.moves.filter((x) => x.kind === "in").reduce((a, x) => a + x.amount_usd, 0);
    const outUsd = shift.moves.filter((x) => x.kind === "out").reduce((a, x) => a + x.amount_usd, 0);
    const inKhr = shift.moves.filter((x) => x.kind === "in").reduce((a, x) => a + x.amount_khr, 0);
    const outKhr = shift.moves.filter((x) => x.kind === "out").reduce((a, x) => a + x.amount_khr, 0);
    return {
      sales_count: s.count,
      sales_total: R2(s.total),
      cash_usd: R2(s.cash_usd),
      cash_khr: RK(s.cash_khr),
      change_khr: RK(s.change_khr),
      expected_usd: R2(shift.float_usd + s.cash_usd + inUsd - outUsd),
      expected_khr: RK(shift.float_khr + s.cash_khr - s.change_khr + inKhr - outKhr),
      by_method: Object.fromEntries(methods.map((x) => [x._id, R2(x.total)])),
      in_usd: R2(inUsd),
      out_usd: R2(outUsd),
      in_khr: RK(inKhr),
      out_khr: RK(outKhr),
    };
  }

  dual("get", "/shifts", false, async (ctx, req, res) => {
    need(ctx);
    const [current, open, rows] = await Promise.all([
      M.MartShift.findOne({ ...doorOf(ctx), status: "open" }).lean(),
      ctx.device ? [] : M.MartShift.find({ business_id: ctx.business._id, status: "open" }).sort({ opened_at: -1 }).lean(), // the owner sees every device's open shift
      M.MartShift.find({ business_id: ctx.business._id, status: "closed" }).sort({ opened_at: -1 }).limit(60).lean(),
    ]);
    res.json({ success: true, data: { current: current ? { ...current, live: await cashOf(current) } : null, open: await Promise.all(open.map(async (x) => ({ ...x, live: await cashOf(x) }))), rows } });
  });

  dual("post", "/shifts/open", true, async (ctx, req, res) => {
    need(ctx);
    const b = req.body || {};
    if (await M.MartShift.exists({ ...doorOf(ctx), status: "open" })) throw new Bad(T.alreadyOpen, 409, { code: "shift_open" });
    const seq = await M.MartSettings.findOneAndUpdate({ _id: ctx.settings._id }, { $inc: { next_shift: 1 } }, { returnDocument: "before" }).lean();
    const row = await M.MartShift.create({
      ...doorOf(ctx),
      no: `SH-${String(seq?.next_shift || 1).padStart(4, "0")}`,
      device_name: ctx.device?.name || "",
      float_usd: R2(num(b, "float_usd", 0, 1000000) || 0),
      float_khr: RK(num(b, "float_khr", 0, 10000000000) || 0),
      opened_by: ctx.by,
      note: text(b, "note", 300) || "",
    });
    res.status(201).json({ success: true, data: { ...row.toObject(), live: await cashOf(row) }, message: MSG.saved });
  });

  const loadOpen = async (ctx, sid) => {
    if (!validId(sid)) throw new Bad(MSG.badId);
    const row = await M.MartShift.findOne({ _id: sid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    if (row.status !== "open") throw new Bad(T.notOpen, 409, { code: "shift_closed" });
    return row;
  };
  dual("post", "/shifts/:sid/cash", true, async (ctx, req, res) => {
    need(ctx);
    const b = req.body || {};
    const row = await loadOpen(ctx, req.params.sid);
    const kind = oneOf(b, "kind", M.SHIFT_MOVES ? M.SHIFT_MOVES : ["in", "out"]) || (() => { throw new Bad(`${MSG.required}: kind`); })(); // prettier-ignore
    const usd = R2(num(b, "amount_usd", 0, 1000000) || 0);
    const khr = RK(num(b, "amount_khr", 0, 10000000000) || 0);
    if (!usd && !khr) throw new Bad(T.nothing, 400, { code: "nothing" });
    row.moves.push({ kind, amount_usd: usd, amount_khr: khr, note: text(b, "note", 200) || "", by: ctx.by });
    await row.save();
    res.json({ success: true, data: { ...row.toObject(), live: await cashOf(row) }, message: MSG.saved });
  });

  dual("post", "/shifts/:sid/close", true, async (ctx, req, res) => {
    need(ctx);
    const b = req.body || {};
    const row = await loadOpen(ctx, req.params.sid);
    const now = new Date();
    const live = await cashOf(row, now);
    row.set({
      status: "closed",
      closed_at: now,
      closed_by: ctx.by,
      counted_usd: R2(num(b, "counted_usd", 0, 10000000, { required: true })),
      counted_khr: RK(num(b, "counted_khr", 0, 100000000000) || 0),
      expected_usd: live.expected_usd,
      expected_khr: live.expected_khr,
      sales_count: live.sales_count,
      sales_total: live.sales_total,
      cash_usd: live.cash_usd,
      cash_khr: live.cash_khr,
      change_khr: live.change_khr,
      by_method: live.by_method,
      note: text(b, "note", 300) ?? row.note,
    });
    row.diff_usd = R2(row.counted_usd - row.expected_usd);
    row.diff_khr = RK(row.counted_khr - row.expected_khr);
    await row.save();
    await kit.tg?.soon(kit.tg.alert(ctx.business._id, "shift_close", { shift: row.toObject() }, { settings: ctx.settings, addons: ctx.addons, name: ctx.business.name })); // Telegram (mart_telegram)
    res.json({ success: true, data: row, message: MSG.saved });
  });
};
