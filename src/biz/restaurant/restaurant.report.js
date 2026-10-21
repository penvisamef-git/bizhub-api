// Sales reports — for the owner (dashboard → Reports) and for a linked POS (its "Today" screen).
//
// Owner, base /api/user/businesses/:id/restaurant/report
//   GET /?from=YYYY-MM-DD&to=YYYY-MM-DD      totals + by day / hour / method / item / category / staff / type
//   GET /invoices?from&to&status=all|paid|void&q=&page=1     bills, newest first (format=csv → a CSV file)
//   GET /invoices/:oid                       one bill, everything on it
// Device, header x-device-token
//   GET /api/pos/report?from&to              all devices of the restaurant, any days (+ the newest 500 bills)
//
// Days are Cambodia days (UTC+7). Without the "Full history" add-on (rest_history) only the last 30 days can be seen.
const M = require("./restaurant.models");
const calc = require("./pos.calc");

const TZ = 7;
const FREE_DAYS = 30;
const MAX_DAYS = 366;
const MAX_ORDERS = 20000;
const PAGE = 30;
const BILLS_MAX = 500; // bills sent to a POS report screen (newest first)
const R = {
  badDate: "កាលបរិច្ឆេទមិនត្រឹមត្រូវ",
  tooLong: `ចន្លោះពេលវែងពេក (អតិបរមា ${MAX_DAYS} ថ្ងៃ)`,
  notFound: "រកមិនឃើញវិក្កយបត្រ!",
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - TZ * 3600000);
const localToday = () => calc.localDay(new Date(), TZ).day;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const moneyOf = (s) => ({ currency: s.currency, khr_rate: s.khr_rate, khr_rounding: s.khr_rounding, vat: s.vat, service_charge: s.service_charge });

// the days asked for, kept inside what this restaurant may see
function rangeOf(query, fullHistory, Bad) {
  const today = localToday();
  let to = DAY_RE.test(query.to || "") ? query.to : today;
  let from = DAY_RE.test(query.from || "") ? query.from : to;
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new Bad(R.badDate);
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;
  if (from > to) from = to;
  if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > MAX_DAYS) throw new Bad(R.tooLong);
  const earliest = fullHistory ? null : addDays(today, -(FREE_DAYS - 1));
  let limited = false;
  if (earliest && from < earliest) {
    from = earliest;
    limited = true;
    if (to < earliest) to = earliest;
  }
  return { from, to, start: dayStart(from), end: dayStart(addDays(to, 1)), limited, earliest, days: (Date.parse(to) - Date.parse(from)) / 86400000 + 1 };
}

// paid bills by the time they were paid, cancelled ones by the time they were opened
const ordersFilter = (bid, start, end) => ({
  business_id: bid,
  $or: [
    { status: "paid", paid_at: { $gte: start, $lt: end } },
    { status: "void", opened_at: { $gte: start, $lt: end } },
  ],
});

async function buildReport(bid, settings, start, end) {
  const [orders, items, categories] = await Promise.all([
    M.RestOrder.find(ordersFilter(bid, start, end))
      .select("status type guests lines payments change discount paid_at opened_at opened_by closed_by")
      .limit(MAX_ORDERS)
      .lean(),
    M.RestItem.find({ business_id: bid }).select("category_id").lean(),
    M.RestCategory.find({ business_id: bid }).select("name_km name_en color").lean(),
  ]);
  const catOfItem = new Map(items.map((i) => [String(i._id), String(i.category_id || "")]));
  const report = calc.salesReport(orders, moneyOf(settings), { catOf: (id) => catOfItem.get(String(id)) || "", tzHours: TZ });
  const names = new Map(categories.map((c) => [String(c._id), c]));
  report.by_category = report.by_category.map((c) => ({ ...c, name_km: names.get(c.category_id)?.name_km || "", name_en: names.get(c.category_id)?.name_en || "", color: names.get(c.category_id)?.color || "" }));
  report.truncated = orders.length >= MAX_ORDERS;
  return report;
}

// a bill in a list (light)
function invoiceRow(o, devices) {
  const methods = [...new Set((o.payments || []).map((p) => p.method || p.kind).filter(Boolean))];
  return {
    _id: o._id,
    number: o.number,
    status: o.status,
    type: o.type,
    table_name: o.table_name,
    guests: o.guests || 0,
    total: o.totals?.total || 0,
    discount: o.totals?.discount || 0,
    items: o.totals?.items || 0,
    methods,
    opened_by: o.opened_by?.name || "",
    closed_by: o.closed_by?.name || "",
    opened_at: o.opened_at,
    paid_at: o.paid_at,
    void_reason: o.void_reason || "",
    device_name: devices?.get(String(o.device_id)) || "",
  };
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const localTime = (d) => (d ? new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 16).replace("T", " ") : "");

module.exports = (prop, kit) => {
  const { base, guard, handle, withSettings, ctxOf, Bad } = kit;
  const path = `${base}/report`;
  const full = (state) => !!state.addons?.rest_history?.active;

  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      const range = rangeOf(req.query, full(ctx), Bad);
      const bid = ctx.business._id;
      // the same number of days just before, for "compared with before"
      const prevStart = new Date(range.start.getTime() - range.days * 86400000);
      const prevAllowed = !range.earliest || prevStart >= dayStart(range.earliest);
      const [report, prev] = await Promise.all([
        buildReport(bid, settings, range.start, range.end),
        prevAllowed
          ? M.RestOrder.find({ business_id: bid, status: "paid", paid_at: { $gte: prevStart, $lt: range.start } })
              .select("totals.total")
              .limit(MAX_ORDERS)
              .lean()
          : null,
      ]);
      res.json({
        success: true,
        data: {
          range: { from: range.from, to: range.to, days: range.days, today: localToday() },
          history: { full: full(ctx), earliest: range.earliest, limited: range.limited, free_days: FREE_DAYS },
          money: moneyOf(settings),
          report,
          prev: prev
            ? {
                sales: calc.money(
                  prev.reduce((a, o) => a + (o.totals?.total || 0), 0),
                  moneyOf(settings),
                ),
                bills: prev.length,
              }
            : null,
        },
      });
    }),
  );

  prop.app.get(
    `${path}/invoices`,
    ...guard,
    handle(async (req, res) => {
      const ctx = await ctxOf(req, false);
      const range = rangeOf(req.query, full(ctx), Bad);
      const bid = ctx.business._id;
      const status = ["paid", "void", "open"].includes(req.query.status) ? req.query.status : "all";
      let filter = ordersFilter(bid, range.start, range.end);
      if (status === "paid") filter = { business_id: bid, status: "paid", paid_at: { $gte: range.start, $lt: range.end } };
      if (status === "void") filter = { business_id: bid, status: "void", opened_at: { $gte: range.start, $lt: range.end } };
      if (status === "open") filter = { business_id: bid, status: "open" };
      const q = String(req.query.q || "")
        .trim()
        .slice(0, 40);
      if (q) filter = { $and: [filter, { $or: [{ number: { $regex: escapeRe(q), $options: "i" } }, { table_name: { $regex: escapeRe(q), $options: "i" } }, { "closed_by.name": { $regex: escapeRe(q), $options: "i" } }] }] };
      const devices = new Map((await M.RestDevice.find({ business_id: bid }).select("name").lean()).map((d) => [String(d._id), d.name]));
      const fields = "number status type table_name guests totals payments.method payments.kind opened_by closed_by opened_at paid_at void_reason device_id currency";

      if (req.query.format === "csv") {
        const rows = await M.RestOrder.find(filter).select(fields).sort({ opened_at: -1 }).limit(5000).lean();
        const head = ["Number", "Status", "Type", "Table", "Guests", "Items", "Discount", "Total", "Currency", "Payment", "Opened by", "Paid by", "Opened", "Paid", "Device", "Cancel reason"];
        const body = rows.map((o) => {
          const x = invoiceRow(o, devices);
          return [x.number, x.status, x.type, x.table_name, x.guests, x.items, x.discount, x.total, o.currency || "", x.methods.join(" + "), x.opened_by, x.closed_by, localTime(x.opened_at), localTime(x.paid_at), x.device_name, x.void_reason]
            .map(csvCell)
            .join(",");
        });
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="invoices-${range.from}-to-${range.to}.csv"`);
        return res.send(`﻿${[head.join(","), ...body].join("\r\n")}`);
      }

      const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
      const [rows, total] = await Promise.all([
        M.RestOrder.find(filter)
          .select(fields)
          .sort({ opened_at: -1 })
          .skip((page - 1) * PAGE)
          .limit(PAGE)
          .lean(),
        M.RestOrder.countDocuments(filter),
      ]);
      res.json({
        success: true,
        data: rows.map((o) => invoiceRow(o, devices)),
        range: { from: range.from, to: range.to },
        history: { full: full(ctx), earliest: range.earliest, limited: range.limited },
        pagination: { total, totalPages: Math.max(1, Math.ceil(total / PAGE)), currentPage: page, pageSize: PAGE },
      });
    }),
  );

  prop.app.get(
    `${path}/invoices/:oid`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      const oid = String(req.params.oid || "");
      if (!/^[A-Za-z0-9-]{16,40}$/.test(oid)) throw new Bad(R.notFound, 404);
      const o = await M.RestOrder.findOne({ _id: oid, business_id: ctx.business._id }).lean();
      if (!o) throw new Bad(R.notFound, 404);
      // older than what this restaurant may see?
      if (!full(ctx)) {
        const earliest = dayStart(addDays(localToday(), -(FREE_DAYS - 1)));
        if (new Date(o.paid_at || o.opened_at) < earliest && o.status !== "open") throw new Bad(R.notFound, 404, { history: true });
      }
      const device = o.device_id ? await M.RestDevice.findById(o.device_id).select("name").lean() : null;
      // money settings saved on the bill when it was synced (rate of that day), the rest from today's settings
      const money = { ...moneyOf(settings), currency: o.currency || settings.currency, khr_rate: o.khr_rate || settings.khr_rate };
      res.json({
        success: true,
        data: {
          order: { ...o, totals: calc.calcOrder(o, money), device_name: device?.name || "" },
          money,
          restaurant: {
            name_km: settings.name_km,
            name_en: settings.name_en,
            logo: settings.logo?.url || "",
            phone: settings.phone,
            address: settings.address,
            tin: settings.tin,
            receipt: { size: settings.receipt_size, footer: settings.receipt_footer, wifi_name: settings.wifi_name, wifi_pass: settings.wifi_pass, theme: settings.receipt_theme || "classic" },
          },
        },
      });
    }),
  );

  // ---------- the POS's own report screen (all devices, any days) ----------
  prop.app.get(
    "/api/pos/report",
    prop.api_auth,
    handle(async (req, res) => {
      const { business, settings, state } = await kit.deviceOf(req);
      const range = rangeOf(req.query, full(state), Bad);
      const devices = new Map((await M.RestDevice.find({ business_id: business._id }).select("name").lean()).map((d) => [String(d._id), d.name]));
      const filter = ordersFilter(business._id, range.start, range.end);
      const [report, rows, count] = await Promise.all([buildReport(business._id, settings, range.start, range.end), M.RestOrder.find(filter).sort({ opened_at: -1 }).limit(BILLS_MAX).lean(), M.RestOrder.countDocuments(filter)]);
      res.json({
        success: true,
        data: {
          day: range.to,
          range: { from: range.from, to: range.to, days: range.days, today: localToday() },
          history: { full: full(state), earliest: range.earliest, limited: range.limited, free_days: FREE_DAYS },
          report,
          orders: rows.map((o) => ({ ...o, device_name: devices.get(String(o.device_id)) || "" })),
          bills_total: count,
        },
      });
    }),
  );
};

module.exports.rangeOf = rangeOf;
