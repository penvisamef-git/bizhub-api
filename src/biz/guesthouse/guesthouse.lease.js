// Long stay / monthly rent (gh_longstay, yearly): a tenant rents a room by the month.
// The lease is a stay (it holds the room, shows on the calendar); each month's bill (rent, electricity, water,
// fixed extras) goes onto it as bill lines, and payments are the stay's payments — so reports, receipts and
// Telegram alerts work as for any stay.
// Both doors (owner + desk POS):
//   GET  /leases                         tenants + this month's bill state + what they owe
//   POST /leases     { room_id, guest, start, end, rent, deposit, elec_rate, water_rate, fixed, bill_day, meter, deposit_method }
//   PUT  /leases/:sid  terms                                           (owner / manager)
//   POST /leases/:sid/bill { month, elec, water }   readings → the month's bill lines
//   POST /leases/:sid/end  { day, force, refund_deposit, method }   the tenant moves out
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FAR_DAYS = 3650; // open-ended lease: the room is held this far ahead
const T = {
  need: "សូមដោះសោ “ការជួលប្រចាំខែ” ជាមុនសិន!",
  notLease: "នេះមិនមែនជាការជួលប្រចាំខែទេ!",
  billed: "ខែនេះបានចេញវិក្កយបត្ររួចហើយ!",
  meterBack: "លេខកុងទ័រថ្មីតូចជាងលេខចាស់!",
  ended: "ការជួលនេះបានបញ្ចប់ហើយ!",
  badDates: "ថ្ងៃមិនត្រឹមត្រូវ!",
};
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

module.exports = (prop, kit) => {
  const { dual, Bad, MSG, text, num, oneOf, validId, realDay, localDay, addDays, managerOnly, M, billOf, reply, readGuest, taken } = kit;
  const need = (ctx) => {
    if (!ctx.addons.gh_longstay?.active) throw new Bad(T.need, 402, { product: "gh_longstay" });
  };
  const r2 = (ctx) => (v) => (ctx.settings.currency === "KHR" ? Math.round(v) : Math.round(v * 100) / 100);
  const readTerms = (b, cur = {}) => {
    const out = {};
    for (const [k, max] of [
      ["rent", 100000000],
      ["deposit", 100000000],
      ["elec_rate", 1000000],
      ["water_rate", 1000000],
    ]) {
      const v = num(b, k, 0, max);
      if (v !== undefined) out[k] = v;
    }
    const day = num(b, "bill_day", 1, 28, { int: true });
    if (day !== undefined) out.bill_day = day;
    if (Array.isArray(b.fixed)) out.fixed = b.fixed.slice(0, 10).map((f) => ({ label: text(f || {}, "label", 60, { required: true }), amount: num(f || {}, "amount", 0, 100000000, { required: true }) }));
    if (b.end !== undefined) {
      const end = String(b.end || "");
      if (end && (!realDay(end) || end <= (cur.start || b.start || ""))) throw new Bad(T.badDates, 400, { code: "bad_dates" });
      out.end = end;
    }
    return out;
  };
  const loadLease = async (ctx, sid) => {
    if (!validId(sid)) throw new Bad(MSG.badId);
    const s = await M.GhStay.findOne({ _id: sid, business_id: ctx.business._id });
    if (!s) throw new Bad(MSG.rowNotFound, 404);
    if (!s.lease) throw new Bad(T.notLease, 409, { code: "not_lease" });
    return s;
  };
  // the month a bill is for: from the bill day on, it's this month's bill
  const dueMonth = (lease, today) => (Number(today.slice(8)) >= (lease.bill_day || 1) ? today.slice(0, 7) : null);

  dual("get", "/leases", false, async (ctx, req, res) => {
    need(ctx);
    const bid = ctx.business._id;
    const today = localDay();
    const since = addDays(today, -62);
    const rows = await M.GhStay.find({ business_id: bid, lease: { $exists: true }, $or: [{ status: { $in: M.LIVE } }, { status: "out", checked_out_at: { $gte: new Date(Date.parse(`${since}T00:00:00Z`)) } }] })
      .sort({ status: 1, from: 1 })
      .lean();
    const rooms = new Map((await M.GhRoom.find({ business_id: bid }).select("name type_id").lean()).map((x) => [String(x._id), x]));
    const month = today.slice(0, 7);
    const list = rows.map((s) => {
      const bill = billOf(s, ctx.settings.currency);
      const billedThis = (s.lease.bills || []).some((b) => b.month === month);
      const due = M.LIVE.includes(s.status) && !billedThis && dueMonth(s.lease, today) === month && s.lease.start <= today;
      return {
        _id: s._id,
        no: s.no,
        status: s.status,
        room_id: s.room_id,
        room_name: rooms.get(String(s.room_id))?.name || "?",
        guest: s.guest,
        from: s.from,
        to: s.to,
        lease: s.lease,
        bill,
        billed_this: billedThis,
        bill_due: due,
        last_bill: (s.lease.bills || []).slice(-1)[0] || null,
      };
    });
    const live = list.filter((x) => M.LIVE.includes(x.status));
    res.json({
      success: true,
      data: {
        month,
        list,
        counts: { tenants: live.length, to_bill: live.filter((x) => x.bill_due).length, owing: live.filter((x) => x.bill.balance > 0).length },
        owed: r2(ctx)(live.reduce((a, x) => a + Math.max(0, x.bill.balance), 0)),
        rent_month: r2(ctx)(live.reduce((a, x) => a + (x.lease.rent || 0), 0)),
      },
    });
  });

  dual("post", "/leases", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const bid = ctx.business._id;
    const b = req.body || {};
    const today = localDay();
    const start = String(b.start || today);
    if (!realDay(start) || start < addDays(today, -366) || start > addDays(today, 366)) throw new Bad(T.badDates, 400, { code: "bad_dates" });
    const terms = readTerms(b, { start });
    if (!terms.rent) throw new Bad(`${MSG.required}: rent`);
    if (!validId(String(b.room_id || ""))) throw new Bad(`${MSG.required}: room_id`);
    const room = await M.GhRoom.findOne({ _id: b.room_id, business_id: bid, active: true }).lean();
    if (!room) throw new Bad(`${MSG.badValue} (room_id)`);
    const to = terms.end || addDays(start, FAR_DAYS);
    if (await taken(bid, room._id, start, to)) throw new Bad(MSG.taken, 409, { code: "taken" });
    const meter = { elec: num(b.meter || {}, "elec", 0, 100000000) || 0, water: num(b.meter || {}, "water", 0, 100000000) || 0 };
    const now = start <= today;
    const deposit = terms.deposit || 0;
    const counter = await M.GhSettings.findOneAndUpdate({ business_id: bid }, { $inc: { next_no: 1 } }, { returnDocument: "before" });
    const stay = await M.GhStay.create({
      business_id: bid,
      no: `B-${String(counter.next_no).padStart(4, "0")}`,
      room_id: room._id,
      status: now ? "in" : "booked",
      from: start,
      to,
      rate: 0,
      guest: readGuest(b),
      adults: num(b, "adults", 1, 20, { int: true }) ?? 1,
      children: num(b, "children", 0, 20, { int: true }) ?? 0,
      source: "other",
      note: text(b, "note", 500) || "",
      checked_in_at: now ? new Date() : null,
      by: ctx.by,
      lease: { rent: 0, deposit: 0, elec_rate: 0, water_rate: 0, fixed: [], bill_day: 1, ...terms, start, end: terms.end || "", meter, bills: [] },
      // the deposit is money held: on the bill as a line, paid now when taken
      charges: deposit > 0 ? [{ label: "Deposit", amount: deposit, qty: 1, by: ctx.by }] : [],
      payments: deposit > 0 && b.deposit_paid !== false ? [{ method: oneOf(b, "deposit_method", M.METHODS) || "cash", amount: deposit, note: "deposit", by: ctx.by }] : [],
    });
    await reply(res, ctx, stay, 201);
  });

  dual("put", "/leases/:sid", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const s = await loadLease(ctx, req.params.sid);
    if (!M.LIVE.includes(s.status)) throw new Bad(T.ended, 409, { code: "ended" });
    const b = req.body || {};
    const terms = readTerms(b, s.lease);
    if (terms.end !== undefined) {
      const to = terms.end || addDays(s.lease.start, FAR_DAYS);
      if (to !== s.to && (await taken(ctx.business._id, s.room_id, s.from, to, s._id))) throw new Bad(MSG.taken, 409, { code: "taken" });
      s.to = to;
    }
    for (const [k, v] of Object.entries(terms)) s.lease[k] = v;
    if (b.guest !== undefined) s.guest = readGuest(b, s.guest.toObject ? s.guest.toObject() : s.guest);
    s.markModified("lease");
    await s.save();
    await reply(res, ctx, s);
  });

  // the month's bill from the meter readings
  dual("post", "/leases/:sid/bill", true, async (ctx, req, res) => {
    need(ctx);
    const s = await loadLease(ctx, req.params.sid);
    if (!M.LIVE.includes(s.status)) throw new Bad(T.ended, 409, { code: "ended" });
    const b = req.body || {};
    const month = MONTH_RE.test(String(b.month || "")) ? String(b.month) : localDay().slice(0, 7);
    if ((s.lease.bills || []).some((x) => x.month === month)) throw new Bad(T.billed, 409, { code: "billed" });
    const L = s.lease;
    const ePrev = L.meter?.elec || 0;
    const wPrev = L.meter?.water || 0;
    const eCur = num(b, "elec", 0, 100000000) ?? ePrev;
    const wCur = num(b, "water", 0, 100000000) ?? wPrev;
    if (eCur < ePrev || wCur < wPrev) throw new Bad(T.meterBack, 400, { code: "meter_back" });
    const r = r2(ctx);
    const m = monthName(month);
    const lines = [];
    if (L.rent) lines.push({ label: `Rent ${m}`, amount: L.rent });
    if (L.elec_rate && eCur > ePrev) lines.push({ label: `Electricity ${m} · ${ePrev}→${eCur} = ${Math.round((eCur - ePrev) * 100) / 100} kWh`, amount: r((eCur - ePrev) * L.elec_rate) });
    if (L.water_rate && wCur > wPrev) lines.push({ label: `Water ${m} · ${wPrev}→${wCur} = ${Math.round((wCur - wPrev) * 100) / 100} m³`, amount: r((wCur - wPrev) * L.water_rate) });
    for (const f of L.fixed || []) if (f.amount) lines.push({ label: `${f.label} ${m}`, amount: f.amount });
    for (const l of lines) s.charges.push({ label: l.label.slice(0, 80), amount: l.amount, qty: 1, by: ctx.by });
    L.meter = { elec: eCur, water: wCur };
    L.bills.push({ month, elec_prev: ePrev, elec_cur: eCur, water_prev: wPrev, water_cur: wCur, total: r(lines.reduce((a, l) => a + l.amount, 0)), at: new Date(), by: ctx.by });
    // keep an open-ended lease holding the room
    if (!L.end && s.to < addDays(localDay(), 365)) s.to = addDays(localDay(), FAR_DAYS);
    s.markModified("lease");
    await s.save();
    await reply(res, ctx, s, 201);
  });

  // the tenant moves out (the stay ends today, or on the day given)
  dual("post", "/leases/:sid/end", true, async (ctx, req, res) => {
    need(ctx);
    managerOnly(ctx);
    const s = await loadLease(ctx, req.params.sid);
    if (!M.LIVE.includes(s.status)) throw new Bad(T.ended, 409, { code: "ended" });
    const b = req.body || {};
    const today = localDay();
    const day = realDay(String(b.day || "")) ? String(b.day) : today;
    if (s.status === "booked") {
      s.status = "cancelled";
      s.cancelled_at = new Date();
      await s.save();
      return reply(res, ctx, s);
    }
    // give the deposit back: its bill line goes, and the money goes out as a refund
    if (b.refund_deposit === true) {
      const dep = s.charges.find((c) => c.label === "Deposit");
      if (dep) {
        s.payments.push({ method: oneOf(b, "method", M.METHODS) || "cash", amount: -dep.amount * (dep.qty || 1), note: "deposit back", by: ctx.by });
        dep.deleteOne();
      }
    }
    const bill = billOf(s, ctx.settings.currency);
    if (bill.balance !== 0 && b.force !== true) throw new Bad(MSG.unpaid.replace("{amt}", String(Math.abs(bill.balance))), 409, { code: bill.balance > 0 ? "unpaid" : "refund", balance: bill.balance });
    s.to = day > s.from ? day : addDays(s.from, 1);
    s.lease.end = s.to;
    s.status = "out";
    s.checked_out_at = new Date();
    s.markModified("lease");
    await s.save();
    if (ctx.addons.gh_housekeeping?.active) await M.GhRoom.updateOne({ _id: s.room_id, business_id: ctx.business._id }, { $set: { hk: "dirty", hk_at: new Date(), hk_by: ctx.by, hk_note: "" } });
    await require("./guesthouse.guests")
      .afterCheckout(ctx, s, billOf(s, ctx.settings.currency))
      .catch(() => {});
    await reply(res, ctx, s);
  });
};
