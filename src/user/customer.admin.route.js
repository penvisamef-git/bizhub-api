// Customers, seen by the super admin
//   GET /api/admin/customers?page&limit&q&status=active|suspended
//   GET /api/admin/customers/:id             customer + wallet + businesses + last coin history
//   PUT /api/admin/customers/:id/status      { status: true|false, admin_note? }   (suspend logs them out)
//   PUT /api/admin/customers/:id/reset-password { password }
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const Customer = require("./customer.model");
const CustomerSession = require("./customer_session.model");
const Business = require("../biz/business.model");
const Wallet = require("../coin/wallet.model");
const CoinTransaction = require("../coin/coin_transaction.model");
const { withDetails } = require("../coin/tx_view");
const { getCustomerWallet } = require("../coin/coin.service");
const { only_super_admin } = require("../util/permission");
const { logActivity } = require("../util/log");
const { escapeRegex } = require("../util/helper");

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  notFound: "រកមិនឃើញអតិថិជន!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  shortPassword: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 8 តួអក្សរ!",
  saved: "បានរក្សាទុក!",
};

const route = (prop) => {
  const url = `/${prop.main_route}/customers`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  const validId = (id) => mongoose.Types.ObjectId.isValid(id);

  // ===================================== LIST =====================================
  prop.app.get(url, ...guard, async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const filter = { deleted: false };
      if (req.query.status === "active") filter.status = true;
      if (req.query.status === "suspended") filter.status = false;
      const q = String(req.query.q || "").trim();
      if (q) {
        const re = { $regex: escapeRegex(q), $options: "i" };
        filter.$or = [{ name: re }, { email: re }, { phone: re }];
      }

      const [rows, total] = await Promise.all([
        Customer.find(filter)
          .select("-password -signup_device")
          .sort({ created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Customer.countDocuments(filter),
      ]);

      // add coin balance + number of businesses
      const ids = rows.map((c) => c._id);
      const [wallets, counts] = await Promise.all([
        Wallet.find({ customer_id: { $in: ids } }).select("customer_id balance").lean(),
        Business.aggregate([{ $match: { owner_id: { $in: ids }, deleted: false } }, { $group: { _id: "$owner_id", n: { $sum: 1 } } }]),
      ]);
      const data = rows.map((c) => ({
        ...c,
        coin_balance: wallets.find((w) => String(w.customer_id) === String(c._id))?.balance || 0,
        business_count: counts.find((x) => String(x._id) === String(c._id))?.n || 0,
      }));

      res.json({ success: true, data, pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page, pageSize: limit } });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== DETAIL =====================================
  prop.app.get(`${url}/:id`, ...guard, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      const customer = await Customer.findOne({ _id: req.params.id, deleted: false }).select("-password").lean();
      if (!customer) return res.status(404).json({ success: false, message: MSG.notFound });

      const [wallet, businesses, transactions, sessions] = await Promise.all([
        getCustomerWallet(customer._id),
        Business.find({ owner_id: customer._id, deleted: false }).sort({ created_date: 1 }).lean(),
        CoinTransaction.find({ $or: [{ from_customer: customer._id }, { to_customer: customer._id }] })
          .sort({ created_date: -1 })
          .limit(20)
          .populate([
            { path: "by_user", select: "firstname lastname email" },
            { path: "from_customer", select: "name email" },
            { path: "to_customer", select: "name email" },
          ])
          .lean()
          .then(withDetails),
        CustomerSession.countDocuments({ customer_id: customer._id }),
      ]);

      res.json({ success: true, data: { ...customer, coin_balance: wallet.balance, businesses, transactions, active_sessions: sessions } });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== SUSPEND / ACTIVATE =====================================
  prop.app.put(`${url}/:id/status`, ...guard, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      if (typeof req.body?.status !== "boolean") return res.status(400).json({ success: false, message: "status: true | false" });
      const set = { status: req.body.status };
      if (req.body.admin_note !== undefined) set.admin_note = String(req.body.admin_note).slice(0, 500);

      const data = await Customer.findOneAndUpdate({ _id: req.params.id, deleted: false }, { $set: set }, { returnDocument: "after" }).select(
        "-password",
      );
      if (!data) return res.status(404).json({ success: false, message: MSG.notFound });
      if (!data.status) await CustomerSession.deleteMany({ customer_id: data._id });

      await logActivity({
        title: `អតិថិជន ${data.email || data.phone} ${data.status ? "ត្រូវបានបើកវិញ" : "ត្រូវបានផ្អាក"}`,
        description: `គណនី: ${req.user.email}${set.admin_note ? ` · ${set.admin_note}` : ""}`,
        categoryTitle: "customer",
        createdBy: req.session.user_id,
        req,
      });
      res.json({ success: true, data, message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });

  // ===================================== RESET PASSWORD =====================================
  prop.app.put(`${url}/:id/reset-password`, ...guard, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      const password = String(req.body?.password || "");
      if (password.length < 8 || password.length > 100) return res.status(400).json({ success: false, message: MSG.shortPassword });

      const data = await Customer.findOneAndUpdate(
        { _id: req.params.id, deleted: false },
        { $set: { password: await bcrypt.hash(password, 10) } },
        { returnDocument: "after" },
      );
      if (!data) return res.status(404).json({ success: false, message: MSG.notFound });
      await CustomerSession.deleteMany({ customer_id: data._id });

      await logActivity({
        title: `ពាក្យសម្ងាត់អតិថិជន ${data.email || data.phone} ត្រូវបានកំណត់ថ្មី`,
        description: `គណនី: ${req.user.email}`,
        categoryTitle: "customer",
        createdBy: req.session.user_id,
        req,
      });
      res.json({ success: true, message: MSG.saved });
    } catch (err) {
      res.status(500).json({ success: false, message: MSG.server });
    }
  });
};

module.exports = route;
