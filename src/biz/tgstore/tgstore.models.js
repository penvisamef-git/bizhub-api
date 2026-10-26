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
    color: { type: String, default: "" }, // "" = the colour of the design
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
      // the owner's own ways to pay: "ABA 000 123 456", "Wing", a bank QR picture (more + pictures = add-on ts_pay)
      custom: {
        type: [
          {
            name: { type: String, required: true, maxlength: 40 },
            info: { type: String, default: "", maxlength: 300 },
            image: photo,
            on: { type: Boolean, default: true },
          },
        ],
        default: [],
      },
    },
    theme: { type: String, default: "grid-cream" }, // one of tgstore.themes.js
    channel_text: { type: String, default: "", maxlength: 600 }, // the post for the owner's channel ("" = ours); {name} {link}
    qr: { fg: { type: String, default: "#1F1A16" }, bg: { type: String, default: "#FFFFFF" }, logo: { type: Boolean, default: false } }, // add-on ts_link
    old_slugs: { type: [String], default: [] }, // links that still work after renaming (add-on ts_link)
    // the staff's Telegram group (or the owner's chat): new orders with Accept / Reject buttons
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
    },
    // opening hours (add-on ts_hours): 7 days, Sunday first; "close" before "open" = past midnight
    hours: {
      on: { type: Boolean, default: false },
      days: {
        type: [{ _id: false, open: { type: String, default: "07:00" }, close: { type: String, default: "21:00" }, closed: { type: Boolean, default: false } }],
        default: () => Array.from({ length: 7 }, () => ({ open: "07:00", close: "21:00", closed: false })),
      },
    },
    // cart reminder (add-on ts_remind): a Telegram customer who left items in the cart gets one message after a while
    remind: {
      on: { type: Boolean, default: true },
      after_min: { type: Number, default: 60, min: 15, max: 1440 },
      text: { type: String, default: "", maxlength: 300 }, // "" = ours; {name} {shop} {n}
      sent: { type: Number, default: 0 },
      back: { type: Number, default: 0 }, // reminded carts that became an order
      back_total: { type: Number, default: 0 },
    },
    // delivery zones (add-on ts_zones): a fee per area the customer picks, or by distance from the shop (the customer's pin)
    zones: {
      on: { type: Boolean, default: false },
      kind: { type: String, enum: ["area", "distance"], default: "area" },
      areas: {
        type: [{ name: { type: String, required: true, maxlength: 60 }, fee: { type: Number, default: 0, min: 0, max: 1000000 }, min_order: { type: Number, default: 0, min: 0, max: 100000000 }, on: { type: Boolean, default: true } }],
        default: [],
      },
      steps: { type: [{ _id: false, upto: { type: Number, min: 0.1, max: 200 }, fee: { type: Number, default: 0, min: 0, max: 1000000 } }], default: [] }, // up to 3 km → $1 …
      lat: { type: Number, default: null, min: -90, max: 90 },
      lng: { type: Number, default: null, min: -180, max: 180 },
    },
    // the riders' Telegram group (add-on ts_riders): delivery orders go there, a rider taps Take it → Picked up → Delivered
    riders: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
      send_on: { type: String, enum: ["accepted", "ready", "manual"], default: "accepted" }, // when the order goes to the riders
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
    pin: { lat: { type: Number, default: null }, lng: { type: Number, default: null } }, // the last delivery location
    can_message: { type: Boolean, default: false }, // the bot may send them their order updates
    note: { type: String, default: "", maxlength: 300 }, // the owner's own note ("likes less sugar")
    placed: { type: Number, default: 0 }, // orders sent (done or not)
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
    discount: { type: Number, default: 0 }, // promo code (add-on ts_promos)
    promo: { type: String, default: "" },
    fee: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    pay: {
      method: { type: String, enum: ["khqr", "cash", "custom"], default: "cash" },
      custom: { id: String, name: String, info: String, image: String }, // the owner's own way to pay, as it was when ordering
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
    zone: { name: { type: String, default: "" }, km: { type: Number, default: null }, lat: { type: Number, default: null }, lng: { type: Number, default: null } }, // add-on ts_zones (+ the pin)
    rider: { tg_id: String, name: String, username: String, taken_at: Date, picked_at: Date, delivered_at: Date }, // add-on ts_riders
    rider_msg: { chat_id: String, message_id: Number }, // the order message in the riders' group
    from_remind: { type: Boolean, default: false }, // placed after a cart reminder
  },
  opts,
);
orderSchema.index({ business_id: 1, no: 1 }, { unique: true });
orderSchema.index({ business_id: 1, created_date: -1 });

// promo codes (add-on ts_promos): "SAVE10" = 10 % off, or $1 off; from an order size, until a date, so many times
const promoSchema = new Schema(
  {
    ...owned,
    code: { type: String, required: true, maxlength: 20 }, // upper case
    kind: { type: String, enum: ["percent", "amount"], default: "percent" },
    value: { type: Number, required: true, min: 0, max: 100000000 },
    min_order: { type: Number, default: 0, min: 0, max: 100000000 },
    ends_at: { type: Date, default: null },
    max_uses: { type: Number, default: 0, min: 0, max: 1000000 }, // 0 = no limit
    used: { type: Number, default: 0 },
    on: { type: Boolean, default: true },
    deleted: { type: Boolean, default: false },
  },
  opts,
);
promoSchema.index({ business_id: 1, code: 1 }, { unique: true, partialFilterExpression: { deleted: false } });

// a message the owner sent to the customers in Telegram (add-on ts_broadcast)
const broadcastSchema = new Schema(
  {
    ...owned,
    text: { type: String, required: true, maxlength: 1000 },
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    by: { type: String, default: "" },
  },
  opts,
);

// what a Telegram customer has in the cart and hasn't ordered yet (add-on ts_remind)
const cartSchema = new Schema(
  {
    ...owned,
    tg_id: { type: String, required: true },
    name: { type: String, default: "" },
    username: { type: String, default: "" },
    can_message: { type: Boolean, default: false },
    items: { type: [{ _id: false, product_id: ObjectId, qty: Number, options: [{ _id: false, group: String, choice: String }], note: String }], default: [] },
    total: { type: Number, default: 0 }, // about how much (for the owner's list)
    at: { type: Date, default: Date.now }, // last change
    reminded_at: { type: Date, default: null }, // looked at by the reminder (sent or not)
    reminded: { type: Boolean, default: false }, // the message really went
  },
  opts,
);
cartSchema.index({ business_id: 1, tg_id: 1 }, { unique: true });
cartSchema.index({ reminded_at: 1, at: 1 });

module.exports = {
  TgCart: mongoose.models.TgCart || mongoose.model("TgCart", cartSchema),
  TgPromo: mongoose.models.TgPromo || mongoose.model("TgPromo", promoSchema),
  TgBroadcast: mongoose.models.TgBroadcast || mongoose.model("TgBroadcast", broadcastSchema),
  TgStore: mongoose.models.TgStore || mongoose.model("TgStore", storeSchema),
  TgCategory: mongoose.models.TgCategory || mongoose.model("TgCategory", categorySchema),
  TgProduct: mongoose.models.TgProduct || mongoose.model("TgProduct", productSchema),
  TgCustomer: mongoose.models.TgCustomer || mongoose.model("TgCustomer", customerSchema),
  TgOrder: mongoose.models.TgOrder || mongoose.model("TgOrder", orderSchema),
  STATUSES,
};
