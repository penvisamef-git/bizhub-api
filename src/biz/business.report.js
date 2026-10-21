// Super admin: one business in detail
//   GET /api/admin/businesses/:id/report
//     business (+ owner), licenses (year + add-ons, with status), coins it cost, sales (restaurants, guest houses,
//     mini marts: today, this month, last 30 days, by day), its data (records per table), the owner's other businesses
const mongoose = require("mongoose");
const Business = require("./business.model");
const License = require("../license/license.model");
const CoinTransaction = require("../coin/coin_transaction.model");
const { statusOf } = require("../license/license.service");
const { only_super_admin } = require("../util/permission");

const TZ = 7;
const DAY = 86400000;
const localDay = (d) => new Date(new Date(d).getTime() + TZ * 3600000).toISOString().slice(0, 10);
const dayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - TZ * 3600000);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// money received per Cambodia day, for the business types that sell
async function salesOf(b, from) {
  const bid = b._id;
  const fmt = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: "+07:00" } });
  if (b.category === "restaurant") {
    const M = require("./restaurant/restaurant.models");
    const st = await M.RestSettings.findOne({ business_id: bid }).select("currency").lean();
    const rows = await M.RestOrder.aggregate([{ $match: { business_id: bid, status: "paid", paid_at: { $gte: dayStart(from) } } }, { $group: { _id: fmt("$paid_at"), sales: { $sum: "$totals.total" }, bills: { $sum: 1 } } }]);
    return { currency: st?.currency || "USD", rows };
  }
  if (b.category === "mart") {
    const M = require("./mart/mart.models");
    const st = await M.MartSettings.findOne({ business_id: bid }).select("currency").lean();
    const rows = await M.MartSale.aggregate([{ $match: { business_id: bid, status: "paid", at: { $gte: dayStart(from) } } }, { $group: { _id: fmt("$at"), sales: { $sum: "$total" }, bills: { $sum: 1 } } }]);
    return { currency: st?.currency || "USD", rows };
  }
  if (b.category === "guest_house") {
    const G = require("./guesthouse/guesthouse.models");
    const st = await G.GhSettings.findOne({ business_id: bid }).select("currency").lean();
    const rows = await G.GhStay.aggregate([
      { $match: { business_id: bid, "payments.at": { $gte: dayStart(from) } } },
      { $unwind: "$payments" },
      { $match: { "payments.at": { $gte: dayStart(from) } } },
      { $group: { _id: fmt("$payments.at"), sales: { $sum: "$payments.amount" }, bills: { $sum: 1 } } },
    ]);
    return { currency: st?.currency || "USD", rows };
  }
  return null;
}

module.exports = (prop) => {
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  prop.app.get(`/${prop.main_route}/businesses/:id/report`, ...guard, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
      const b = await Business.findOne({ _id: req.params.id, deleted: false }).populate("owner_id", "name email phone status created_date").lean();
      if (!b) return res.status(404).json({ success: false, message: "Not found" });
      const bid = b._id;
      const today = localDay(new Date());
      const from = addDays(today, -29);
      const monthStart = `${today.slice(0, 7)}-01`;
      const start = [from, monthStart].sort()[0];
      const [licenses, spent, recentTx, sales, others] = await Promise.all([
        License.find({ business_id: bid }).sort({ product: 1, item: 1 }).lean(),
        CoinTransaction.aggregate([{ $match: { business_id: bid } }, { $group: { _id: null, coins: { $sum: "$amount" }, n: { $sum: 1 } } }]),
        CoinTransaction.find({ business_id: bid }).sort({ created_date: -1 }).limit(12).select("amount service note created_date").lean(),
        salesOf(b, start),
        Business.find({ owner_id: b.owner_id?._id, deleted: false, _id: { $ne: bid } })
          .select("name category status")
          .lean(),
      ]);
      // its data: how many records it has in each table (the biggest first)
      const models = Object.values(mongoose.models).filter((M) => M.schema.path("business_id") && !["CoinTransaction", "ActivityLog", "License"].includes(M.modelName));
      const counts = (await Promise.all(models.map(async (M) => [M.modelName, await M.countDocuments({ business_id: bid })]))).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
      let money = null;
      if (sales) {
        const byDay = new Map(sales.rows.map((x) => [x._id, x]));
        const series = [];
        for (let d = from; d <= today; d = addDays(d, 1)) series.push({ day: d, sales: byDay.get(d)?.sales || 0, bills: byDay.get(d)?.bills || 0 });
        const sum = (list) => list.reduce((a, x) => ({ sales: a.sales + x.sales, bills: a.bills + x.bills }), { sales: 0, bills: 0 });
        const month = sum(sales.rows.filter((x) => x._id >= monthStart));
        const d30 = sum(series);
        money = {
          currency: sales.currency,
          today: byDay.get(today)?.sales || 0,
          today_bills: byDay.get(today)?.bills || 0,
          month: month.sales,
          month_bills: month.bills,
          d30: d30.sales,
          d30_bills: d30.bills,
          avg: d30.bills ? d30.sales / d30.bills : 0,
          series,
          last_sale: sales.rows.length
            ? sales.rows
                .map((x) => x._id)
                .sort()
                .pop()
            : null,
        };
      }
      res.json({
        success: true,
        data: {
          business: b,
          licenses: licenses.map((l) => ({ ...l, ...statusOf(l) })),
          coins: { spent: spent[0]?.coins || 0, payments: spent[0]?.n || 0, recent: recentTx },
          sales: money,
          data: counts.map(([model, n]) => ({ model, n })),
          records: counts.reduce((a, [, n]) => a + n, 0),
          others,
        },
      });
    } catch (err) {
      console.error("[business report]", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });
};
