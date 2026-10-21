// Weekly roster add-on (att_roster, yearly): pick each staff's shift — or a day off — day by day.
// A day with no roster entry keeps the staff's usual shift. Staff see "My schedule" (next 7 days) on their phone.
// Base: /api/user/businesses/:id/attendance
//   GET  /roster?from=YYYY-MM-DD&days=7     the week: staff, shifts, entries, holidays
//   PUT  /roster  { entries: [{ staff_id, day, shift: "<shift id>" | "off" | "default" }] }
//   POST /roster/copy  { from, to }          copy the 7 days from `from` onto the 7 days from `to`
//   POST /roster/clear { from }              back to the usual shifts for 7 days
const mongoose = require("mongoose");
const M = require("./attendance.models");
const C = require("./attendance.calc");
const { holidayMap } = require("./attendance.days");

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, Bad, MSG, validId, DAY_RE, staffOut } = kit;
  const R = { need: "សូមដោះសោ “តារាងវេនប្រចាំសប្តាហ៍” ជាមុនសិន!", badDay: "ថ្ងៃមិនត្រឹមត្រូវ!" };
  const need = (ctx) => {
    if (!ctx.addons.att_roster?.active) throw new Bad(R.need, 402, { product: "att_roster" });
  };
  const week = (from, n = 7) => Array.from({ length: n }, (_, i) => C.addDays(from, i));
  const dayOf = (v) => {
    const d = String(v || "");
    if (!DAY_RE.test(d)) throw new Bad(R.badDay);
    return d;
  };

  prop.app.get(
    `${base}/roster`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const from = DAY_RE.test(String(req.query.from || "")) ? String(req.query.from) : C.localDay(Date.now());
      const n = Math.min(31, Math.max(1, parseInt(req.query.days, 10) || 7));
      const days = week(from, n);
      const [staff, shifts, entries, hol] = await Promise.all([
        M.AttStaff.find({ business_id: bid, active: true }).sort({ sort: 1, created_date: 1 }).lean(),
        M.AttShift.find({ business_id: bid }).sort({ sort: 1, created_date: 1 }).lean(),
        M.AttRoster.find({ business_id: bid, day: { $gte: days[0], $lte: days[days.length - 1] } }).lean(),
        holidayMap(bid, days[0], days[days.length - 1]),
      ]);
      res.json({
        success: true,
        data: {
          on: !!ctx.addons.att_roster?.active,
          from,
          days,
          staff: staff.map(staffOut),
          shifts,
          entries: entries.map((e) => ({ staff_id: e.staff_id, day: e.day, shift_id: e.shift_id })),
          holidays: Object.fromEntries(hol),
        },
      });
    }),
  );

  prop.app.put(
    `${base}/roster`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const bid = ctx.business._id;
      const list = req.body?.entries;
      if (!Array.isArray(list) || !list.length || list.length > 1000) throw new Bad(`${MSG.badValue} (entries)`);
      const [staff, shifts] = await Promise.all([M.AttStaff.find({ business_id: bid }).select("_id").lean(), M.AttShift.find({ business_id: bid }).select("_id").lean()]);
      const okStaff = new Set(staff.map((s) => String(s._id)));
      const okShift = new Set(shifts.map((s) => String(s._id)));
      const ops = list.map((e) => {
        if (!validId(e?.staff_id) || !okStaff.has(String(e.staff_id))) throw new Bad(`${MSG.badValue} (staff_id)`);
        const day = dayOf(e.day);
        const filter = { business_id: bid, staff_id: new mongoose.Types.ObjectId(String(e.staff_id)), day };
        if (e.shift === "default") return { deleteOne: { filter } };
        if (e.shift !== "off" && !(validId(e.shift) && okShift.has(String(e.shift)))) throw new Bad(`${MSG.badValue} (shift)`);
        const shift_id = e.shift === "off" ? null : new mongoose.Types.ObjectId(String(e.shift));
        return { updateOne: { filter, update: { $set: { shift_id }, $setOnInsert: filter }, upsert: true } };
      });
      await M.AttRoster.bulkWrite(ops, { ordered: false });
      res.json({ success: true, changed: ops.length, message: MSG.saved });
    }),
  );

  prop.app.post(
    `${base}/roster/copy`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const bid = ctx.business._id;
      const from = dayOf(req.body?.from);
      const to = dayOf(req.body?.to);
      const src = week(from);
      const dst = week(to);
      const rows = await M.AttRoster.find({ business_id: bid, day: { $gte: src[0], $lte: src[6] } }).lean();
      await M.AttRoster.deleteMany({ business_id: bid, day: { $gte: dst[0], $lte: dst[6] } });
      const shift = (d) => dst[src.indexOf(d)];
      if (rows.length)
        await M.AttRoster.insertMany(
          rows.map((r) => ({ business_id: bid, staff_id: r.staff_id, day: shift(r.day), shift_id: r.shift_id })),
          { ordered: false },
        );
      res.json({ success: true, copied: rows.length, message: MSG.saved });
    }),
  );

  prop.app.post(
    `${base}/roster/clear`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      need(ctx);
      const days = week(dayOf(req.body?.from));
      const r = await M.AttRoster.deleteMany({ business_id: ctx.business._id, day: { $gte: days[0], $lte: days[6] } });
      res.json({ success: true, removed: r.deletedCount, message: MSG.saved });
    }),
  );
};
