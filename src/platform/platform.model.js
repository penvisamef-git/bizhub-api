// BizHub ↔ customers: buying coins by bank transfer (coin orders) and "Chat with BizHub" (support inbox).
const mongoose = require("mongoose");

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const pic = { url: { type: String, default: "" }, public_id: { type: String, default: "" } };

// the coin packages customers can buy (the super admin can change them)
const DEFAULT_PACKAGES = [
  { key: "p100", coins: 100, usd: 10, bonus_pct: 0 },
  { key: "p250", coins: 250, usd: 25, bonus_pct: 10 },
  { key: "p500", coins: 500, usd: 50, bonus_pct: 15 },
  { key: "p1000", coins: 1000, usd: 100, bonus_pct: 20 },
  { key: "p2500", coins: 2500, usd: 250, bonus_pct: 30 },
];

// one document (key "main"): packages, the bank accounts / QR codes customers pay to, the hotline, the super admin's Telegram
const settingsSchema = new Schema(
  {
    key: { type: String, default: "main", unique: true },
    packages: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          coins: { type: Number, required: true, min: 1 },
          usd: { type: Number, required: true, min: 0 },
          bonus_pct: { type: Number, default: 0, min: 0, max: 100 },
          active: { type: Boolean, default: true },
        },
      ],
      default: () => DEFAULT_PACKAGES.map((p) => ({ ...p, active: true })),
    },
    banks: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          name: { type: String, required: true, trim: true, maxlength: 60 }, // ABA, ACLEDA, Wing, KHQR…
          account_name: { type: String, default: "", trim: true, maxlength: 80 },
          account_no: { type: String, default: "", trim: true, maxlength: 60 },
          note: { type: String, default: "", trim: true, maxlength: 200 },
          qr: pic,
          link: { type: String, default: "", trim: true, maxlength: 300 }, // pay link (ABA PayWay…): opens the bank app
          // QR pictures with the amount already in them (ABA / KHQR "fixed amount"): shown at checkout when the cart total matches
          amount_qrs: { type: [{ _id: false, usd: { type: Number, min: 0 }, qr: pic, link: { type: String, default: "", trim: true, maxlength: 300 } }], default: [] },
          active: { type: Boolean, default: true },
        },
      ],
      default: [],
    },
    hotline: {
      phone: { type: String, default: "", trim: true, maxlength: 40 },
      telegram: { type: String, default: "", trim: true, maxlength: 80 },
      email: { type: String, default: "", trim: true, maxlength: 120 },
      hours: { type: String, default: "", trim: true, maxlength: 120 },
      note: { type: String, default: "", trim: true, maxlength: 300 }, // shown after a coin order
    },
    // the super admin's Telegram: new coin orders + new chat messages
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
      coin_orders: { type: Boolean, default: true },
      chat: { type: Boolean, default: true },
      app_errors: { type: Boolean, default: true }, // crashes of the BizHub app
    },
    next_order: { type: Number, default: 1 }, // CO-0001
  },
  opts,
);

const ORDER_STATUSES = ["pending", "approved", "rejected", "cancelled"];
const orderSchema = new Schema(
  {
    no: { type: String, default: "" },
    customer_id: { type: ObjectId, ref: "Customer", required: true, index: true },
    items: {
      type: [{ _id: false, key: String, coins: Number, usd: Number, bonus_pct: Number, qty: Number }],
      default: [],
    },
    coins: { type: Number, default: 0 }, // bought
    bonus: { type: Number, default: 0 }, // free
    total_coins: { type: Number, default: 0 }, // coins + bonus
    usd: { type: Number, default: 0 }, // to pay
    bank: { key: { type: String, default: "" }, name: { type: String, default: "" } },
    proof: pic, // the transfer screenshot
    reference: { type: String, default: "", trim: true, maxlength: 80 }, // transaction id
    note: { type: String, default: "", trim: true, maxlength: 300 },
    status: { type: String, enum: ORDER_STATUSES, default: "pending", index: true },
    reason: { type: String, default: "", maxlength: 300 }, // why rejected
    done_by: { type: ObjectId, ref: "User", default: null },
    done_at: { type: Date, default: null },
    tx_id: { type: ObjectId, default: null }, // the coin transaction when approved
  },
  opts,
);
orderSchema.index({ status: 1, created_date: -1 });

// "Chat with BizHub": one conversation per customer
const threadSchema = new Schema(
  {
    customer_id: { type: ObjectId, ref: "Customer", required: true, unique: true },
    last_at: { type: Date, default: Date.now, index: true },
    last_text: { type: String, default: "" },
    last_from: { type: String, enum: ["customer", "admin"], default: "customer" },
    unread_admin: { type: Number, default: 0 }, // the customer's messages the team hasn't opened
    unread_customer: { type: Number, default: 0 },
    alerted_at: { type: Date, default: null }, // last Telegram alert (not one per message)
    customer_seen_at: { type: Date, default: null }, // "seen": when each side last opened the chat
    admin_seen_at: { type: Date, default: null },
  },
  opts,
);
const fileSchema = new Schema({ url: String, public_id: String, resource_type: { type: String, default: "image" }, name: String, type: String, size: Number }, { _id: false });
const messageSchema = new Schema(
  {
    thread_id: { type: ObjectId, required: true, index: true },
    from: { type: String, enum: ["customer", "admin"], required: true },
    by_name: { type: String, default: "" },
    by_user: { type: ObjectId, ref: "User", default: null },
    text: { type: String, default: "", maxlength: 4000 },
    files: { type: [fileSchema], default: [] },
    kind: { type: String, default: "" }, // "" or "coin_order" (sent by the system)
  },
  opts,
);
messageSchema.index({ thread_id: 1, created_date: -1 });

module.exports = {
  DEFAULT_PACKAGES,
  ORDER_STATUSES,
  PlatformSettings: mongoose.model("PlatformSettings", settingsSchema),
  CoinOrder: mongoose.model("CoinOrder", orderSchema),
  SupportThread: mongoose.model("SupportThread", threadSchema),
  SupportMessage: mongoose.model("SupportMessage", messageSchema),
};
