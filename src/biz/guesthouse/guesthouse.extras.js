// Extra services menu (gh_services, forever) + foreign guest report (gh_police, forever)
// Base: /api/user/businesses/:id/guesthouse
//   GET  /services                       { on, price, list, icons }
//   PUT  /services        { list: [{ _id?, name, price, icon, active }] }   (needs gh_services)
//   GET  /services/report?from&to        sales of each service (bill lines added from the menu)
//   GET  /police?from&to&all=1           guests who stayed any night from → to (foreign only unless all=1)  (needs gh_police)
// The desk adds a service with POST /stays/:sid/charges { service_id } (label + price come from the menu).
const mongoose = require("mongoose");
const { priceOf } = require("../../homepage/prices");

const MAX_SERVICES = 40;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const T = {
  needServices: "សូមដោះសោ “ម៉ឺនុយសេវាកម្មបន្ថែម” ជាមុនសិន!",
  needPolice: "សូមដោះសោ “របាយការណ៍ភ្ញៀវបរទេស” ជាមុនសិន!",
  tooMany: `សេវាកម្មច្រើនបំផុត ${MAX_SERVICES}!`,
  badRange: "ជ្រើសថ្ងៃមិនត្រឹមត្រូវ (យ៉ាងច្រើន 93 ថ្ងៃ)!",
};
// "Cambodian" in the ways people type it
const LOCAL = new Set(["", "cambodia", "cambodian", "khmer", "kh", "khm", "kingdom of cambodia", "ខ្មែរ", "កម្ពុជា", "ជនជាតិខ្មែរ", "ព្រះរាជាណាចក្រកម្ពុជា"]);
const isForeign = (g) =>
  !LOCAL.has(
    String(g?.nationality || "")
      .trim()
      .toLowerCase(),
  ) ||
  (g?.id_type === "passport" && !String(g?.nationality || "").trim());
const localDay = (t = Date.now()) => new Date(t + 7 * 3600000).toISOString().slice(0, 10);
const span = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

module.exports = (prop, kit) => {
  const { base, guard, handle, ctxOf, Bad, MSG, text, num, M } = kit;
  const range = (q) => {
    const today = localDay();
    const from = DAY_RE.test(String(q.from || "")) ? String(q.from) : today;
    const to = DAY_RE.test(String(q.to || "")) ? String(q.to) : from;
    if (Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`)) || to < from || span(from, to) > 92) throw new Bad(T.badRange);
    return { from, to };
  };

  // ===================================== EXTRA SERVICES =====================================
  prop.app.get(
    `${base}/services`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      res.json({ success: true, data: { on: !!ctx.addons.gh_services?.active, price: await priceOf("gh_services"), list: ctx.settings.services || [], icons: M.SERVICE_ICONS } });
    }),
  );
  prop.app.put(
    `${base}/services`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, true);
      if (!ctx.addons.gh_services?.active) throw new Bad(T.needServices, 402, { product: "gh_services" });
      const list = Array.isArray(req.body?.list) ? req.body.list : null;
      if (!list) throw new Bad(`${MSG.required}: list`);
      if (list.length > MAX_SERVICES) throw new Bad(T.tooMany);
      const old = new Set((ctx.settings.services || []).map((s) => String(s._id)));
      ctx.settings.services = list.map((row) => {
        const r = row || {};
        const keep = typeof r._id === "string" && old.has(r._id) ? { _id: new mongoose.Types.ObjectId(r._id) } : {};
        return { ...keep, name: text(r, "name", 60, { required: true }), price: num(r, "price", 0, 100000000, { required: true }), icon: M.SERVICE_ICONS.includes(r.icon) ? r.icon : "other", active: r.active !== false };
      });
      await ctx.settings.save();
      res.json({ success: true, data: { list: ctx.settings.services }, message: MSG.saved });
    }),
  );
  prop.app.get(
    `${base}/services/report`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const { from, to } = range(req.query);
      const start = new Date(Date.parse(`${from}T00:00:00Z`) - 7 * 3600000);
      const end = new Date(Date.parse(`${addDays(to, 1)}T00:00:00Z`) - 7 * 3600000);
      const rows = await M.GhStay.aggregate([
        { $match: { business_id: ctx.business._id, status: { $ne: "cancelled" }, "charges.service_id": { $gt: "" } } },
        { $unwind: "$charges" },
        { $match: { "charges.service_id": { $gt: "" }, "charges.at": { $gte: start, $lt: end } } },
        { $group: { _id: "$charges.service_id", label: { $last: "$charges.label" }, qty: { $sum: "$charges.qty" }, total: { $sum: { $multiply: ["$charges.amount", "$charges.qty"] } }, stays: { $addToSet: "$_id" } } },
        { $sort: { total: -1 } },
      ]);
      const names = new Map((ctx.settings.services || []).map((s) => [String(s._id), s]));
      const items = rows.map((r) => ({ service_id: r._id, name: names.get(r._id)?.name || r.label, icon: names.get(r._id)?.icon || "other", qty: r.qty, total: r.total, stays: r.stays.length }));
      res.json({ success: true, data: { from, to, items, total: items.reduce((a, i) => a + i.total, 0), qty: items.reduce((a, i) => a + i.qty, 0) } });
    }),
  );

  // ===================================== FOREIGN GUEST REPORT =====================================
  prop.app.get(
    `${base}/police`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      if (!ctx.addons.gh_police?.active) throw new Bad(T.needPolice, 402, { product: "gh_police" });
      const { from, to } = range(req.query);
      const all = req.query.all === "1" || req.query.all === "true";
      // stayed at least one night from → to (to = the last night)
      const stays = await M.GhStay.find({ business_id: ctx.business._id, status: { $in: ["in", "out"] }, from: { $lte: to }, to: { $gt: from } })
        .sort({ from: 1, created_date: 1 })
        .limit(2000)
        .lean();
      const rooms = new Map((await M.GhRoom.find({ business_id: ctx.business._id }).select("name").lean()).map((r) => [String(r._id), r.name]));
      const rows = stays
        .filter((s) => all || isForeign(s.guest))
        .map((s) => ({
          _id: s._id,
          no: s.no,
          room: rooms.get(String(s.room_id)) || "?",
          from: s.from,
          to: s.to,
          status: s.status,
          adults: s.adults,
          children: s.children,
          checked_in_at: s.checked_in_at,
          checked_out_at: s.checked_out_at,
          foreign: isForeign(s.guest),
          guest: {
            name: s.guest.name,
            phone: s.guest.phone,
            id_type: s.guest.id_type,
            id_number: s.guest.id_number,
            nationality: s.guest.nationality,
            gender: s.guest.gender || "",
            dob: s.guest.dob || "",
            visa_type: s.guest.visa_type || "",
            visa_until: s.guest.visa_until || "",
          },
          missing: [!s.guest.id_number && "id_number", !s.guest.nationality && "nationality", !s.guest.gender && "gender", !s.guest.dob && "dob"].filter(Boolean),
        }));
      const countries = {};
      for (const r of rows) if (r.foreign) countries[r.guest.nationality || "?"] = (countries[r.guest.nationality || "?"] || 0) + 1;
      res.json({ success: true, data: { from, to, all, rows, countries, foreign: rows.filter((r) => r.foreign).length, missing: rows.filter((r) => r.missing.length).length } });
    }),
  );
};
module.exports.isForeign = isForeign;
