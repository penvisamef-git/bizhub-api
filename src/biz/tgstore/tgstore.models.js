// Telegram Store (v2.0): a shop customers open inside Telegram (or any browser): categories, products, orders.
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const photo = { url: { type: String, default: "" }, public_id: { type: String, default: "" } };

// one per business: the shop's look, how people get their order, how they pay, the staff's Telegram group
const storeSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    slug: { type: String, required: true, unique: true }, // /t/<slug> · t.me/<bot>?start=st_<slug>
    shop_name: { type: String, default: "", maxlength: 80 },
    phone: { type: String, default: "", maxlength: 40 },
    address: { type: String, default: "", maxlength: 200 },
    about: { type: String, default: "", maxlength: 300 }, // one line under the name (hours, promo…)
    logo: photo,
    color: { type: String, default: "#C4470F" },
    currency: { type: String, enum: ["USD", "KHR"], default: "USD" },
    open: { type: Boolean, default: true }, // closed → people can look, not order
    delivery: {
      on: { type: Boolean, default: true },
      fee: { type: Number, default: 1, min: 0, max: 1000000 },
      free_from: { type: Number, default: 0, min: 0, max: 100000000 }, // 0 = never free
      min_order: { type: Number, default: 0, min: 0, max: 100000000 },
      note: { type: String, default: "", maxlength: 160 }, // "Phnom Penh only · about 30 min"
    },
    pickup: { on: { type: Boolean, default: true }, note: { type: String, default: "", maxlength: 160 } },
    dine_in: { on: { type: Boolean, default: false }, tables: { type: Number, default: 10, min: 1, max: 300 } },
    pay: {
      khqr: { on: { type: Boolean, default: false }, bakong_id: { type: String, default: "", maxlength: 60 }, account_name: { type: String, default: "", maxlength: 40 } },
      cash: { on: { type: Boolean, default: true } },
    },
    // the staff's Telegram group (or the owner's chat): new orders with Accept / Reject buttons
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
    },
    seq: { type: Number, default: 0 }, // order numbers
    web: { type: String, default: "" }, // the website address the owner uses (links + the Telegram button)
  },
  opts,
);

const categorySchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, maxlength: 60 },
    name_km: { type: String, default: "", maxlength: 80 },
    sort: { type: Number, default: 0 },
    deleted: { type: Boolean, default: false },
  },
  opts,
);

// a product: price, photo, choices (size, sugar…), stock (null = no count)
const choiceSchema = new Schema({ name: { type: String, required: true, maxlength: 40 }, price: { type: Number, default: 0, min: 0, max: 100000000 } }, { _id: false });
const optionSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 40 }, // "Size", "Sugar"
    multi: { type: Boolean, default: false }, // several can be picked (toppings)
    required: { type: Boolean, default: false },
    choices: { type: [choiceSchema], default: [] },
  },
  { _id: false },
);
const productSchema = new Schema(
  {
    ...owned,
    category_id: { type: ObjectId, default: null },
    name: { type: String, required: true, maxlength: 80 },
    name_km: { type: String, default: "", maxlength: 120 },
    about: { type: String, default: "", maxlength: 300 },
    price: { type: Number, required: true, min: 0, max: 100000000 },
    photo,
    options: { type: [optionSchema], default: [] },
    stock: { type: Number, default: null, min: 0, max: 1000000 }, // null = don't count
    sold_out: { type: Boolean, default: false },
    hidden: { type: Boolean, default: false },
    sort: { type: Number, default: 0 },
    deleted: { type: Boolean, default: false },
  },
  opts,
);
productSchema.index({ business_id: 1, deleted: 1, sort: 1 });

// someone who ordered: a Telegram account (tg_id) or a phone number from the browser
const customerSchema = new Schema(
  {
    ...owned,
    tg_id: { type: String, default: "" },
    username: { type: String, default: "" },
    name: { type: String, default: "", maxlength: 80 },
    phone: { type: String, default: "", maxlength: 20 },
    address: { type: String, default: "", maxlength: 200 },
    can_message: { type: Boolean, default: false }, // the bot may send them their order updates
    orders: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    last_order_at: { type: Date, default: null },
  },
  opts,
);
customerSchema.index({ business_id: 1, tg_id: 1 }, { unique: true, partialFilterExpression: { tg_id: { $gt: "" } } });
customerSchema.index({ business_id: 1, phone: 1 });

const lineSchema = new Schema(
  {
    product_id: { type: ObjectId, default: null },
    name: { type: String, default: "" },
    price: { type: Number, default: 0 }, // one, with its choices
    qty: { type: Number, default: 1 },
    options: [{ _id: false, group: String, choice: String, price: Number }],
    note: { type: String, default: "", maxlength: 120 },
    total: { type: Number, default: 0 },
  },
  { _id: false },
);
const STATUSES = ["new", "accepted", "ready", "on_way", "done", "cancelled"];
const orderSchema = new Schema(
  {
    ...owned,
    no: { type: Number, required: true },
    token: { type: String, required: true, unique: true }, // the customer's private link to follow the order
    mode: { type: String, enum: ["delivery", "pickup", "dine_in"], required: true },
    table: { type: String, default: "", maxlength: 10 },
    address: { type: String, default: "", maxlength: 200 },
    note: { type: String, default: "", maxlength: 300 },
    customer_id: { type: ObjectId, default: null },
    customer: { tg_id: String, username: String, name: String, phone: String },
    items: { type: [lineSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    fee: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    pay: {
      method: { type: String, enum: ["khqr", "cash"], default: "cash" },
      status: { type: String, enum: ["unpaid", "proof", "paid"], default: "unpaid" },
      proof: photo, // a screenshot of the payment the customer sent
      paid_at: { type: Date, default: null },
      khqr: { qr: String, md5: String, amount: Number, expires: Date, checked_at: Date },
    },
    status: { type: String, enum: STATUSES, default: "new", index: true },
    eta_min: { type: Number, default: 0 },
    reason: { type: String, default: "", maxlength: 160 }, // why it was cancelled
    timeline: [{ _id: false, status: String, at: { type: Date, default: Date.now }, by: String }],
    tg_msg: { chat_id: String, message_id: Number }, // the order message in the staff group (edited on every change)
    via: { type: String, enum: ["telegram", "web"], default: "web" },
  },
  opts,
);
orderSchema.index({ business_id: 1, no: 1 }, { unique: true });
orderSchema.index({ business_id: 1, created_date: -1 });

module.exports = {
  TgStore: mongoose.models.TgStore || mongoose.model("TgStore", storeSchema),
  TgCategory: mongoose.models.TgCategory || mongoose.model("TgCategory", categorySchema),
  TgProduct: mongoose.models.TgProduct || mongoose.model("TgProduct", productSchema),
  TgCustomer: mongoose.models.TgCustomer || mongoose.model("TgCustomer", customerSchema),
  TgOrder: mongoose.models.TgOrder || mongoose.model("TgOrder", orderSchema),
  STATUSES,
};
