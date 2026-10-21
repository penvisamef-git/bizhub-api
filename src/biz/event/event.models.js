// Event Tickets: one settings doc per business (organiser, payment QR, door pairing, Telegram), its events
// (ticket types with price + quantity), orders (paid by the organiser's KHQR + screenshot, or free registration),
// tickets (one QR each, used once at the door), the team (role + PIN) and the paired door phones.
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const pic = { url: { type: String, default: "" }, public_id: { type: String, default: "" } };

// one per business
const settingsSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true, unique: true },
    org_name: { type: String, default: "", maxlength: 80 }, // the organiser shown on the event pages
    phone: { type: String, default: "", maxlength: 40 },
    telegram: { type: String, default: "", maxlength: 80 }, // contact (@name)
    logo: pic,
    // how buyers pay: the organiser's own QR / pay link (ABA PayWay…) + account
    pay: {
      qr: pic,
      link: { type: String, default: "", maxlength: 300 },
      bank: { type: String, default: "", maxlength: 60 }, // ABA, ACLEDA, KHQR…
      account_name: { type: String, default: "", maxlength: 80 },
      account_no: { type: String, default: "", maxlength: 60 },
      note: { type: String, default: "", maxlength: 200 },
    },
    // several ways to pay (ABA, ACLEDA, Wing, KHQR…); each event picks the ones it accepts (none picked = all)
    pay_methods: {
      type: [
        new Schema(
          {
            key: { type: String, required: true },
            bank: { type: String, default: "", maxlength: 60 },
            account_name: { type: String, default: "", maxlength: 80 },
            account_no: { type: String, default: "", maxlength: 60 },
            link: { type: String, default: "", maxlength: 300 },
            note: { type: String, default: "", maxlength: 200 },
            qr: pic,
            bakong_id: { type: String, default: "", maxlength: 60 }, // ev_autopay: name@aba → a KHQR with the exact amount, paid orders confirm by themselves
            active: { type: Boolean, default: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    hold_minutes: { type: Number, default: 30, min: 10, max: 1440 }, // an order waits this long for its screenshot, then the tickets go back on sale
    seq: { type: Number, default: 0 }, // order numbers
    web: { type: String, default: "" }, // the website the owner uses (for links in Telegram)
    // door phones: a 6-digit code to pair a new one
    pair_code: { type: String, default: "", index: true },
    pair_expires: { type: Date, default: null },
    // ev_telegram: the organiser's chat (new orders with Approve / Reject buttons)
    listed: { type: Boolean, default: false }, // show published events on the public "Events in Cambodia" page
    tg: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "", index: true },
      link_expires: { type: Date, default: null },
      daily: { type: Boolean, default: true }, // the day's summary at 20:00
      new_orders: { type: Boolean, default: true }, // each screenshot with Approve / Reject buttons
      last_daily_at: { type: Date, default: null },
    },
    // ev_guest_tg: what guests get on Telegram
    guest_tg: {
      remind_day: { type: Boolean, default: true }, // the day before
      remind_hours: { type: Boolean, default: true }, // 2 hours before
    },
  },
  opts,
);

// an event: open entry / ticket types (concert, show) or free registration (seminar)
const typeSchema = new Schema(
  {
    key: { type: String, required: true }, // t_ab12cd — stays the same when renamed
    name: { type: String, required: true, maxlength: 60 }, // Standard, Gold, Premium…
    price: { type: Number, default: 0, min: 0, max: 100000 }, // USD (0 on free events)
    qty: { type: Number, default: 100, min: 1, max: 100000 }, // how many can be sold
    taken: { type: Number, default: 0, min: 0 }, // sold + waiting for payment (held)
    color: { type: String, default: "" },
    note: { type: String, default: "", maxlength: 120 }, // "Front zone, free drink"
    active: { type: Boolean, default: true }, // false = not sold any more (kept for the tickets already sold)
    // ev_pricing: early-bird / timed prices — until this date this price, then the next, then `price`
    tiers: { type: [{ _id: false, label: { type: String, default: "", maxlength: 40 }, price: { type: Number, min: 0, max: 100000 }, until: Date }], default: [] },
    // ev_bundles: group deals — "4 for $30" (the best mix is used)
    bundles: { type: [{ _id: false, qty: { type: Number, min: 2, max: 50 }, price: { type: Number, min: 0, max: 100000 } }], default: [] },
  },
  { _id: false },
);
const eventSchema = new Schema(
  {
    ...owned,
    slug: { type: String, required: true, unique: true }, // /ev/<slug>
    title: { type: String, required: true, maxlength: 120 },
    about: { type: String, default: "", maxlength: 4000 },
    poster: pic,
    theme: { type: String, default: "classic", maxlength: 40 }, // the ticket design (event.themes.js)
    pay_methods: { type: [String], default: [] }, // the organiser's payment methods this event accepts (empty = all)
    page_theme: { type: String, default: "standard", maxlength: 40 }, // the event / order page look (event.themes.js)
    // the owner's own colours for the designs (empty = the design's colours): a main · b light · c deep
    theme_colors: { a: { type: String, default: "" }, b: { type: String, default: "" }, c: { type: String, default: "" } },
    page_colors: { a: { type: String, default: "" }, b: { type: String, default: "" }, c: { type: String, default: "" } },
    kind: { type: String, enum: ["paid", "free"], default: "paid" }, // free = registration only
    starts_at: { type: Date, required: true },
    ends_at: { type: Date, default: null },
    venue: { type: String, default: "", maxlength: 160 },
    map_url: { type: String, default: "", maxlength: 300 },
    types: { type: [typeSchema], default: [] },
    max_per_order: { type: Number, default: 10, min: 1, max: 50 },
    terms: { type: String, default: "", maxlength: 1000 },
    status: { type: String, enum: ["draft", "published", "closed", "cancelled"], default: "draft" }, // closed = no more sales (page still open)
    sale_ends_at: { type: Date, default: null }, // empty = until the event starts
    // ev_shows: the same event on several dates / times — every ticket type has its quantity for each show
    shows: {
      type: [
        new Schema(
          {
            key: { type: String, required: true },
            starts_at: { type: Date, required: true },
            ends_at: { type: Date, default: null },
            label: { type: String, default: "", maxlength: 60 },
            active: { type: Boolean, default: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    // ev_seats: seated sections, each sells one ticket type; seats are "<section>:<row><n>" (A1, B12…)
    seating: {
      on: { type: Boolean, default: false },
      sections: {
        type: [
          new Schema(
            {
              key: { type: String, required: true },
              name: { type: String, default: "", maxlength: 40 },
              type_key: { type: String, default: "" },
              rows: { type: Number, default: 5, min: 1, max: 40 },
              cols: { type: Number, default: 10, min: 1, max: 60 },
              blocked: { type: [String], default: [] }, // no seat here (aisle, pillar…)
            },
            { _id: false },
          ),
        ],
        default: [],
      },
    },
    // ev_questions: asked when ordering (per order) + a name for each ticket
    questions: {
      type: [
        new Schema(
          {
            key: { type: String, required: true },
            label: { type: String, required: true, maxlength: 120 },
            kind: { type: String, enum: ["text", "long", "choice", "yesno", "email", "number"], default: "text" },
            options: { type: [String], default: [] },
            required: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    ask_names: { type: Boolean, default: false },
    // ev_certs: a certificate for each guest (checked in, or everyone with a ticket)
    cert: {
      on: { type: Boolean, default: false },
      who: { type: String, enum: ["checked_in", "all"], default: "checked_in" },
      title: { type: String, default: "Certificate of Attendance", maxlength: 80 },
      body: { type: String, default: "This is to certify that {name} attended {event} on {date}.", maxlength: 400 },
      signer: { type: String, default: "", maxlength: 60 },
      signer_title: { type: String, default: "", maxlength: 60 },
      design: { type: String, default: "classic", maxlength: 40 },
      signature: { url: { type: String, default: "" }, public_id: { type: String, default: "" } }, // uploaded or drawn (PNG)
    },
    // ev_sponsors: logos on the event page, order page and certificates
    sponsors: { type: [{ _id: false, key: String, name: { type: String, maxlength: 60 }, link: { type: String, default: "", maxlength: 300 }, tier: { type: String, enum: ["main", "gold", "partner"], default: "partner" }, logo: pic }], default: [] },
    // ev_feedback: ask guests for stars + a comment after the event
    feedback: { on: { type: Boolean, default: false }, question: { type: String, default: "", maxlength: 160 } },
    // the public "Events in Cambodia" page: featured until (ev_feature, bought per 7 days)
    featured_until: { type: Date, default: null },
    category: { type: String, default: "", maxlength: 30 }, // music, workshop, sport… (for the events page)
    city: { type: String, default: "", maxlength: 40 },
    // ev_guest_tg: live updates (event page + Telegram) and documents (programme, map…)
    updates: { type: [new Schema({ text: { type: String, maxlength: 1000 }, at: { type: Date, default: Date.now }, sent: { type: Number, default: 0 } })], default: [] },
    docs: {
      type: [new Schema({ key: String, name: { type: String, maxlength: 80 }, url: String, public_id: String, kind: String, resource: String }, { _id: false })],
      default: [],
    },
  },
  opts,
);
eventSchema.index({ business_id: 1, starts_at: -1 });

// an order: one buyer, some tickets
const orderSchema = new Schema(
  {
    ...owned,
    event_id: { type: ObjectId, ref: "EvEvent", required: true, index: true },
    no: { type: String, required: true }, // #A0012
    token: { type: String, required: true, unique: true }, // the buyer's link /ev/o/<token>
    buyer: {
      name: { type: String, default: "", maxlength: 80 },
      phone: { type: String, default: "", maxlength: 20 },
    },
    lines: [{ _id: false, key: String, name: String, price: Number, qty: Number }],
    qty: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 }, // before the promo code
    total: { type: Number, default: 0 }, // USD, to pay
    show: { type: String, default: "" }, // ev_shows: which date / time
    seats: { type: [String], default: [] }, // ev_seats
    promo: { code: { type: String, default: "" }, off: { type: Number, default: 0 } }, // ev_promos
    answers: { type: [{ _id: false, key: String, label: String, value: String }], default: [] }, // ev_questions
    names: { type: [String], default: [] }, // a name per ticket
    // ev_guest_tg: the buyer's Telegram + what was sent
    tg: {
      code: { type: String, default: "", index: true },
      chat_id: { type: String, default: "" },
      linked_at: { type: Date, default: null },
      tickets_sent: { type: Boolean, default: false },
      day_sent: { type: Date, default: null },
      hours_sent: { type: Date, default: null },
    },
    // ev_telegram: the organiser's message for this order (edited after Approve / Reject)
    tg_msg: { chat_id: { type: String, default: "" }, id: { type: Number, default: 0 } },
    // pending = waiting for the screenshot (held until hold_until) · review = screenshot sent, the organiser checks
    // paid = tickets made · rejected · expired (no screenshot in time) · cancelled
    status: { type: String, enum: ["pending", "review", "paid", "rejected", "expired", "cancelled"], default: "pending", index: true },
    hold_until: { type: Date, default: null },
    proof: pic, // the transfer screenshot
    pay_key: { type: String, default: "" }, // which payment method the buyer used
    // ev_autopay: the KHQR made for this order (Bakong confirms it by its md5)
    khqr: { key: { type: String, default: "" }, qr: { type: String, default: "" }, md5: { type: String, default: "", index: true }, amount: { type: Number, default: 0 }, expires: { type: Date, default: null }, checked_at: { type: Date, default: null } },
    cert_sent: { type: Date, default: null }, // ev_certs: certificate links sent on Telegram
    bundle_off: { type: Number, default: 0 }, // ev_bundles: saved by group deals
    ref: { type: String, default: "", index: true }, // ev_referrals: the promoter's code
    feedback_sent: { type: Date, default: null }, // ev_feedback: asked on Telegram
    // refunds + transfers asked by the buyer (the organiser approves)
    requests: { type: [{ kind: { type: String, enum: ["refund", "transfer"] }, tickets: [String], to_name: String, to_phone: String, note: { type: String, maxlength: 300 }, status: { type: String, enum: ["open", "done", "declined"], default: "open" }, reply: { type: String, default: "" }, at: { type: Date, default: Date.now }, decided_at: Date, decided_by: String }], default: [] },
    refunded: { type: Number, default: 0 }, // money given back (USD, by the organiser outside BizHub)
    pay_label: { type: String, default: "" },
    reference: { type: String, default: "", maxlength: 80 }, // transaction id the buyer typed
    note: { type: String, default: "", maxlength: 300 },
    reason: { type: String, default: "", maxlength: 200 }, // why it was rejected / cancelled
    via: { type: String, enum: ["online", "gate", "invite"], default: "online" },
    method: { type: String, default: "" }, // gate sales: cash | qr
    decided_by: { type: String, default: "" },
    decided_at: { type: Date, default: null },
  },
  opts,
);
orderSchema.index({ business_id: 1, status: 1, created_date: -1 });

// one ticket = one QR = one person through the door
const ticketSchema = new Schema(
  {
    ...owned,
    event_id: { type: ObjectId, ref: "EvEvent", required: true, index: true },
    order_id: { type: ObjectId, ref: "EvOrder", required: true, index: true },
    code: { type: String, required: true, unique: true }, // in the QR (/ev/t/<code>)
    no: { type: Number, default: 1 }, // 1, 2… in the order
    type_key: { type: String, default: "" },
    type_name: { type: String, default: "" },
    price: { type: Number, default: 0 },
    show: { type: String, default: "" },
    show_at: { type: Date, default: null },
    seat: { type: String, default: "" }, // "<section>:<seat>"
    seat_label: { type: String, default: "" }, // "Floor · B12"
    holder: { type: String, default: "", maxlength: 80 },
    status: { type: String, enum: ["valid", "used", "cancelled"], default: "valid", index: true },
    used_at: { type: Date, default: null },
    used_by: { type: String, default: "" }, // team member / owner
    used_device: { type: String, default: "" },
    transfers: { type: [{ _id: false, from: String, to: String, phone: String, at: Date, by: String }], default: [] }, // given to someone else (a new code each time)
  },
  opts,
);

// the organiser's team: door (scan), crew (guest list, counts), cashier (sell at the gate — ev_cashier), manager (approve, money)
const memberSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, maxlength: 60 },
    role: { type: String, enum: ["door", "crew", "cashier", "manager"], default: "door" },
    pin_key: { type: String, required: true }, // sha256(business + pin): finds the member from the PIN
    pin_v: { type: Number, default: 0 }, // a new PIN logs them out
    active: { type: Boolean, default: true },
  },
  opts,
);
memberSchema.index({ business_id: 1, pin_key: 1 });

// a paired door phone
const deviceSchema = new Schema(
  {
    ...owned,
    name: { type: String, default: "Door", maxlength: 60 },
    token_hash: { type: String, required: true, index: true },
    revoked: { type: Boolean, default: false },
    last_seen: { type: Date, default: null },
  },
  opts,
);

// ev_shows: tickets taken per show + type (the event's types hold the quantity)
const stockSchema = new Schema({ event_id: { type: ObjectId, required: true }, show: { type: String, required: true }, key: { type: String, required: true }, taken: { type: Number, default: 0 } });
stockSchema.index({ event_id: 1, show: 1, key: 1 }, { unique: true });
// ev_seats: one row per seat that is held or sold (unique → never sold twice)
const seatSchema = new Schema({ event_id: { type: ObjectId, required: true }, show: { type: String, default: "" }, seat: { type: String, required: true }, order_id: { type: ObjectId, required: true, index: true }, at: { type: Date, default: Date.now } });
seatSchema.index({ event_id: 1, show: 1, seat: 1 }, { unique: true });
// ev_promos: discount codes (all events, or one)
const promoSchema = new Schema(
  {
    ...owned,
    code: { type: String, required: true, maxlength: 24 }, // upper case
    kind: { type: String, enum: ["percent", "amount"], default: "percent" },
    value: { type: Number, default: 10, min: 0, max: 100000 },
    max_uses: { type: Number, default: 0, min: 0 }, // 0 = no limit
    used: { type: Number, default: 0, min: 0 },
    event_id: { type: ObjectId, default: null }, // null = every event
    types: { type: [String], default: [] }, // only these ticket types (empty = all)
    min_qty: { type: Number, default: 1, min: 1, max: 50 },
    ends_at: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  opts,
);
promoSchema.index({ business_id: 1, code: 1 }, { unique: true });

// ev_waitlist: people waiting for a sold-out event (told on Telegram when tickets come back)
const waitSchema = new Schema(
  {
    ...owned,
    event_id: { type: ObjectId, required: true, index: true },
    type_key: { type: String, default: "" }, // "" = any type
    show: { type: String, default: "" },
    name: { type: String, maxlength: 80 },
    phone: { type: String, maxlength: 20 },
    qty: { type: Number, default: 1, min: 1, max: 10 },
    token: { type: String, required: true, unique: true },
    tg: { code: { type: String, default: "", index: true }, chat_id: { type: String, default: "" } },
    status: { type: String, enum: ["waiting", "told", "bought", "left"], default: "waiting", index: true },
    told_at: { type: Date, default: null },
  },
  opts,
);
waitSchema.index({ event_id: 1, phone: 1 });
// ev_referrals: promoters / influencers with their own link
const refSchema = new Schema(
  {
    ...owned,
    code: { type: String, required: true, maxlength: 24 },
    name: { type: String, maxlength: 60 },
    phone: { type: String, default: "", maxlength: 20 },
    event_id: { type: ObjectId, default: null }, // null = any event
    commission: { kind: { type: String, enum: ["percent", "amount"], default: "percent" }, value: { type: Number, default: 10, min: 0, max: 100000 } }, // per order (%) or per ticket ($)
    clicks: { type: Number, default: 0 },
    paid_out: { type: Number, default: 0 }, // commission already paid to them
    active: { type: Boolean, default: true },
  },
  opts,
);
refSchema.index({ business_id: 1, code: 1 }, { unique: true });
// ev_feedback: one answer per order
const feedbackSchema = new Schema(
  {
    ...owned,
    event_id: { type: ObjectId, required: true, index: true },
    order_id: { type: ObjectId, required: true, unique: true },
    name: { type: String, default: "" },
    rating: { type: Number, min: 1, max: 5 },
    answer: { type: String, default: "", maxlength: 500 }, // the organiser's own question
    comment: { type: String, default: "", maxlength: 1000 },
  },
  opts,
);

module.exports = {
  EvWait: mongoose.model("EvWait", waitSchema),
  EvRef: mongoose.model("EvRef", refSchema),
  EvFeedback: mongoose.model("EvFeedback", feedbackSchema),
  EvSettings: mongoose.model("EvSettings", settingsSchema),
  EvEvent: mongoose.model("EvEvent", eventSchema),
  EvOrder: mongoose.model("EvOrder", orderSchema),
  EvTicket: mongoose.model("EvTicket", ticketSchema),
  EvMember: mongoose.model("EvMember", memberSchema),
  EvDevice: mongoose.model("EvDevice", deviceSchema),
  EvStock: mongoose.model("EvStock", stockSchema),
  EvSeat: mongoose.model("EvSeat", seatSchema),
  EvPromo: mongoose.model("EvPromo", promoSchema),
};
