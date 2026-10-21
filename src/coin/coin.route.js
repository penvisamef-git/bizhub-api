// Coins
// Customer:
//   GET  /api/user/wallet?page&limit                → { balance, transactions, pagination }
// Super admin:
//   GET  /api/admin/coins/summary                   treasury, coins in customer wallets, totals
//   GET  /api/admin/coins/transactions?page&limit&type&customer_id
//   POST /api/admin/coins/generate  { amount, note }                         new coins → treasury
//   POST /api/admin/coins/transfer  { from, to, amount, note, payment? }     from/to = "treasury" or a customer id
//        payment = { method: "KHQR"|"ABA"|"Card"|"Cash"|"Other", reference, amount_usd }
const mongoose = require("mongoose");
const Wallet = require("./wallet.model");
const CoinTransaction = require("./coin_transaction.model");
const { TX_TYPES, PAYMENT_METHODS } = require("./coin_transaction.model");
const Customer = require("../user/customer.model");
const coin = require("./coin.service");
const { customer_auth } = require("../user/customer_auth");
const { only_super_admin } = require("../util/permission");
const { logActivity } = require("../util/log");
const { withDetails } = require("./tx_view");

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  noteRequired: "សូមសរសេរមូលហេតុ (note)!",
  noteLong: "មូលហេតុវែងពេក (អតិបរមា 300 តួអក្សរ)!",
  badTarget: "កាបូបមិនត្រឹមត្រូវ (treasury ឬ ID អតិថិជន)!",
  customerNotFound: "រកមិនឃើញអតិថិជន!",
  badPayment: "ព័ត៌មានការទូទាត់មិនត្រឹមត្រូវ!",
  generated: "បានបង្កើតកាក់!",
  transferred: "បានផ្ទេរកាក់!",
};

const POPULATE = [
  { path: "from_customer", select: "name email" },
  { path: "to_customer", select: "name email" },
  { path: "by_user", select: "firstname lastname email" },
];

function readNote(body) {
  const note = String(body?.note || "").trim();
  if (!note) return { error: MSG.noteRequired };
  if (note.length > 300) return { error: MSG.noteLong };
  return { note };
}

function readPayment(p) {
  if (p === undefined || p === null) return {};
  if (typeof p !== "object") return { error: MSG.badPayment };
  if (!PAYMENT_METHODS.includes(p.method)) return { error: MSG.badPayment };
  const reference = String(p.reference || "").trim();
  if (reference.length > 120) return { error: MSG.badPayment };
  let amount_usd = null;
  if (p.amount_usd !== undefined && p.amount_usd !== null && p.amount_usd !== "") {
    amount_usd = Number(p.amount_usd);
    if (!Number.isFinite(amount_usd) || amount_usd < 0 || amount_usd > 1000000) return { error: MSG.badPayment };
    amount_usd = Math.round(amount_usd * 100) / 100;
  }
  return { payment: { method: p.method, reference, amount_usd } };
}

// "treasury" or an existing, active customer id
async function readTarget(value) {
  if (value === "treasury") return { wallet: await coin.getTreasury(), label: "Treasury" };
  if (!mongoose.Types.ObjectId.isValid(value)) return { error: MSG.badTarget };
  const customer = await Customer.findOne({ _id: value, deleted: false }).select("email").lean();
  if (!customer) return { error: MSG.customerNotFound, status: 404 };
  return { wallet: await coin.getCustomerWallet(customer._id), label: customer.email };
}

function pageOf(query, max = 100) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), max);
  return { page, limit, skip: (page - 1) * limit };
}

const route = (prop) => {
  const adminUrl = `/${prop.main_route}/coins`;
  const adminGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  const sendError = (res, err) => {
    if (err instanceof coin.CoinError) return res.status(err.status).json({ success: false, message: err.message });
    return res.status(500).json({ success: false, message: MSG.server });
  };

  // ===================================== CUSTOMER: MY WALLET =====================================
  prop.app.get("/api/user/wallet", prop.api_auth, customer_auth, async (req, res) => {
    try {
      const { page, limit, skip } = pageOf(req.query, 50);
      const me = req.customer._id;
      const wallet = await coin.getCustomerWallet(me);
      const filter = { $or: [{ from_customer: me }, { to_customer: me }] };
      const [rows, total] = await Promise.all([CoinTransaction.find(filter).sort({ created_date: -1 }).skip(skip).limit(limit).lean(), CoinTransaction.countDocuments(filter)]);
      // Customers see + / −, what it was for (business, product, period, payment) — not who on the team did it
      const others = await Customer.find({ _id: { $in: [...new Set(rows.flatMap((t) => [t.from_customer, t.to_customer]).filter((x) => x && String(x) !== String(me)).map(String))] } })
        .select("name")
        .lean();
      const nameOf = Object.fromEntries(others.map((c) => [String(c._id), c.name || ""]));
      const transactions = (await withDetails(rows)).map((t) => {
        const incoming = String(t.to_customer) === String(me);
        const other = incoming ? t.from_customer : t.to_customer;
        return {
          _id: t._id,
          type: t.type,
          direction: incoming ? "in" : "out",
          amount: t.amount,
          balance_after: incoming ? t.to_balance_after : t.from_balance_after,
          note: t.note,
          payment_method: t.payment?.method || null,
          payment: t.payment?.method ? { method: t.payment.method, reference: t.payment.reference || "", amount_usd: t.payment.amount_usd ?? null } : null,
          // the other side: BizHub (treasury / cards) or another customer's name
          other: other ? { kind: "customer", name: nameOf[String(other)] || "" } : { kind: "bizhub" },
          business: t.business,
          service: t.service || null,
          product: t.product || null,
          item: t.item || "",
          days: t.days || null,
          cards: t.cards || 0,
          order: t.order ? { no: t.order.no, coins: t.order.coins, bonus: t.order.bonus, usd: t.order.usd, bank: t.order.bank, ordered_at: t.order.ordered_at } : null,
          created_date: t.created_date,
        };
      });
      res.json({
        success: true,
        data: { balance: wallet.balance, transactions },
        pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page, pageSize: limit },
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ===================================== SUPER ADMIN: SUMMARY =====================================
  prop.app.get(`${adminUrl}/summary`, ...adminGuard, async (req, res) => {
    try {
      // ?lite=1: only the treasury (the header badge, the transfer form) — no totals to add up
      if (req.query.lite === "1") {
        const treasury = await coin.getTreasury();
        return res.json({ success: true, data: { treasury_balance: treasury.balance, payment_methods: PAYMENT_METHODS, max_per_action: coin.MAX_PER_ACTION } });
      }
      const [treasury, cardsWallet] = await Promise.all([coin.getTreasury(), coin.getCardsWallet()]);
      const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const [inWallets, byType, sold30] = await Promise.all([
        Wallet.aggregate([{ $match: { kind: "customer" } }, { $group: { _id: null, total: { $sum: "$balance" }, wallets: { $sum: 1 } } }]),
        coin.typeTotals(),
        CoinTransaction.aggregate([
          { $match: { type: "transfer", from_wallet: treasury._id, created_date: { $gte: since30 } } },
          { $group: { _id: null, coins: { $sum: "$amount" }, usd: { $sum: { $ifNull: ["$payment.amount_usd", 0] } }, count: { $sum: 1 } } },
        ]),
      ]);
      const total = (type) => byType.find((x) => x._id === type)?.total || 0;
      res.json({
        success: true,
        data: {
          treasury_balance: treasury.balance,
          customer_balance: inWallets[0]?.total || 0,
          cards_balance: cardsWallet.balance, // coins on top-up cards not used yet
          customer_wallets: inWallets[0]?.wallets || 0,
          generated_total: total("generate"),
          signup_bonus_total: total("signup_bonus"),
          spent_total: total("spend"),
          transferred_total: total("transfer"),
          treasury_out_30d: { coins: sold30[0]?.coins || 0, usd: Math.round((sold30[0]?.usd || 0) * 100) / 100, count: sold30[0]?.count || 0 },
          payment_methods: PAYMENT_METHODS,
          max_per_action: coin.MAX_PER_ACTION,
        },
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ===================================== SUPER ADMIN: HISTORY =====================================
  prop.app.get(`${adminUrl}/transactions`, ...adminGuard, async (req, res) => {
    try {
      const { page, limit, skip } = pageOf(req.query);
      const filter = {};
      if (TX_TYPES.includes(req.query.type)) filter.type = req.query.type;
      if (req.query.customer_id === "treasury") {
        const treasury = await coin.getTreasury();
        filter.$or = [{ from_wallet: treasury._id }, { to_wallet: treasury._id }];
      } else if (mongoose.Types.ObjectId.isValid(req.query.customer_id)) {
        filter.$or = [{ from_customer: req.query.customer_id }, { to_customer: req.query.customer_id }];
      }
      const [rows, total] = await Promise.all([CoinTransaction.find(filter).sort({ created_date: -1 }).skip(skip).limit(limit).populate(POPULATE).lean(), CoinTransaction.countDocuments(filter)]);
      const data = await withDetails(rows);
      res.json({ success: true, data, pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page, pageSize: limit } });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ===================================== SUPER ADMIN: GENERATE =====================================
  prop.app.post(`${adminUrl}/generate`, ...adminGuard, async (req, res) => {
    try {
      const { note, error } = readNote(req.body);
      if (error) return res.status(400).json({ success: false, message: error });
      const tx = await coin.generate({ amount: req.body?.amount, note, userId: req.session.user_id });

      await logActivity({
        title: `បានបង្កើតកាក់ ${tx.amount.toLocaleString("en-US")} ចូល Treasury`,
        description: `គណនី: ${req.user.email} · ${note}`,
        categoryTitle: "coin",
        createdBy: req.session.user_id,
        req,
      });
      res.status(201).json({ success: true, data: tx, message: MSG.generated });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ===================================== SUPER ADMIN: TRANSFER =====================================
  prop.app.post(`${adminUrl}/transfer`, ...adminGuard, async (req, res) => {
    try {
      const { note, error } = readNote(req.body);
      if (error) return res.status(400).json({ success: false, message: error });
      const pay = readPayment(req.body?.payment);
      if (pay.error) return res.status(400).json({ success: false, message: pay.error });

      const from = await readTarget(req.body?.from);
      if (from.error) return res.status(from.status || 400).json({ success: false, message: from.error });
      const to = await readTarget(req.body?.to);
      if (to.error) return res.status(to.status || 400).json({ success: false, message: to.error });

      const tx = await coin.transfer({
        from: from.wallet,
        to: to.wallet,
        amount: req.body?.amount,
        note,
        payment: pay.payment,
        userId: req.session.user_id,
      });

      await logActivity({
        title: `បានផ្ទេរកាក់ ${tx.amount.toLocaleString("en-US")}: ${from.label} → ${to.label}`,
        description: `គណនី: ${req.user.email} · ${note}${pay.payment ? ` · ${pay.payment.method} ${pay.payment.reference}` : ""}`,
        categoryTitle: "coin",
        createdBy: req.session.user_id,
        req,
      });
      const data = await CoinTransaction.findById(tx._id).populate(POPULATE).lean();
      res.status(201).json({ success: true, data, message: MSG.transferred });
    } catch (err) {
      sendError(res, err);
    }
  });
};

module.exports = route;
