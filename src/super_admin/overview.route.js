// Super admin dashboard numbers in one call
//   GET /api/admin/overview
const Customer = require("../user/customer.model");
const Business = require("../biz/business.model");
const Wallet = require("../coin/wallet.model");
const CoinTransaction = require("../coin/coin_transaction.model");
const { withDetails } = require("../coin/tx_view");
const User = require("../v1/admin/user/user.model");
const ActivityLog = require("../v1/admin/activity_log/activity_log.model");
const { getTreasury, getCardsWallet, typeTotals } = require("../coin/coin.service");
const { BUSINESS_TYPES } = require("../biz/business.model");
const { only_super_admin } = require("../util/permission");

const DAY = 24 * 3600 * 1000;

// "2026-10-09" in Cambodia time
function khDay(date) {
  return new Date(date.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

const route = (prop) => {
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];

  prop.app.get(`/${prop.main_route}/overview`, ...guard, async (req, res) => {
    try {
      const now = Date.now();
      const since7 = new Date(now - 7 * DAY);
      const since14 = new Date(now - 13 * DAY - ((now + 7 * 3600 * 1000) % DAY)); // start of the day, 14 days incl. today
      const live = { deleted: false };

      const [
        treasury,
        cardsWallet,
        customersTotal,
        customersActive,
        customersNew7,
        businessesTotal,
        businessesActive,
        businessesNew7,
        teamTotal,
        inWallets,
        byType,
        services,
        signupRows,
        recentCustomers,
        recentBusinesses,
        recentTransactions,
        recentActivity,
      ] = await Promise.all([
        getTreasury(),
        getCardsWallet(),
        Customer.countDocuments(live),
        Customer.countDocuments({ ...live, status: true }),
        Customer.countDocuments({ ...live, created_date: { $gte: since7 } }),
        Business.countDocuments(live),
        Business.countDocuments({ ...live, status: true }),
        Business.countDocuments({ ...live, created_date: { $gte: since7 } }),
        User.countDocuments({ deleted: false }),
        Wallet.aggregate([{ $match: { kind: "customer" } }, { $group: { _id: null, total: { $sum: "$balance" } } }]),
        typeTotals(),
        Business.aggregate([{ $match: live }, { $group: { _id: "$category", count: { $sum: 1 } } }]),
        Customer.find({ ...live, created_date: { $gte: since14 } })
          .select("created_date")
          .lean(),
        Customer.find(live).select("name email phone status created_date").sort({ created_date: -1 }).limit(6).lean(),
        Business.find(live).select("name category status created_date owner_id").populate("owner_id", "name email").sort({ created_date: -1 }).limit(6).lean(),
        CoinTransaction.find({})
          .sort({ created_date: -1 })
          .limit(8)
          .populate([
            { path: "from_customer", select: "name email" },
            { path: "to_customer", select: "name email" },
            { path: "by_user", select: "firstname lastname email" },
          ])
          .lean()
          .then(withDetails),
        ActivityLog.find({}).select("title description time created_date").sort({ _id: -1 }).limit(8).lean(),
      ]);

      // sign-ups per day for the last 14 days (zeros included)
      const perDay = {};
      signupRows.forEach((c) => {
        const d = khDay(c.created_date);
        perDay[d] = (perDay[d] || 0) + 1;
      });
      const signups = [];
      for (let i = 13; i >= 0; i -= 1) {
        const d = khDay(new Date(now - i * DAY));
        signups.push({ date: d, count: perDay[d] || 0 });
      }

      const total = (type) => byType.find((x) => x._id === type)?.total || 0;

      res.json({
        success: true,
        data: {
          customers: { total: customersTotal, active: customersActive, suspended: customersTotal - customersActive, new_7d: customersNew7 },
          businesses: { total: businessesTotal, active: businessesActive, suspended: businessesTotal - businessesActive, new_7d: businessesNew7 },
          team: { total: teamTotal },
          coins: {
            treasury: treasury.balance,
            in_wallets: inWallets[0]?.total || 0,
            on_cards: cardsWallet.balance,
            generated_total: total("generate"),
            signup_bonus_total: total("signup_bonus"),
            transferred_total: total("transfer"),
            spent_total: total("spend"),
          },
          // businesses per type (namecard, restaurant…)
          types: BUSINESS_TYPES.map((key) => ({ key, count: services.find((s) => s._id === key)?.count || 0 })),
          signups_14d: signups,
          recent_customers: recentCustomers,
          recent_businesses: recentBusinesses,
          recent_transactions: recentTransactions,
          recent_activity: recentActivity,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!" });
    }
  });
};

module.exports = route;
