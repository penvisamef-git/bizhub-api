// Housekeeping (gh_housekeeping, forever) + Expenses & profit (gh_expenses, forever)
// Both doors (owner dashboard + desk POS):
//   GET  /housekeeping                      every room: clean state + who is in it / leaving / arriving today
//   PUT  /rooms/:rid/hk   { state: dirty|cleaning|ready, note }      (housekeeper phones can use these two only)
//   GET  /expenses?month=YYYY-MM           the month's expenses + totals by category
//   POST /expenses        { day, category, amount, method, note }
//   PUT  /expenses/:eid   same fields          (owner / manager)
//   DELETE /expenses/:eid                      (owner / manager)
//   GET  /profit?month=YYYY-MM             money in − expenses, and the last 6 months
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const T = {
  needHk: "សូមដោះសោ “ការសម្អាតបន្ទប់” ជាមុនសិន!",
  needEx: "សូមដោះសោ “ចំណាយ និងប្រាក់ចំណេញ” ជាមុនសិន!",
  badDay: "ថ្ងៃមិនត្រឹមត្រូវ!",
};

module.exports = (prop, kit) => {
  const { dual, Bad, MSG, text, num, oneOf, validId, realDay, localDay, addDays, managerOnly, M } = kit;
  const needHk = (ctx) => {
    if (!ctx.addons.gh_housekeeping?.active) throw new Bad(T.needHk, 402, { product: "gh_housekeeping" });
  };
  const needEx = (ctx) => {
    if (!ctx.addons.gh_expenses?.active) throw new Bad(T.needEx, 402, { product: "gh_expenses" });
  };
  const monthOf = (q) => (MONTH_RE.test(String(q.month || "")) ? String(q.month) : localDay().slice(0, 7));
  const nextMonth = (m) => {
    const [y, mm] = m.split("-").map(Number);
    return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  };
  const prevMonth = (m) => {
    const [y, mm] = m.split("-").map(Number);
    return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
  };
  const round = (cur) => (v) => (cur === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);

  // ===================================== HOUSEKEEPING =====================================
  dual(
    "get",
    "/housekeeping",
    false,
    async (ctx, req, res) => {
      needHk(ctx);
      const bid = ctx.business._id;
      const today = localDay();
      const [rooms, types, live] = await Promise.all([
        M.GhRoom.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).lean(),
        M.GhRoomType.find({ business_id: bid }).select("name color").lean(),
        M.GhStay.find({ business_id: bid, status: { $in: M.LIVE }, from: { $lte: addDays(today, 1) } })
          .select("room_id status from to guest.name adults children")
          .lean(),
      ]);
      const typeOf = new Map(types.map((t) => [String(t._id), t]));
      const list = rooms.map((r) => {
        const here = live.find((s) => s.status === "in" && String(s.room_id) === String(r._id));
        const coming = live.filter((s) => s.status === "booked" && String(s.room_id) === String(r._id) && s.from <= today).sort((a, b) => (a.from < b.from ? -1 : 1))[0];
        const guest = (s) => s && { name: s.guest.name, from: s.from, to: s.to, people: (s.adults || 1) + (s.children || 0) };
        return {
          _id: r._id,
          name: r.name,
          floor: r.floor,
          type: typeOf.get(String(r.type_id))?.name || "",
          color: typeOf.get(String(r.type_id))?.color || "",
          hk: r.hk || "ready",
          hk_by: r.hk_by || "",
          hk_at: r.hk_at,
          hk_note: r.hk_note || "",
          guest: here ? "in" : coming ? "arriving" : "empty",
          leaving: !!here && here.to <= today,
          stay: guest(here) || guest(coming) || null,
        };
      });
      const count = (k) => list.filter((x) => x.hk === k).length;
      res.json({ success: true, data: { day: today, rooms: list, counts: { dirty: count("dirty"), cleaning: count("cleaning"), ready: count("ready") } } });
    },
    { hk: true },
  );
  dual(
    "put",
    "/rooms/:rid/hk",
    true,
    async (ctx, req, res) => {
      needHk(ctx);
      if (!validId(req.params.rid)) throw new Bad(MSG.badId);
      const b = req.body || {};
      const state = oneOf(b, "state", M.HK_STATES);
      if (!state) throw new Bad(`${MSG.required}: state`);
      const room = await M.GhRoom.findOneAndUpdate({ _id: req.params.rid, business_id: ctx.business._id }, { $set: { hk: state, hk_by: ctx.by, hk_at: new Date(), hk_note: text(b, "note", 200) || "" } }, { returnDocument: "after" }).lean();
      if (!room) throw new Bad(MSG.rowNotFound, 404);
      res.json({ success: true, data: { _id: room._id, hk: room.hk, hk_by: room.hk_by, hk_at: room.hk_at, hk_note: room.hk_note }, message: MSG.saved });
    },
    { hk: true },
  );

  // ===================================== EXPENSES =====================================
  const readExpense = (b, cur = null) => {
    const out = {};
    if (b.day !== undefined || !cur) {
      const day = String(b.day || localDay());
      const today = localDay();
      if (!realDay(day) || day > addDays(today, 31) || day < addDays(today, -400)) throw new Bad(T.badDay, 400, { code: "bad_day" });
      out.day = day;
    }
    const cat = oneOf(b, "category", M.EXPENSE_CATS);
    if (cat) out.category = cat;
    const amount = num(b, "amount", 0, 100000000, { required: !cur });
    if (amount !== undefined) {
      if (!(amount > 0)) throw new Bad(`${MSG.badValue} (amount)`);
      out.amount = amount;
    }
    const method = oneOf(b, "method", ["cash", "bank"]);
    if (method) out.method = method;
    const note = text(b, "note", 200);
    if (note !== undefined) out.note = note;
    return out;
  };
  dual("get", "/expenses", false, async (ctx, req, res) => {
    needEx(ctx);
    const month = monthOf(req.query);
    const rows = await M.GhExpense.find({ business_id: ctx.business._id, day: { $gte: `${month}-01`, $lt: `${nextMonth(month)}-01` } })
      .sort({ day: -1, created_date: -1 })
      .limit(2000)
      .lean();
    const r = round(ctx.settings.currency);
    const by = {};
    for (const x of rows) by[x.category] = (by[x.category] || 0) + x.amount;
    res.json({ success: true, data: { month, rows, total: r(rows.reduce((a, x) => a + x.amount, 0)), by_category: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, r(v)])), categories: M.EXPENSE_CATS } });
  });
  dual("post", "/expenses", true, async (ctx, req, res) => {
    needEx(ctx);
    const row = await M.GhExpense.create({ business_id: ctx.business._id, category: "other", method: "cash", ...readExpense(req.body || {}), by: ctx.by });
    res.status(201).json({ success: true, data: row, message: MSG.saved });
  });
  const loadExpense = async (ctx, eid) => {
    if (!validId(eid)) throw new Bad(MSG.badId);
    const row = await M.GhExpense.findOne({ _id: eid, business_id: ctx.business._id });
    if (!row) throw new Bad(MSG.rowNotFound, 404);
    return row;
  };
  dual("put", "/expenses/:eid", true, async (ctx, req, res) => {
    needEx(ctx);
    managerOnly(ctx);
    const row = await loadExpense(ctx, req.params.eid);
    row.set(readExpense(req.body || {}, row));
    await row.save();
    res.json({ success: true, data: row, message: MSG.saved });
  });
  dual("delete", "/expenses/:eid", true, async (ctx, req, res) => {
    needEx(ctx);
    managerOnly(ctx);
    const row = await loadExpense(ctx, req.params.eid);
    await row.deleteOne();
    res.json({ success: true, message: MSG.saved });
  });

  // money in (payments received) − expenses, this month + the 6 months up to it
  dual("get", "/profit", false, async (ctx, req, res) => {
    needEx(ctx);
    const bid = ctx.business._id;
    const month = monthOf(req.query);
    const months = [month];
    while (months.length < 6) months.unshift(prevMonth(months[0]));
    const startOf = (m) => new Date(Date.parse(`${m}-01T00:00:00Z`) - 7 * 3600000);
    const from = startOf(months[0]);
    const to = startOf(nextMonth(month));
    const [paid, spent] = await Promise.all([
      M.GhStay.aggregate([
        { $match: { business_id: bid, "payments.at": { $gte: from, $lt: to } } },
        { $unwind: "$payments" },
        { $match: { "payments.at": { $gte: from, $lt: to } } },
        { $group: { _id: { m: { $dateToString: { date: "$payments.at", format: "%Y-%m", timezone: "+07:00" } }, method: "$payments.method" }, total: { $sum: "$payments.amount" } } },
      ]),
      M.GhExpense.aggregate([{ $match: { business_id: bid, day: { $gte: `${months[0]}-01`, $lt: `${nextMonth(month)}-01` } } }, { $group: { _id: { m: { $substrBytes: ["$day", 0, 7] }, c: "$category" }, total: { $sum: "$amount" } } }]),
    ]);
    const r = round(ctx.settings.currency);
    const series = months.map((m) => {
      const income = paid.filter((p) => p._id.m === m).reduce((a, p) => a + p.total, 0);
      const expenses = spent.filter((p) => p._id.m === m).reduce((a, p) => a + p.total, 0);
      return { month: m, income: r(income), expenses: r(expenses), profit: r(income - expenses) };
    });
    const now = series[series.length - 1];
    const byMethod = {};
    for (const p of paid.filter((x) => x._id.m === month)) byMethod[p._id.method] = r((byMethod[p._id.method] || 0) + p.total);
    const byCat = {};
    for (const p of spent.filter((x) => x._id.m === month)) byCat[p._id.c] = r((byCat[p._id.c] || 0) + p.total);
    res.json({ success: true, data: { month, ...now, margin: now.income > 0 ? Math.round((now.profit / now.income) * 1000) / 10 : 0, by_method: byMethod, by_category: byCat, series } });
  });
};
