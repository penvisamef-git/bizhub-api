// Attendance (business type "attendance"): branches with a GPS circle, shifts, staff who clock in
// on their own phone (phone + PIN, locked to one phone), and the clock-in / clock-out records.
// A day's status (on time, late, absent…) is worked out from the records + the shift when asked
// (attendance.calc.js), so changing a rule changes every report at once.
const mongoose = require("mongoose");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };
const owned = { business_id: { type: ObjectId, ref: "Business", required: true, index: true } };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_OR_EMPTY = /^(([01]\d|2[0-3]):[0-5]\d)?$/;

const ROLES = ["staff", "manager"];
const PUNCH_KINDS = ["in", "out"];
const PUNCH_SOURCES = ["phone", "manual", "auto"];
const REVIEW = ["ok", "pending", "rejected"]; // pending = a check failed, a manager decides
const FLAGS = ["outside", "no_gps", "low_accuracy", "no_branch", "no_photo", "gps_jump", "gps_same", "gps_zero"]; // why a record needs review
const LEAVE_TYPES = ["annual", "sick", "personal", "unpaid"]; // unpaid comes off the pay
const PAID_LEAVE = ["annual", "sick", "personal"];
const LEAVE_STATUS = ["pending", "approved", "rejected", "cancelled"];
const ATT_ADDONS = ["att_telegram", "att_leave", "att_selfie", "att_kiosk", "att_payroll", "att_website", "att_roster", "att_khpay", "att_manager", "att_docs", "att_news", "att_rewards", "att_gps_guard"];
const PAY_TYPES = ["monthly", "daily", "hourly"]; // salary = per month / per day worked / per hour worked
const STAFF_PACK = 5; // one att_staff slot = 5 more staff
// looks: the first of each list is free, the others are bought one by one (forever)
// staff app: each look is its own layout; the colour is picked apart (free, like the name card)
const APP_THEMES = ["classic", "hero", "badge", "split", "minimal", "ring", "timeline", "glass", "bold", "digital", "ticket", "angkor"];
const COLOR_RE = /^#[0-9A-F]{6}$/;
// door kiosk (tablet) looks: 23 layouts, classic free (att_kiosk_theme, 85 per look per year)
const KIOSK_THEMES = ["classic", "reverse", "center", "hero", "dark", "minimal", "bold", "card", "ring", "gradient", "sidebar", "ticker", "poster", "welcome", "stats", "bento", "digital", "paper", "angkor", "gold", "pastel", "diagonal", "frame"];
const QR_THEMES = ["classic", "minimal", "block", "gradient", "dark", "gold", "angkor", "kraft", "ticket", "badge", "photo", "neon"];

// one per attendance business
const settingsSchema = new Schema(
  {
    ...owned,
    code: { type: String, required: true, unique: true }, // staff link: /a/<code>
    rules: {
      late_grace_min: { type: Number, default: 10, min: 0, max: 120 }, // late after start + this
      early_grace_min: { type: Number, default: 0, min: 0, max: 120 }, // "left early" only below end − this
      ot_after_min: { type: Number, default: 30, min: 0, max: 240 }, // overtime counts after end + this
      max_accuracy_m: { type: Number, default: 100, min: 10, max: 1000 }, // GPS worse than this → needs review
      auto_out_hours: { type: Number, default: 4, min: 1, max: 12 }, // no clock-out by shift end + this → closed at shift end, "forgot to clock out"
    },
    holiday_years: { type: [Number], default: [] }, // years whose Cambodia public holidays were added already
    logo: { url: { type: String, default: "" }, public_id: { type: String, default: "" } }, // company logo (staff app + QR sticker)
    app_theme: { type: String, enum: APP_THEMES, default: "classic" }, // staff phone app look (att_app_theme)
    app_color: { type: String, default: "#4F46E5", match: COLOR_RE }, // its main colour (free to change)
    kiosk_theme: { type: String, enum: KIOSK_THEMES, default: "classic" }, // door kiosk look (att_kiosk_theme)
    kiosk_color: { type: String, default: "#0F766E", match: COLOR_RE }, // its colour (free to change)
    qr_theme: { type: String, enum: QR_THEMES, default: "classic" }, // printed staff QR sticker (att_qr_theme)
    qr_note: { type: String, default: "", trim: true, maxlength: 80 }, // a line on the sticker, e.g. "Clock in before 8:00"
    // Telegram add-on (att_telegram)
    telegram: {
      chat_id: { type: String, default: "" },
      chat_name: { type: String, default: "" },
      chat_type: { type: String, default: "" },
      connected_at: { type: Date, default: null },
      link_code: { type: String, default: "" },
      link_expires: { type: Date, default: null },
      daily_report: { type: Boolean, default: true },
      report_time: { type: String, default: "18:00", match: HHMM }, // Cambodia time
      late_alert: { type: Boolean, default: true }, // message when someone clocks in late
      review_alert: { type: Boolean, default: true }, // message when a record needs review
      leave_alert: { type: Boolean, default: true }, // message when someone asks for leave
      out_alert: { type: Boolean, default: true }, // message when someone is still clocked in after the shift
      fix_alert: { type: Boolean, default: true }, // message when someone asks to fix a record
      out_alerted: { day: { type: String, default: "" }, ids: { type: [String], default: [] } }, // who got the "still clocked in" message today
      last_report_at: { type: Date, default: null },
      monthly: { type: Boolean, default: true }, // a summary of last month on the 1st
      last_month: { type: String, default: "" }, // "YYYY-MM" already sent
    },
    // on-time rewards (att_rewards): badges + streaks in the staff app, an optional bonus for a perfect month
    rewards: {
      bonus: { type: Number, default: 0, min: 0, max: 100000000 }, // added to payroll for a perfect month (0 = none)
      board: { type: Boolean, default: true }, // staff see the team's top 5
    },
    selfie: { required: { type: Boolean, default: true } }, // att_selfie: photo needed at every clock in / out
    leave: { annual_days: { type: Number, default: 18, min: 0, max: 60 } }, // att_leave: annual leave per year
    payroll: {
      currency: { type: String, enum: ["USD", "KHR"], default: "USD" },
      ot_rate: { type: Number, default: 1.5, min: 1, max: 5 }, // overtime pays hourly × this
      deduct_late: { type: Boolean, default: true },
      deduct_absent: { type: Boolean, default: true },
      pay_extra_days: { type: Boolean, default: true }, // a day worked on a day off pays one day
      holiday_rate: { type: Number, default: 2, min: 1, max: 5 }, // a day worked on a public holiday pays a day × this
      ot_approval: { type: Boolean, default: false }, // only approved overtime is paid
      // Cambodia payroll (att_khpay): which lines + the rates (they change by law)
      kh: {
        tax: { type: Boolean, default: true },
        nssf: { type: Boolean, default: true },
        seniority: { type: Boolean, default: true },
        khr_rate: { type: Number, default: 4100, min: 1000, max: 10000 }, // KHR per USD for tax
        pension_ee: { type: Number, default: 2, min: 0, max: 20 },
        pension_er: { type: Number, default: 2, min: 0, max: 20 },
        risk_er: { type: Number, default: 0.8, min: 0, max: 20 },
        health_er: { type: Number, default: 2.6, min: 0, max: 20 },
        nssf_min: { type: Number, default: 400000, min: 0, max: 100000000 },
        nssf_max: { type: Number, default: 1200000, min: 0, max: 100000000 },
      },
      show_staff: { type: Boolean, default: true }, // staff see their own pay on their phone ("My pay")
    },
  },
  opts,
);

const branchSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    address: { type: String, default: "", trim: true, maxlength: 200 },
    lat: { type: Number, default: null, min: -90, max: 90 },
    lng: { type: Number, default: null, min: -180, max: 180 },
    radius_m: { type: Number, default: 100, min: 20, max: 2000 },
    kiosk_token: { type: String, default: "" }, // door kiosk link /k/<token> (att_kiosk)
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);

const shiftSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 60 },
    start: { type: String, required: true, match: HHMM }, // "08:00"
    end: { type: String, required: true, match: HHMM }, // "17:00"; earlier than start = ends the next day (night shift)
    break_min: { type: Number, default: 60, min: 0, max: 480 },
    days: { type: [Number], default: () => [1, 2, 3, 4, 5, 6] }, // 0 = Sunday … 6 = Saturday
    // when staff may press (empty = any time): clock in between in_from–in_to, clock out between out_from–out_to
    in_from: { type: String, default: "", match: HHMM_OR_EMPTY },
    in_to: { type: String, default: "", match: HHMM_OR_EMPTY },
    out_from: { type: String, default: "", match: HHMM_OR_EMPTY },
    out_to: { type: String, default: "", match: HHMM_OR_EMPTY },
    color: { type: String, default: "#2563EB" },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  opts,
);

const staffSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true }, // "+85512345678" — the login
    pin_key: { type: String, default: "" }, // HMAC of the 4-digit PIN (never stored plain)
    role: { type: String, enum: ROLES, default: "staff" },
    position: { type: String, default: "", trim: true, maxlength: 60 },
    branch_ids: { type: [ObjectId], default: [] }, // where they may clock in (one staff, many branches)
    shift_id: { type: ObjectId, default: null },
    active: { type: Boolean, default: true },
    // the one phone this staff may use (first login binds it; the owner can reset it)
    device_id: { type: String, default: "" },
    device_label: { type: String, default: "" },
    device_at: { type: Date, default: null },
    last_seen: { type: Date, default: null },
    token_v: { type: Number, default: 0 }, // +1 on new PIN / phone reset / removed → old logins stop working
    salary: { type: Number, default: 0, min: 0, max: 1000000000 }, // pay rate (payroll add-on), in the payroll currency
    pay_type: { type: String, enum: PAY_TYPES, default: "monthly" }, // salary is per month / per day / per hour
    // Cambodia payroll (att_khpay) + bank transfer list
    dependents: { type: Number, default: 0, min: 0, max: 10 }, // dependent spouse / children (tax allowance)
    resident: { type: Boolean, default: true }, // non-residents: 20% flat tax
    contract: { type: String, enum: ["udc", "fdc"], default: "udc" }, // UDC gets seniority indemnity
    bank_name: { type: String, default: "", trim: true, maxlength: 40 },
    bank_account: { type: String, default: "", trim: true, maxlength: 40 },
    account_name: { type: String, default: "", trim: true, maxlength: 80 },
    // profile (free): dates are "YYYY-MM-DD" or ""
    start_date: { type: String, default: "" },
    birthday: { type: String, default: "" },
    contract_end: { type: String, default: "" },
    id_number: { type: String, default: "", trim: true, maxlength: 40 },
    address: { type: String, default: "", trim: true, maxlength: 200 },
    emergency_name: { type: String, default: "", trim: true, maxlength: 80 },
    emergency_phone: { type: String, default: "", trim: true, maxlength: 30 },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
    sort: { type: Number, default: 0 },
  },
  opts,
);
staffSchema.index({ business_id: 1, phone: 1 }, { unique: true });

const punchSchema = new Schema(
  {
    ...owned,
    staff_id: { type: ObjectId, required: true },
    kind: { type: String, enum: PUNCH_KINDS, required: true },
    at: { type: Date, required: true }, // server time
    day: { type: String, required: true }, // "YYYY-MM-DD" (Cambodia) the work day it belongs to
    branch_id: { type: ObjectId, default: null },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    accuracy: { type: Number, default: null }, // metres, from the phone
    distance_m: { type: Number, default: null }, // to the nearest allowed branch
    flags: { type: [String], enum: FLAGS, default: [] },
    review: { type: String, enum: REVIEW, default: "ok" },
    source: { type: String, enum: PUNCH_SOURCES, default: "phone" },
    photo: { url: { type: String, default: "" }, public_id: { type: String, default: "" } }, // selfie (deleted after 60 days)
    kiosk: { type: Boolean, default: false }, // clocked by scanning the door kiosk QR
    note: { type: String, default: "", maxlength: 300 }, // reason for a manual record / a decision
    by: { type: String, default: "" }, // who added / decided (owner name)
    decided_at: { type: Date, default: null },
  },
  opts,
);
punchSchema.index({ business_id: 1, day: 1 });
punchSchema.index({ business_id: 1, staff_id: 1, at: -1 });
punchSchema.index({ business_id: 1, review: 1 });
punchSchema.index({ "photo.public_id": 1, at: 1 });

// leave request (att_leave): whole days from → to
const leaveSchema = new Schema(
  {
    ...owned,
    staff_id: { type: ObjectId, required: true },
    type: { type: String, enum: LEAVE_TYPES, default: "annual" },
    from: { type: String, required: true }, // "YYYY-MM-DD"
    to: { type: String, required: true },
    days: { type: Number, default: 1 }, // work days inside from → to (filled when saved)
    reason: { type: String, default: "", trim: true, maxlength: 300 },
    status: { type: String, enum: LEAVE_STATUS, default: "pending" },
    by: { type: String, default: "" }, // "staff" or the owner's name
    decided_by: { type: String, default: "" }, // who approved / rejected (owner or "<name> (manager)")
    note: { type: String, default: "", maxlength: 300 }, // owner's answer
    decided_at: { type: Date, default: null },
  },
  opts,
);
leaveSchema.index({ business_id: 1, status: 1 });
leaveSchema.index({ business_id: 1, staff_id: 1, from: 1 });

// a bonus (+) or deduction (−) line on one staff's month (att_payroll)
const payAdjustSchema = new Schema(
  {
    ...owned,
    staff_id: { type: ObjectId, required: true },
    month: { type: String, required: true }, // "YYYY-MM"
    label: { type: String, required: true, trim: true, maxlength: 60 },
    amount: { type: Number, required: true, min: -1000000000, max: 1000000000 },
  },
  opts,
);
payAdjustSchema.index({ business_id: 1, month: 1 });

// "I'll stay until 19:00": overtime asked before (payroll.ot_approval → only approved overtime is paid)
const overtimeSchema = new Schema(
  {
    ...owned,
    staff_id: { type: ObjectId, required: true },
    day: { type: String, required: true },
    until: { type: String, required: true, match: HHMM },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending" },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    by: { type: String, default: "" },
    decided_at: { type: Date, default: null },
  },
  opts,
);
overtimeSchema.index({ business_id: 1, status: 1 });
overtimeSchema.index({ business_id: 1, staff_id: 1, day: 1 });

// weekly roster (att_roster): who works which shift on a day; shift_id null = day off. No entry = their usual shift
const rosterSchema = new Schema(
  {
    ...owned,
    staff_id: { type: ObjectId, required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    shift_id: { type: ObjectId, default: null },
  },
  opts,
);
rosterSchema.index({ business_id: 1, day: 1 });
rosterSchema.index({ business_id: 1, staff_id: 1, day: 1 }, { unique: true });

// a public / company holiday: not a work day, nobody is absent, working on it pays holiday_rate
const holidaySchema = new Schema(
  {
    ...owned,
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    preset: { type: Boolean, default: false }, // from the Cambodia list
    hidden: { type: Boolean, default: false }, // a Cambodia day the owner removed (kept so a list update doesn't bring it back)
  },
  opts,
);
holidaySchema.index({ business_id: 1, day: 1 }, { unique: true });

// Cambodia's national holiday list of one year, kept by the super admin (official = from the sub-decree)
const holidayYearSchema = new Schema(
  {
    year: { type: Number, required: true, unique: true, min: 2020, max: 2100 },
    days: { type: [new Schema({ day: { type: String, required: true }, name: { type: String, required: true, trim: true, maxlength: 80 }, km: { type: String, default: "", trim: true, maxlength: 120 } }, { _id: false })], default: [] },
    official: { type: Boolean, default: false },
    updated_by: { type: String, default: "" },
  },
  opts,
);

// "I forgot to clock in / out": a staff asks, the owner approves → a record is added
const FIX_STATUS = ["pending", "approved", "rejected", "cancelled"];
const fixSchema = new Schema(
  {
    ...owned,
    staff_id: { type: ObjectId, required: true },
    day: { type: String, required: true },
    kind: { type: String, enum: PUNCH_KINDS, required: true },
    time: { type: String, required: true, match: HHMM },
    at: { type: Date, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    status: { type: String, enum: FIX_STATUS, default: "pending" },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    by: { type: String, default: "" },
    decided_at: { type: Date, default: null },
    punch_id: { type: ObjectId, default: null },
  },
  opts,
);
fixSchema.index({ business_id: 1, status: 1 });
fixSchema.index({ business_id: 1, staff_id: 1, created_date: -1 });

// ---------- company website (att_website, yearly): public at /w/<slug> ----------
// 24 looks: classic free, the others bought one by one (att_web_theme, item = theme, forever)
const WEB_THEMES = [
  "classic",
  "corporate",
  "startup",
  "minimal",
  "bold",
  "elegant",
  "tech",
  "nature",
  "ocean",
  "sunset",
  "mono",
  "studio",
  "agency",
  "consult",
  "warm",
  "angkor",
  "neon",
  "paper",
  "pastel",
  "luxe",
  "brutal",
  "soft",
  "magazine",
  "skyline",
];
const WEB_PARTS = ["home", "about", "services", "gallery", "message", "contact"]; // built-in parts of the home page
const WEB_ICONS = [
  "briefcase",
  "users",
  "truck",
  "wrench",
  "code",
  "chart",
  "shield",
  "heart",
  "home",
  "leaf",
  "camera",
  "megaphone",
  "graduation",
  "scale",
  "stethoscope",
  "car",
  "plane",
  "shopping",
  "palette",
  "coffee",
  "hammer",
  "zap",
  "globe",
  "star",
];
const WEB_MESSAGE_KINDS = ["question", "quote", "booking", "other"];
const WEB_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const img = () => ({ type: new Schema({ url: { type: String, default: "" }, public_id: { type: String, default: "" } }, { _id: false }), default: () => ({}) });
const s = (max) => ({ type: String, default: "", trim: true, maxlength: max });
const webSiteSchema = new Schema(
  {
    business_id: { type: ObjectId, ref: "Business", required: true }, // unique index below
    slug: { type: String, trim: true, lowercase: true, maxlength: 40 },
    published: { type: Boolean, default: false },
    theme: { type: String, enum: WEB_THEMES, default: "classic" },
    color: { type: String, default: "", match: /^(#[0-9A-F]{6})?$/ }, // "" = the look's own colour
    hero: { kicker: s(60), title: s(90), subtitle: s(240), button: s(30), button_to: s(300), image: img() },
    about: {
      enabled: { type: Boolean, default: true },
      title: s(70),
      text: s(2000),
      image: img(),
      highlights: { type: [new Schema({ value: s(20), label: s(40) }, { _id: false })], default: [] },
    },
    services: {
      enabled: { type: Boolean, default: true },
      title: s(70),
      subtitle: s(200),
      items: {
        type: [
          new Schema({
            icon: { type: String, enum: WEB_ICONS, default: "briefcase" },
            title: s(70),
            text: s(400),
            price: s(30), // free text: "$50", "From $120 / month"
            image: img(),
            page_id: { type: String, default: "" }, // "Learn more" → one of the pages
          }),
        ],
        default: [],
      },
    },
    gallery: { enabled: { type: Boolean, default: true }, title: s(70), images: { type: [new Schema({ url: String, public_id: String }, { _id: false })], default: [] } },
    // the owner's own pages: /w/<slug>/<page slug>
    pages: {
      type: [
        new Schema({
          slug: { type: String, trim: true, lowercase: true, maxlength: 40 },
          title: s(70),
          subtitle: s(200),
          body: s(6000), // blank line = new paragraph, "## " = heading, "- " = list
          image: img(),
          button: s(30),
          button_to: s(300),
        }),
      ],
      default: [],
    },
    // top menu: built-in parts, pages and outside links, in the owner's order
    nav: {
      type: [
        new Schema(
          {
            kind: { type: String, enum: ["part", "page", "link"], required: true },
            key: { type: String, default: "" }, // part key, or page _id
            label: s(30),
            url: s(300),
            show: { type: Boolean, default: true },
          },
          { _id: false },
        ),
      ],
      default: () => WEB_PARTS.map((key) => ({ kind: "part", key, label: "", url: "", show: true })),
    },
    form: { enabled: { type: Boolean, default: true }, title: s(70), text: s(200), notify_telegram: { type: Boolean, default: true } },
    contact: {
      enabled: { type: Boolean, default: true },
      title: s(70),
      phone: s(30),
      email: s(80),
      address: s(200),
      hours: s(120),
      map_url: s(300),
      facebook: s(300),
      instagram: s(300),
      tiktok: s(300),
      telegram: s(300),
      linkedin: s(300),
      youtube: s(300),
    },
    footer_note: s(200),
    seo: { title: s(70), description: s(160) },
  },
  opts,
);
webSiteSchema.index({ business_id: 1 }, { unique: true });
webSiteSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string", $gt: "" } } });

// messages from the website's form
const webMessageSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    contact: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: WEB_MESSAGE_KINDS, default: "question" },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    read: { type: Boolean, default: false },
    ip_key: { type: String, default: "" },
  },
  opts,
);
webMessageSchema.index({ business_id: 1, created_date: -1 });

// announcement (att_news): the owner posts, staff read it in their app
const newsSchema = new Schema(
  {
    ...owned,
    title: { type: String, required: true, trim: true, maxlength: 100 },
    body: { type: String, default: "", trim: true, maxlength: 2000 },
    pinned: { type: Boolean, default: false },
    branch_ids: { type: [ObjectId], default: [] }, // empty = everyone
    by: { type: String, default: "" },
    reads: { type: [{ staff_id: ObjectId, at: Date, _id: false }], default: [] },
  },
  opts,
);
newsSchema.index({ business_id: 1, created_date: -1 });

// staff document (att_docs): a photo of a contract / ID card / certificate, with an optional end date
const DOC_KINDS = ["contract", "id_card", "certificate", "other"];
const docSchema = new Schema(
  {
    ...owned,
    staff_id: { type: ObjectId, required: true },
    kind: { type: String, enum: DOC_KINDS, default: "other" },
    name: { type: String, default: "", trim: true, maxlength: 80 },
    url: { type: String, required: true },
    public_id: { type: String, default: "" },
    expires: { type: String, default: "" }, // "YYYY-MM-DD" or ""
    by: { type: String, default: "" },
  },
  opts,
);
docSchema.index({ business_id: 1, staff_id: 1 });

module.exports = {
  DOC_KINDS,
  AttNews: mongoose.model("AttNews", newsSchema),
  AttDoc: mongoose.model("AttDoc", docSchema),
  AttHoliday: mongoose.model("AttHoliday", holidaySchema),
  AttRoster: mongoose.model("AttRoster", rosterSchema),
  AttOvertime: mongoose.model("AttOvertime", overtimeSchema),
  PAY_TYPES,
  AttHolidayYear: mongoose.model("AttHolidayYear", holidayYearSchema),
  AttFix: mongoose.model("AttFix", fixSchema),
  FIX_STATUS,
  AttSite: mongoose.model("AttSite", webSiteSchema),
  AttSiteMessage: mongoose.model("AttSiteMessage", webMessageSchema),
  WEB_THEMES,
  WEB_PARTS,
  WEB_ICONS,
  WEB_MESSAGE_KINDS,
  WEB_SLUG_RE,
  PAGE_SLUG_RE,
  AttSettings: mongoose.model("AttSettings", settingsSchema),
  AttBranch: mongoose.model("AttBranch", branchSchema),
  AttShift: mongoose.model("AttShift", shiftSchema),
  AttStaff: mongoose.model("AttStaff", staffSchema),
  AttPunch: mongoose.model("AttPunch", punchSchema),
  AttLeave: mongoose.model("AttLeave", leaveSchema),
  AttPayAdjust: mongoose.model("AttPayAdjust", payAdjustSchema),
  LEAVE_TYPES,
  PAID_LEAVE,
  LEAVE_STATUS,
  ATT_ADDONS,
  STAFF_PACK,
  HHMM,
  ROLES,
  FLAGS,
  APP_THEMES,
  KIOSK_THEMES,
  COLOR_RE,
  QR_THEMES,
};
