// Top-up cards
// Super admin:
//   POST   /api/admin/coins/cards        { amount, quantity, note, expires_at? }  coins: treasury → cards wallet
//   GET    /api/admin/coins/cards?status&q&batch_id&page&limit
//   DELETE /api/admin/coins/cards/:id    unused card only; coins: cards wallet → treasury
// Customer:
//   POST   /api/user/wallet/redeem       { code }   coins: cards wallet → my wallet
const crypto = require("crypto");
const mongoose = require("mongoose");
const TopupCard = require("./topup_card.model");
const { CARD_STATUS } = require("./topup_card.model");
const coin = require("./coin.service");
const { customer_auth } = require("../user/customer_auth");
const { only_super_admin } = require("../util/permission");
const { logActivity } = require("../util/log");
const { rate_limit } = require("../util/rate_limit");

const MAX_CARD_AMOUNT = 100000; // coins on one card
const MAX_QUANTITY = 100; // cards made at once

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badAmount: `ចំនួនកាក់ក្នុងកាតមួយ ត្រូវពី 1 ដល់ ${MAX_CARD_AMOUNT.toLocaleString("en-US")}!`,
  badQuantity: `ចំនួនកាត ត្រូវពី 1 ដល់ ${MAX_QUANTITY}!`,
  badExpiry: "ថ្ងៃផុតកំណត់ត្រូវនៅពេលអនាគត!",
  noteLong: "កំណត់ចំណាំវែងពេក!",
  notEnough: "កាក់ក្នុងឃ្លាំងមិនគ្រប់គ្រាន់! សូមបង្កើតកាក់បន្ថែមជាមុនសិន។",
  created: "បានបង្កើតកាតបញ្ចូលកាក់!",
  notFound: "រកមិនឃើញកាត!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notActive: "កាតនេះត្រូវបានប្រើ ឬលុបរួចហើយ មិនអាចលុបបានទេ!",
  cancelled: "បានលុបកាត ហើយកាក់ត្រឡប់ទៅឃ្លាំងវិញ!",
  badCode: "លេខកូដត្រូវមាន 12 ខ្ទង់!",
  wrongCode: "លេខកូដមិនត្រឹមត្រូវ ឬត្រូវបានប្រើរួចហើយ!",
  expired: "កាតនេះផុតកំណត់ហើយ!",
  tooMany: "ព្យាយាមខុសច្រើនដងពេក។ សូមរង់ចាំ 15 នាទី។",
  redeemed: "បានបញ្ចូលកាក់ដោយជោគជ័យ!",
};

// 12 random digits (first digit not 0), using a secure random generator
function newCode() {
  let code = String(crypto.randomInt(1, 10));
  for (let i = 0; i < 11; i += 1) code += String(crypto.randomInt(0, 10));
  return code;
}

// "1234 5678 9012", "123456789012", a QR link ".../wallet?redeem=123456789012" → "123456789012"
function cleanCode(value) {
  const text = String(value || "");
  const fromLink = text.match(/redeem=(\d{12})/);
  const digits = (fromLink ? fromLink[1] : text).replace(/\D/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

// Wrong codes per customer (stops guessing): max 10 per 15 minutes
const wrongTries = new Map(); // customerId → { count, reset }
function tooManyWrong(customerId) {
  const hit = wrongTries.get(customerId);
  return !!hit && hit.reset > Date.now() && hit.count >= 10;
}
function addWrong(customerId) {
  const now = Date.now();
  const hit = wrongTries.get(customerId);
  if (!hit || hit.reset <= now) wrongTries.set(customerId, { count: 1, reset: now + 15 * 60 * 1000 });
  else hit.count += 1;
}

const route = (prop) => {
  const adminUrl = `/${prop.main_route}/coins/cards`;
  const adminGuard = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];
  const sendError = (res, err) => {
    if (err instanceof coin.CoinError) return res.status(err.status).json({ success: false, message: err.message });
    return res.status(500).json({ success: false, message: MSG.server });
  };

  // ===================================== CREATE =====================================
  prop.app.post(adminUrl, ...adminGuard, async (req, res) => {
    try {
      const amount = Number(req.body?.amount);
      const quantity = req.body?.quantity === undefined ? 1 : Number(req.body.quantity);
      const note = String(req.body?.note || "").trim();
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CARD_AMOUNT) return res.status(400).json({ success: false, message: MSG.badAmount });
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return res.status(400).json({ success: false, message: MSG.badQuantity });
      if (note.length > 300) return res.status(400).json({ success: false, message: MSG.noteLong });
      let expires_at = null;
      if (req.body?.expires_at) {
        expires_at = new Date(req.body.expires_at);
        if (Number.isNaN(expires_at.getTime()) || expires_at.getTime() <= Date.now()) return res.status(400).json({ success: false, message: MSG.badExpiry });
      }

      const total = amount * quantity;
      const batch_id = `B${Date.now().toString(36).toUpperCase()}${crypto.randomInt(100, 999)}`;
      const ids = Array.from({ length: quantity }, () => new mongoose.Types.ObjectId());

      // 1) reserve the coins: treasury → cards wallet (fails if the treasury is too low)
      let tx;
      try {
        tx = await coin.transfer({
          from: await coin.getTreasury(),
          to: await coin.getCardsWallet(),
          amount: total,
          note: `${quantity} × ${amount}${note ? ` · ${note}` : ""}`,
          userId: req.session.user_id,
          type: "card_create",
          cardIds: ids,
          max: MAX_CARD_AMOUNT * MAX_QUANTITY,
        });
      } catch (err) {
        if (err instanceof coin.CoinError && err.message.includes("មិនគ្រប់គ្រាន់")) return res.status(400).json({ success: false, message: MSG.notEnough });
        throw err;
      }

      // 2) make the cards (a new code is picked if one is already taken)
      const cards = [];
      try {
        for (const _id of ids) {
          for (let attempt = 0; ; attempt += 1) {
            try {
              cards.push(
                await TopupCard.create({ _id, code: newCode(), amount, note, expires_at, batch_id, created_by: req.session.user_id }),
              );
              break;
            } catch (err) {
              if (err.code !== 11000 || attempt >= 5) throw err;
            }
          }
        }
      } catch (err) {
        // undo: remove the cards made so far and put the coins back
        await TopupCard.deleteMany({ _id: { $in: ids } });
        await coin.transfer({
          from: await coin.getCardsWallet(),
          to: await coin.getTreasury(),
          amount: total,
          note: `Undo ${batch_id}`,
          userId: req.session.user_id,
          type: "card_cancel",
          max: MAX_CARD_AMOUNT * MAX_QUANTITY,
        });
        throw err;
      }

      await logActivity({
        title: `បានបង្កើតកាតបញ្ចូលកាក់ ${quantity} × ${amount.toLocaleString("en-US")} កាក់`,
        description: `គណនី: ${req.user.email} · ${batch_id}${note ? ` · ${note}` : ""}`,
        categoryTitle: "coin",
        createdBy: req.session.user_id,
        req,
      });
      res.status(201).json({ success: true, data: cards, batch_id, transaction_id: tx._id, message: MSG.created });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ===================================== LIST =====================================
  prop.app.get(adminUrl, ...adminGuard, async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const filter = {};
      if (CARD_STATUS.includes(req.query.status)) filter.status = req.query.status;
      if (req.query.status === "expired") Object.assign(filter, { status: "active", expires_at: { $ne: null, $lte: new Date() } });
      if (req.query.batch_id) filter.batch_id = String(req.query.batch_id);
      const q = String(req.query.q || "").replace(/\D/g, "");
      if (q) filter.code = { $regex: q };

      const [data, total, counts] = await Promise.all([
        TopupCard.find(filter)
          .sort({ created_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate("redeemed_by", "name email")
          .populate("created_by", "firstname lastname")
          .lean(),
        TopupCard.countDocuments(filter),
        TopupCard.aggregate([{ $group: { _id: "$status", n: { $sum: 1 }, coins: { $sum: "$amount" } } }]),
      ]);
      const sum = (s) => counts.find((c) => c._id === s) || { n: 0, coins: 0 };
      res.json({
        success: true,
        data,
        summary: {
          active: { count: sum("active").n, coins: sum("active").coins },
          redeemed: { count: sum("redeemed").n, coins: sum("redeemed").coins },
          cancelled: { count: sum("cancelled").n, coins: sum("cancelled").coins },
        },
        pagination: { total, totalPages: Math.ceil(total / limit), currentPage: page, pageSize: limit },
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ===================================== DELETE (unused only) =====================================
  prop.app.delete(`${adminUrl}/:id`, ...adminGuard, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: MSG.badId });
      // claim the card first, so it can't be redeemed and deleted at the same time
      const card = await TopupCard.findOneAndUpdate(
        { _id: req.params.id, status: "active" },
        { $set: { status: "cancelled", cancelled_by: req.session.user_id, cancelled_date: new Date() } },
        { returnDocument: "after" },
      );
      if (!card) {
        const exists = await TopupCard.exists({ _id: req.params.id });
        return res.status(exists ? 400 : 404).json({ success: false, message: exists ? MSG.notActive : MSG.notFound });
      }
      try {
        await coin.transfer({
          from: await coin.getCardsWallet(),
          to: await coin.getTreasury(),
          amount: card.amount,
          note: `Card ${card.code.slice(-4)} deleted`,
          userId: req.session.user_id,
          type: "card_cancel",
          cardIds: [card._id],
          max: MAX_CARD_AMOUNT,
        });
      } catch (err) {
        await TopupCard.updateOne({ _id: card._id }, { $set: { status: "active", cancelled_by: null, cancelled_date: null } });
        throw err;
      }
      await logActivity({
        title: `បានលុបកាតបញ្ចូលកាក់ ****${card.code.slice(-4)} (${card.amount.toLocaleString("en-US")} កាក់ត្រឡប់ទៅឃ្លាំង)`,
        description: `គណនី: ${req.user.email}`,
        categoryTitle: "coin",
        createdBy: req.session.user_id,
        req,
      });
      res.json({ success: true, data: card, message: MSG.cancelled });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ===================================== CUSTOMER: REDEEM =====================================
  prop.app.post("/api/user/wallet/redeem", prop.api_auth, rate_limit({ max: 30 }), customer_auth, async (req, res) => {
    try {
      const me = String(req.customer._id);
      if (tooManyWrong(me)) return res.status(429).json({ success: false, message: MSG.tooMany });
      const code = cleanCode(req.body?.code);
      if (!code) return res.status(400).json({ success: false, message: MSG.badCode });

      // claim the card in one step: only one person can ever use it
      const now = new Date();
      const card = await TopupCard.findOneAndUpdate(
        { code, status: "active", $or: [{ expires_at: null }, { expires_at: { $gt: now } }] },
        { $set: { status: "redeemed", redeemed_by: req.customer._id, redeemed_date: now } },
        { returnDocument: "after" },
      );
      if (!card) {
        const expired = await TopupCard.exists({ code, status: "active", expires_at: { $lte: now } });
        if (!expired) addWrong(me);
        return res.status(400).json({ success: false, message: expired ? MSG.expired : MSG.wrongCode });
      }

      let tx;
      try {
        tx = await coin.transfer({
          from: await coin.getCardsWallet(),
          to: await coin.getCustomerWallet(req.customer._id),
          amount: card.amount,
          note: `Top-up card ****${card.code.slice(-4)}`,
          customerId: req.customer._id,
          type: "card_redeem",
          cardIds: [card._id],
          max: MAX_CARD_AMOUNT,
        });
      } catch (err) {
        await TopupCard.updateOne({ _id: card._id }, { $set: { status: "active", redeemed_by: null, redeemed_date: null } });
        throw err;
      }

      res.json({ success: true, data: { amount: card.amount, balance: tx.to_balance_after }, message: MSG.redeemed });
    } catch (err) {
      sendError(res, err);
    }
  });
};

module.exports = route;
module.exports.cleanCode = cleanCode;
