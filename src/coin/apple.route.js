// Coin packs bought in the iPhone app with Apple in-app purchase (StoreKit 2) — the only way to buy coins inside
// the iOS app (App Store rule 3.1.1). Web / KHQR / bank top-ups stay on bizhubcambodia.com; same wallet.
//   GET  /api/user/coins/apple-packs                    the packs (product ids coins_<coins>, same as Google Play)
//                                                       + account_ref (a UUID: StoreKit's appAccountToken)
//   POST /api/user/coins/apple/verify { productId, jws } jws = the signed transaction StoreKit gave the app.
//        checked here (Apple's certificate chain + signature, apple_store.js), adds the coins once (same
//        transaction twice = once). The app finishes the transaction after this answers.
//   POST /api/public/apple/notifications { signedPayload }   App Store Server Notifications V2 (set this URL in
//        App Store Connect → App → App Information). REFUND / REVOKE takes the coins back once.
const coin = require("./coin.service");
const Wallet = require("./wallet.model");
const apple = require("./apple_store");
const { ApplePurchase } = require("./apple_purchase.model");
const { packs } = require("./google.route"); // the same coin packs as Google Play
const { customer_auth } = require("../user/customer_auth");

const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  notSetup: "ការទិញតាម App Store មិនទាន់បានបើកនៅឡើយ។ / App Store payments are not open yet.",
  badProduct: "កញ្ចប់កាក់មិនត្រឹមត្រូវ! / Unknown coin pack.",
  badToken: "ការទិញមិនត្រឹមត្រូវ! / This purchase isn't valid.",
  cancelled: "ការទិញត្រូវបានបោះបង់ ឬបានសងប្រាក់វិញ។ / This purchase was cancelled or refunded.",
  otherUser: "ការទិញនេះជារបស់គណនីផ្សេង! / This purchase belongs to another account.",
  busy: "កំពុងដំណើរការ… សូមព្យាយាមម្តងទៀតបន្តិចទៀត។ / Still working on it — try again in a moment.",
  added: "បានបញ្ចូលកាក់! / Coins added!",
};

const sendError = (res, err) => {
  if (err?.http) return res.status(err.http).json({ success: false, message: err.message, code: err.code });
  console.error("[app-store]", err);
  res.status(500).json({ success: false, message: MSG.server });
};
const bad = (message, http = 400, code = "") => Object.assign(new Error(message), { http, code });

async function credit(p) {
  const sandbox = p.environment === "Sandbox";
  // the coins come from the treasury, like an approved bank order; when it's short the missing coins are made first (recorded)
  const treasury = await coin.getTreasury();
  if (treasury.balance < p.total_coins) await coin.generate({ amount: p.total_coins - treasury.balance, note: `App Store ${p.transaction_id}${sandbox ? " sandbox" : ""} (in-app coins)`, userId: null });
  return coin.transfer({
    from: await coin.getTreasury(),
    to: await coin.getCustomerWallet(p.customer_id),
    amount: p.total_coins,
    note: `App Store coin pack ${p.coins}${p.bonus ? ` (+${p.bonus} free)` : ""}${sandbox ? " — sandbox test" : ""}`.slice(0, 300),
    payment: { method: "App Store", reference: `${sandbox ? "sandbox:" : ""}${p.transaction_id}`.slice(0, 120), amount_usd: sandbox ? null : (p.usd ?? null) },
    customerId: p.customer_id,
  });
}

async function verify({ customerId, productId, jws }) {
  if (!apple.ready()) throw bad(MSG.notSetup, 503, "not_setup");
  let t;
  try {
    t = apple.transaction(jws);
  } catch (err) {
    if (err instanceof apple.AppleError) throw bad(MSG.badToken, 400, "bad_token");
    throw err;
  }
  if (productId && t.productId !== productId) throw bad(MSG.badToken, 400, "bad_token");
  if (t.type && t.type !== "Consumable") throw bad(MSG.badProduct, 400, "bad_product");
  const pack = (await packs()).find((x) => x.product_id === t.productId);
  if (!pack) throw bad(MSG.badProduct, 400, "bad_product");
  const qty = Math.max(1, Math.min(10, Number(t.quantity) || 1));
  if (t.appAccountToken && String(t.appAccountToken).toLowerCase() !== apple.accountUuid(customerId)) throw bad(MSG.otherUser, 409, "other_user");
  const id = String(t.transactionId);

  let row = await ApplePurchase.findOne({ transaction_id: id });
  if (row && String(row.customer_id) !== String(customerId)) throw bad(MSG.otherUser, 409, "other_user");
  if (t.revocationDate) {
    if (row) await reverse(row, { at: new Date(Number(t.revocationDate)), reason: t.revocationReason ?? null });
    throw bad(MSG.cancelled, 400, "refunded");
  }

  if (!row || ["new", "error"].includes(row.status)) {
    if (!row) {
      try {
        row = await ApplePurchase.create({
          transaction_id: id,
          original_transaction_id: String(t.originalTransactionId || id),
          product_id: t.productId,
          customer_id: customerId,
          environment: t.environment,
          coins: pack.coins * qty,
          bonus: pack.bonus * qty,
          total_coins: pack.total_coins * qty,
          usd: t.environment === "Sandbox" || pack.usd == null ? null : pack.usd * qty, // sandbox = nobody paid
          price: Number.isFinite(Number(t.price)) ? Number(t.price) : null,
          currency: String(t.currency || "").slice(0, 8),
          storefront: String(t.storefront || "").slice(0, 8),
          purchased_at: t.purchaseDate ? new Date(Number(t.purchaseDate)) : new Date(),
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        row = await ApplePurchase.findOne({ transaction_id: id }); // the same purchase sent twice at once
        if (String(row.customer_id) !== String(customerId)) throw bad(MSG.otherUser, 409, "other_user");
      }
    }
    // only one request adds the coins
    const claimed = await ApplePurchase.findOneAndUpdate({ _id: row._id, status: { $in: ["new", "error"] } }, { $set: { status: "crediting", error: "" } }, { returnDocument: "after" });
    if (claimed) {
      try {
        const tx = await credit(claimed);
        row = await ApplePurchase.findOneAndUpdate({ _id: claimed._id }, { $set: { status: "credited", tx_id: tx._id } }, { returnDocument: "after" });
      } catch (err) {
        await ApplePurchase.updateOne({ _id: claimed._id }, { $set: { status: "error", error: String(err.message || err).slice(0, 300) } });
        throw err;
      }
    } else row = await ApplePurchase.findById(row._id);
  }
  if (row.status === "crediting") throw bad(MSG.busy, 409, "busy");
  if (["reversing", "reversed"].includes(row.status)) throw bad(MSG.cancelled, 400, "refunded");
  const wallet = await Wallet.findOne({ key: `customer:${customerId}` }).lean();
  return { status: "credited", coins_added: row.total_coins, balance: wallet?.balance ?? 0, transaction_id: row.transaction_id };
}

// ---------------------------------------------------------------- refunds (App Store Server Notifications)
async function reverse(p, revoked) {
  const claimed = await ApplePurchase.findOneAndUpdate({ _id: p._id, status: "credited" }, { $set: { status: "reversing", revoked_at: revoked.at, revocation_reason: revoked.reason } }, { returnDocument: "after" });
  if (!claimed) {
    // not credited yet: never credit it
    await ApplePurchase.updateOne({ _id: p._id, status: { $in: ["new", "error"] } }, { $set: { status: "reversed", revoked_at: revoked.at, revocation_reason: revoked.reason } });
    return false;
  }
  try {
    const wallet = await coin.getCustomerWallet(claimed.customer_id);
    const take = Math.min(wallet.balance, claimed.total_coins);
    let tx = null;
    if (take > 0) {
      tx = await coin.transfer({
        from: wallet,
        to: await coin.getTreasury(),
        amount: take,
        note: `App Store refund ${claimed.transaction_id}${take < claimed.total_coins ? ` (${claimed.total_coins - take} coins already spent)` : ""}`.slice(0, 300),
        payment: { method: "App Store", reference: String(claimed.transaction_id).slice(0, 120), amount_usd: null },
        customerId: claimed.customer_id,
      });
    }
    const debt = claimed.total_coins - take;
    await ApplePurchase.updateOne({ _id: claimed._id }, { $set: { status: "reversed", reversed_coins: take, debt_coins: debt, reverse_tx_id: tx?._id || null } });
    if (debt > 0) console.warn(`[app-store] refund ${claimed.transaction_id}: ${debt} coins were already spent (customer ${claimed.customer_id})`);
    return true;
  } catch (err) {
    // the balance changed under us (transfer refused): Apple sends the notification again if we answer an error
    await ApplePurchase.updateOne({ _id: claimed._id }, { $set: { status: "credited", error: `refund: ${String(err.message || err).slice(0, 280)}` } });
    throw err;
  }
}

async function onNotification(signedPayload) {
  const n = apple.notification(signedPayload); // throws AppleError when it isn't Apple's
  const t = n.transaction;
  if (!["REFUND", "REVOKE"].includes(n.notificationType) || !t?.transactionId) return { handled: false, type: n.notificationType };
  const row = await ApplePurchase.findOne({ transaction_id: String(t.transactionId) });
  if (!row) return { handled: false, type: n.notificationType, unknown: true };
  const done = await reverse(row, { at: new Date(Number(t.revocationDate) || Date.now()), reason: t.revocationReason ?? null });
  return { handled: true, type: n.notificationType, reversed: done };
}

module.exports = (prop) => {
  const user = [prop.api_auth, customer_auth];
  prop.app.get("/api/user/coins/apple-packs", ...user, async (req, res) => {
    try {
      res.json({ success: true, data: { ready: apple.ready(), packs: await packs(), account_ref: apple.accountUuid(req.customer._id) } });
    } catch (err) {
      sendError(res, err);
    }
  });
  prop.app.post("/api/user/coins/apple/verify", ...user, async (req, res) => {
    try {
      const data = await verify({ customerId: req.customer._id, productId: String(req.body?.productId || ""), jws: req.body?.jws });
      res.json({ success: true, data, message: MSG.added });
    } catch (err) {
      sendError(res, err);
    }
  });
  // Apple calls this (no BizHub key): only signed App Store data is accepted
  prop.app.post("/api/public/apple/notifications", async (req, res) => {
    try {
      const r = await onNotification(req.body?.signedPayload);
      res.json({ success: true, ...r });
    } catch (err) {
      if (err instanceof apple.AppleError) return res.status(400).json({ success: false, message: "invalid" });
      console.error("[app-store] notification", err);
      res.status(500).json({ success: false }); // Apple retries
    }
  });
};
module.exports.verify = verify;
module.exports.onNotification = onNotification;
