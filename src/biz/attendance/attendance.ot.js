// Overtime requests (free, part of Payroll): staff ask "I'll stay until 19:00" before staying late; the owner approves.
// With payroll.ot_approval on, only approved overtime is paid (a day's overtime stops at the approved time).
// Staff (x-att-token): GET /api/att/overtime   POST /api/att/overtime { day, until, reason }   DELETE /api/att/overtime/:oid
// Owner: GET /overtime?status=pending|all   POST /overtime/:oid/decide { status: approved|rejected, note }
const M = require("./attendance.models");
const C = require("./attendance.calc");

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, staffCtx, Bad, MSG, text, validId, ownerName, DAY_RE, hooks } = kit;
  const T = {
    badDay: "ថ្ងៃមិនត្រឹមត្រូវ!",
    range: "អាចស្នើបានពី 7 ថ្ងៃមុន ដល់ 14 ថ្ងៃខាងមុខ",
    needReason: "សូមសរសេរមូលហេតុ",
    same: "អ្នកបានស្នើសម្រាប់ថ្ងៃនេះរួចហើយ",
    done: "សំណើនេះបានសម្រេចរួចហើយ",
    sent: "បានផ្ញើសំណើហើយ!",
  };
  const out = (o) => ({ _id: o._id, day: o.day, until: o.until, reason: o.reason, status: o.status, note: o.note, by: o.by, decided_at: o.decided_at, created_date: o.created_date });

  hooks.decide.overtime = async (bid, oid, status, note, by) => {
    const row = await M.AttOvertime.findOneAndUpdate({ _id: oid, business_id: bid, status: "pending" }, { $set: { status, note, by, decided_at: new Date() } }, { returnDocument: "after" }).lean();
    if (!row) throw new Bad(T.done, 409);
    return out(row);
  };

  prop.app.get(
    "/api/att/overtime",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      const rows = await M.AttOvertime.find({ business_id: ctx.staff.business_id, staff_id: ctx.staff._id }).sort({ created_date: -1 }).limit(30).lean();
      res.json({ success: true, data: rows.map(out) });
    }),
  );
  prop.app.post(
    "/api/att/overtime",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      const { staff, settings } = ctx;
      const bid = staff.business_id;
      const b = req.body || {};
      const day = String(b.day || "");
      if (!DAY_RE.test(day)) throw new Bad(T.badDay);
      const today = C.localDay(Date.now());
      if (day < C.addDays(today, -7) || day > C.addDays(today, 14)) throw new Bad(T.range);
      const until = String(b.until || "");
      if (!M.HHMM.test(until)) throw new Bad(`${MSG.badValue} (until)`);
      const reason = text(b, "reason", 300);
      if (!reason) throw new Bad(T.needReason, 400, { code: "need_reason" });
      if (await M.AttOvertime.exists({ business_id: bid, staff_id: staff._id, day, status: { $in: ["pending", "approved"] } })) throw new Bad(T.same, 409);
      const row = await M.AttOvertime.create({ business_id: bid, staff_id: staff._id, day, until, reason });
      if (hooks.notify) {
        const e = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        hooks.notify(bid, settings, `🕗 <b>${e(ctx.business.name)}</b>\n<b>${e(staff.name)}</b> asks for overtime on ${day} until ${until}\n“${e(reason)}”\nApprove in BizHub · សូមពិនិត្យក្នុង BizHub`, ctx).catch(() => {});
      }
      res.status(201).json({ success: true, data: out(row), message: T.sent });
    }),
  );
  prop.app.delete(
    "/api/att/overtime/:oid",
    prop.api_auth,
    handle(async (req, res) => {
      const ctx = await staffCtx(req, false);
      if (!validId(req.params.oid)) throw new Bad(MSG.badId);
      const row = await M.AttOvertime.findOneAndUpdate({ _id: req.params.oid, business_id: ctx.staff.business_id, staff_id: ctx.staff._id, status: "pending" }, { $set: { status: "cancelled" } }, { returnDocument: "after" }).lean();
      if (!row) throw new Bad(T.done, 409);
      res.json({ success: true, data: out(row) });
    }),
  );

  prop.app.get(
    `${base}/overtime`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const bid = ctx.business._id;
      const filter = { business_id: bid, ...(req.query.status === "all" ? { status: { $ne: "cancelled" } } : { status: "pending" }) };
      const rows = await M.AttOvertime.find(filter).sort({ day: -1, created_date: -1 }).limit(100).lean();
      const staff = await M.AttStaff.find({ _id: { $in: rows.map((r) => r.staff_id) } })
        .select("name position")
        .lean();
      const byId = new Map(staff.map((s) => [String(s._id), s]));
      res.json({ success: true, data: rows.map((r) => ({ ...out(r), staff: byId.get(String(r.staff_id)) || { name: "—" } })), pending: await M.AttOvertime.countDocuments({ business_id: bid, status: "pending" }) });
    }),
  );
  prop.app.post(
    `${base}/overtime/:oid/decide`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!validId(req.params.oid)) throw new Bad(MSG.badId);
      const status = ["approved", "rejected"].includes(req.body?.status) ? req.body.status : null;
      if (!status) throw new Bad(`${MSG.required}: status`);
      const note = text(req.body || {}, "note", 300) || "";
      const row = await hooks.decide.overtime(ctx.business._id, req.params.oid, status, note, ownerName(req));
      res.json({ success: true, data: row, pending: await M.AttOvertime.countDocuments({ business_id: ctx.business._id, status: "pending" }), message: MSG.saved });
    }),
  );
};
