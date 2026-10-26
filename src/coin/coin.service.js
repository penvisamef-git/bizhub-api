// Coin rules in one place. Routes call these functions; nothing else changes balances.
const Wallet = require("./wallet.model");
const CoinTransaction = require("./coin_transaction.model");

const MAX_PER_ACTION = 1000000; // biggest amount for one generate / transfer

class CoinError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MSG = {
  badAmount: `ចំនួនកាក់ត្រូវជាលេខគត់ ចាប់ពី 1 ដល់ ${MAX_PER_ACTION.toLocaleString("en-US")}!`,
  notEnough: "កាក់មិនគ្រប់គ្រាន់!",
  sameWallet: "មិនអាចផ្ទេរទៅកាបូបតែមួយបានទេ!",
  walletNotFound: "រកមិនឃើញកាបូប!",
  ownerOnly: "មានតែម្ចាស់អាជីវកម្មទេដែលអាចទិញបាន។ / Only the business owner can buy this.",
};

function checkAmount(amount) {
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_ACTION) throw new CoinError(MSG.badAmount);
  return n;
}

// The one BizHub treasury wallet (created the first time)
async function getTreasury() {
  const found = await Wallet.findOne({ key: "treasury" });
  if (found) return found;
  return Wallet.findOneAndUpdate({ key: "treasury" }, { $setOnInsert: { key: "treasury", kind: "treasury", balance: 0 } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
}

// A customer's wallet (created the first time)
async function getCustomerWallet(customerId) {
  const found = await Wallet.findOne({ key: `customer:${customerId}` });
  if (found) return found;
  return Wallet.findOneAndUpdate({ key: `customer:${customerId}` }, { $setOnInsert: { key: `customer:${customerId}`, kind: "customer", customer_id: customerId, balance: 0 } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
}

// Wallet that holds the coins of unused top-up cards
async function getCardsWallet() {
  const found = await Wallet.findOne({ key: "cards" });
  if (found) return found;
  return Wallet.findOneAndUpdate({ key: "cards" }, { $setOnInsert: { key: "cards", kind: "cards", balance: 0 } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
}

// "treasury" or a customer id → wallet
async function resolveWallet(target) {
  if (target === "treasury") return getTreasury();
  return getCustomerWallet(target);
}

// Super admin creates new coins in the treasury
async function generate({ amount, note, userId }) {
  const n = checkAmount(amount);
  const treasury = await Wallet.findOneAndUpdate({ _id: (await getTreasury())._id }, { $inc: { balance: n } }, { returnDocument: "after" });
  typeCache = null; // totals changed
  return CoinTransaction.create({
    type: "generate",
    amount: n,
    to_wallet: treasury._id,
    to_balance_after: treasury.balance,
    note,
    by_user: userId,
  });
}

/**
 * Move coins between two wallets.
 * The debit only happens when the balance is high enough (one atomic update), so a
 * wallet can never go below 0, even with two requests at the same time.
 */
async function transfer({ from, to, amount, note, payment, userId, customerId = null, type = "transfer", cardIds, businessId = null, service = null, max = MAX_PER_ACTION }) {
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new CoinError(MSG.badAmount);
  if (String(from._id) === String(to._id)) throw new CoinError(MSG.sameWallet);
  // spending for a business: only its owner pays (team members can't spend coins on someone else's business)
  if (type === "spend" && businessId && customerId) {
    const biz = await require("mongoose").model("Business").findById(businessId).select("owner_id").lean();
    if (biz && String(biz.owner_id) !== String(customerId)) throw new CoinError(MSG.ownerOnly, 403);
  }

  const debited = await Wallet.findOneAndUpdate({ _id: from._id, balance: { $gte: n } }, { $inc: { balance: -n } }, { returnDocument: "after" });
  if (!debited) throw new CoinError(MSG.notEnough);

  let credited;
  try {
    credited = await Wallet.findOneAndUpdate({ _id: to._id }, { $inc: { balance: n } }, { returnDocument: "after" });
    if (!credited) throw new CoinError(MSG.walletNotFound, 404);
  } catch (err) {
    // put the coins back
    await Wallet.updateOne({ _id: from._id }, { $inc: { balance: n } });
    throw err;
  }

  typeCache = null; // totals changed
  return CoinTransaction.create({
    type,
    amount: n,
    from_wallet: debited._id,
    to_wallet: credited._id,
    from_customer: debited.customer_id || null,
    to_customer: credited.customer_id || null,
    from_balance_after: debited.balance,
    to_balance_after: credited.balance,
    note,
    payment: payment || undefined,
    by_user: userId || null,
    by_customer: customerId,
    card_ids: cardIds || [],
    business_id: businessId,
    service,
  });
}

// Free coins for a new customer. These are new coins (not taken from the treasury),
// so sign-up never fails when the treasury is empty.
async function grantSignupBonus(customerId, amount) {
  const n = Number(amount);
  const wallet = await getCustomerWallet(customerId);
  if (!Number.isInteger(n) || n < 1) return wallet;
  const updated = await Wallet.findOneAndUpdate({ _id: wallet._id }, { $inc: { balance: n } }, { returnDocument: "after" });
  typeCache = null; // totals changed
  await CoinTransaction.create({
    type: "signup_bonus",
    amount: n,
    to_wallet: updated._id,
    to_customer: customerId,
    to_balance_after: updated.balance,
    note: "Sign-up bonus",
    by_customer: customerId,
  });
  return updated;
}

// all-time coins per type (generate, transfer, spend…) for the super admin screens. Adding these up reads every coin
// record, so the answer is kept for 1 minute (per server) instead of re-counting on every screen.
let typeCache = null;
async function typeTotals() {
  if (typeCache && Date.now() - typeCache.at < 60000) return typeCache.rows;
  const rows = await CoinTransaction.aggregate([{ $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } }]);
  typeCache = { at: Date.now(), rows };
  return rows;
}

module.exports = {
  CoinError,
  typeTotals,
  MAX_PER_ACTION,
  getTreasury,
  getCustomerWallet,
  getCardsWallet,
  resolveWallet,
  generate,
  transfer,
  grantSignupBonus,
};
