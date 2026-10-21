// Debt Book: a shop's customers who owe money, each debt and each payment (USD and riel kept apart).
// Balances are kept on the customer (changed with $inc when a line is added / cancelled / brought back).
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const money = { usd: { type: Number, default: 0 }, khr: { type: Number, default: 0 } };

// one per business: shop details for statements, exchange rate, reminders, the owner's Telegram
const bookSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    shop_name: { type: String, default: "", maxlength: 80 },
    phone: { type: String, default: "", maxlength: 40 },
    address: { type: String, default: "", maxlength: 200 },
    logo: { type: String, default: "" },
    logo_public_id: { type: String, default: "" },
    main: { type: String, enum: ["USD", "KHR"], default: "USD" }, // the currency a new line starts in
    rate: { type: Number, default: 4100, min: 1000, max: 10000 }, // riel per dollar (for "total in $")
    // auto reminders (debt_remind)
    remind: {
      on: { type: Boolean, default: true },
      before: { type: Number, default: 1, min: 0, max: 7 }, // days before the due date (0 = only on the day)
      every: { type: Number, default: 7, min: 0, max: 30 }, // after the due date: again every N days (0 = once)
      time: { type: String, default: "09:00" },
      text_km: { type: String, default: "", maxlength: 500 }, // own words (empty = the standard message)
      text_en: { type: String, default: "", maxlength: 500 },
      last_run_at: { type: Date, default: null },
    },
    // the owner's chat: daily summary (debt_remind)
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "", index: true },
      link_expires: { type: Date, default: null },
      daily: { type: Boolean, default: true },
      last_daily_at: { type: Date, default: null },
    },
    web: { type: String, default: "", maxlength: 200 }, // the web address the owner uses (links in Telegram messages)
    seq: { type: Number, default: 0 }, // receipt numbers
  },
  opts,
);

const customerSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, default: "", trim: true, maxlength: 40 },
    telegram: { type: String, default: "", trim: true, maxlength: 60 }, // @username or phone
    address: { type: String, default: "", maxlength: 200 },
    note: { type: String, default: "", maxlength: 500 },
    photo: { type: String, default: "" },
    photo_public_id: { type: String, default: "" },
    limit: money, // credit limit (0 = none)
    balance: money, // what they owe now
    due_at: { type: Date, default: null }, // when it should be paid (cleared when paid off)
    last_at: { type: Date, default: null }, // last debt / payment
    token: { type: String, required: true, unique: true }, // the statement link /d/<token>
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      code: { type: String, default: "", index: true }, // t.me/<bot>?start=dc_<code>
      linked_at: { type: Date, default: null },
    },
    remind: { type: Boolean, default: true }, // this person gets auto reminders
    last_remind_at: { type: Date, default: null },
    reminds: { type: Number, default: 0 },
    deleted: { type: Boolean, default: false },
    deleted_at: { type: Date, default: null },
  },
  opts,
);
customerSchema.index({ business_id: 1, deleted: 1, name: 1 });

// one line: a debt (they took goods / money) or a payment (they paid back)
const entrySchema = new Schema(
  {
    ...owned,
    customer_id: { type: ObjectId, ref: "DebtCustomer", required: true },
    kind: { type: String, enum: ["debt", "pay"], required: true },
    currency: { type: String, enum: ["USD", "KHR"], required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: "", maxlength: 300 }, // what they took / how they paid
    method: { type: String, default: "", maxlength: 30 }, // cash, ABA, Wing…
    due_at: { type: Date, default: null },
    date: { type: Date, default: Date.now },
    no: { type: Number, default: 0 }, // receipt number
    by: { kind: { type: String, default: "owner" }, id: { type: String, default: "" }, name: { type: String, default: "" } },
    void: { type: Boolean, default: false },
    void_at: { type: Date, default: null },
    void_by: { type: String, default: "" },
    void_reason: { type: String, default: "", maxlength: 200 },
  },
  opts,
);
entrySchema.index({ business_id: 1, customer_id: 1, date: -1 });
entrySchema.index({ business_id: 1, date: -1 });

module.exports = {
  DebtBook: mongoose.model("DebtBook", bookSchema),
  DebtCustomer: mongoose.model("DebtCustomer", customerSchema),
  DebtEntry: mongoose.model("DebtEntry", entrySchema),
};
