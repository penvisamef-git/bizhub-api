const mongoose = require("mongoose");
const { DEFAULT_HOMEPAGE, SERVICE_KEYS } = require("./homepage.defaults");

const d = DEFAULT_HOMEPAGE;

const serviceSchema = new mongoose.Schema(
  {
    key: { type: String, enum: SERVICE_KEYS, required: true },
    enabled: { type: Boolean, default: true },
    coming_soon: { type: Boolean, default: false },
    sort_order: { type: Number, default: 0 },
  },
  { _id: false },
);

// a group of services: "Online & QR" → [namecard, website, …] (order = order on the page)
const groupSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    en: { type: String, default: "" },
    km: { type: String, default: "" },
    types: { type: [{ type: String, enum: SERVICE_KEYS }], default: [] },
  },
  { _id: false },
);

// Only ONE document (key = "main"): everything shown on the public website.
const homepageSchema = new mongoose.Schema(
  {
    key: { type: String, default: "main", unique: true },

    contact: {
      phones: { type: [String], default: () => [...d.contact.phones] },
      telegram: { type: String, default: d.contact.telegram },
      telegram_url: { type: String, default: d.contact.telegram_url },
      email: { type: String, default: d.contact.email },
      address: { type: String, default: d.contact.address },
      facebook_url: { type: String, default: d.contact.facebook_url },
      map_url: { type: String, default: d.contact.map_url },
    },

    // e.g. 100 coins = $10, 200 free coins at sign-up
    coin: {
      pack_coins: { type: Number, default: d.coin.pack_coins, min: 1 },
      pack_price_usd: { type: Number, default: d.coin.pack_price_usd, min: 0 },
      signup_bonus: { type: Number, default: d.coin.signup_bonus, min: 0 },
    },

    // coins to add one business of each type: { namecard: 5 (one time), restaurant: 100 (per year) }
    prices: {
      namecard: { type: Number, default: d.prices.namecard, min: 0 },
      restaurant: { type: Number, default: d.prices.restaurant, min: 0 },
      premium_theme: { type: Number, default: d.prices.premium_theme, min: 0 },
      portfolio_year: { type: Number, default: d.prices.portfolio_year, min: 0 },
      portfolio_theme: { type: Number, default: d.prices.portfolio_theme, min: 0 },
      rest_kitchen: { type: Number, default: d.prices.rest_kitchen, min: 0 },
      rest_history: { type: Number, default: d.prices.rest_history, min: 0 },
      rest_payments: { type: Number, default: d.prices.rest_payments, min: 0 },
      rest_staff: { type: Number, default: d.prices.rest_staff, min: 0 },
      rest_stock: { type: Number, default: d.prices.rest_stock, min: 0 },
      rest_qr_menu: { type: Number, default: d.prices.rest_qr_menu, min: 0 },
      rest_printer: { type: Number, default: d.prices.rest_printer, min: 0 },
      rest_telegram: { type: Number, default: d.prices.rest_telegram, min: 0 },
      rest_website: { type: Number, default: d.prices.rest_website, min: 0 },
      rest_site_theme: { type: Number, default: d.prices.rest_site_theme, min: 0 },
      rest_app: { type: Number, default: d.prices.rest_app, min: 0 },
      rest_receipt_theme: { type: Number, default: d.prices.rest_receipt_theme, min: 0 },
      rest_pos_theme: { type: Number, default: d.prices.rest_pos_theme, min: 0 },
      rest_display: { type: Number, default: d.prices.rest_display, min: 0 },
      rest_display_theme: { type: Number, default: d.prices.rest_display_theme, min: 0 },
      rest_promos: { type: Number, default: d.prices.rest_promos, min: 0 },
      rest_table_order: { type: Number, default: d.prices.rest_table_order, min: 0 },
      rest_qr_theme: { type: Number, default: d.prices.rest_qr_theme, min: 0 },
      rest_order_theme: { type: Number, default: d.prices.rest_order_theme, min: 0 },
      rest_rewards: { type: Number, default: d.prices.rest_rewards, min: 0 },
      rest_branches: { type: Number, default: d.prices.rest_branches, min: 0 }, // several restaurants, yearly
      rest_points_theme: { type: Number, default: d.prices.rest_points_theme, min: 0 },
      attendance: { type: Number, default: d.prices.attendance, min: 0 }, // attendance business, per year (5 staff, 1 branch)
      att_branch: { type: Number, default: d.prices.att_branch, min: 0 }, // one more attendance branch, per year
      att_app_theme: { type: Number, default: d.prices.att_app_theme, min: 0 }, // one staff-app look, forever
      att_qr_theme: { type: Number, default: d.prices.att_qr_theme, min: 0 }, // one staff QR sticker style, forever
      att_staff: { type: Number, default: d.prices.att_staff, min: 0 }, // +5 attendance staff, per year
      att_telegram: { type: Number, default: d.prices.att_telegram, min: 0 }, // attendance report on Telegram, per year
      att_leave: { type: Number, default: d.prices.att_leave, min: 0 }, // leave requests, per year
      att_selfie: { type: Number, default: d.prices.att_selfie, min: 0 }, // selfie at clock in, per year
      att_kiosk: { type: Number, default: d.prices.att_kiosk, min: 0 }, // door QR kiosk, per year
      att_payroll: { type: Number, default: d.prices.att_payroll, min: 0 }, // payroll, per year
      att_kiosk_theme: { type: Number, default: d.prices.att_kiosk_theme, min: 0 }, // one door-kiosk look, yearly
      att_app: { type: Number, default: d.prices.att_app, min: 0 }, // BizHub app for attendance (coming soon), yearly
      att_website: { type: Number, default: d.prices.att_website, min: 0 }, // company website, yearly
      att_web_theme: { type: Number, default: d.prices.att_web_theme, min: 0 }, // one website look, forever
      att_khpay: { type: Number, default: d.prices.att_khpay, min: 0 }, // Cambodia payroll, yearly
      att_manager: { type: Number, default: d.prices.att_manager, min: 0 }, // Manager login, yearly
      att_docs: { type: Number, default: d.prices.att_docs, min: 0 }, // Staff documents, yearly
      att_news: { type: Number, default: d.prices.att_news, min: 0 }, // Announcements, yearly
      att_rewards: { type: Number, default: d.prices.att_rewards, min: 0 }, // On-time rewards, yearly
      att_gps_guard: { type: Number, default: d.prices.att_gps_guard, min: 0 }, // Fake GPS check, yearly
      guest_house: { type: Number, default: d.prices.guest_house, min: 0 }, // Guest House, yearly
      // Menu QR (yearly) + add-ons
      menu_qr: { type: Number, default: d.prices.menu_qr, min: 0 },
      mq_categories: { type: Number, default: d.prices.mq_categories, min: 0 },
      mq_items: { type: Number, default: d.prices.mq_items, min: 0 },
      mq_promos: { type: Number, default: d.prices.mq_promos, min: 0 },
      mq_feedback: { type: Number, default: d.prices.mq_feedback, min: 0 },
      mq_stats: { type: Number, default: d.prices.mq_stats, min: 0 },
      mq_theme: { type: Number, default: d.prices.mq_theme, min: 0 },
      mq_theme_pro: { type: Number, default: d.prices.mq_theme_pro, min: 0 },
      mq_qr_style: { type: Number, default: d.prices.mq_qr_style, min: 0 },
      mq_media_slot: { type: Number, default: d.prices.mq_media_slot, min: 0 }, // one more picture in the media library (35 free)
      // Flip Book (once) + add-ons
      flipbook: { type: Number, default: d.prices.flipbook, min: 0 },
      qr_gen: { type: Number, default: d.prices.qr_gen, min: 0 }, // QR Code Generator, once
      qr_forms: { type: Number, default: d.prices.qr_forms, min: 0 },
      qr_telegram: { type: Number, default: d.prices.qr_telegram, min: 0 },
      qr_stats: { type: Number, default: d.prices.qr_stats, min: 0 },
      qr_geo: { type: Number, default: d.prices.qr_geo, min: 0 },
      qr_bulk: { type: Number, default: d.prices.qr_bulk, min: 0 },
      qr_rules: { type: Number, default: d.prices.qr_rules, min: 0 },
      qr_design: { type: Number, default: d.prices.qr_design, min: 0 },
      qr_theme: { type: Number, default: d.prices.qr_theme, min: 0 },
      qr_links: { type: Number, default: d.prices.qr_links, min: 0 },
      qr_coupons: { type: Number, default: d.prices.qr_coupons, min: 0 },
      qr_nobrand: { type: Number, default: d.prices.qr_nobrand, min: 0 },
      qr_form_pro: { type: Number, default: d.prices.qr_form_pro, min: 0 },
      qr_smart: { type: Number, default: d.prices.qr_smart, min: 0 },
      qr_slug: { type: Number, default: d.prices.qr_slug, min: 0 },
      qr_print: { type: Number, default: d.prices.qr_print, min: 0 },
      qr_file_pack: { type: Number, default: d.prices.qr_file_pack, min: 0 }, // +10 files
      website: { type: Number, default: d.prices.website, min: 0 }, // Website Builder, yearly
      web_telegram: { type: Number, default: d.prices.web_telegram, min: 0 },
      web_brand: { type: Number, default: d.prices.web_brand, min: 0 },
      web_pages: { type: Number, default: d.prices.web_pages, min: 0 },
      web_blog: { type: Number, default: d.prices.web_blog, min: 0 },
      web_nobrand: { type: Number, default: d.prices.web_nobrand, min: 0 },
      web_slug: { type: Number, default: d.prices.web_slug, min: 0 },
      web_stats: { type: Number, default: d.prices.web_stats, min: 0 }, // Visits Pro, yearly
      web_theme: { type: Number, default: d.prices.web_theme, min: 0 }, // one paid look, forever
      debt_book: { type: Number, default: d.prices.debt_book, min: 0 }, // Debt Book, yearly
      debt_remind: { type: Number, default: d.prices.debt_remind, min: 0 }, // auto reminders, yearly
      debt_more: { type: Number, default: d.prices.debt_more, min: 0 },
      debt_excel: { type: Number, default: d.prices.debt_excel, min: 0 },
      debt_nobrand: { type: Number, default: d.prices.debt_nobrand, min: 0 },
      digital_note: { type: Number, default: d.prices.digital_note, min: 0 }, // Digital Note, yearly
      note_storage: { type: Number, default: d.prices.note_storage, min: 0 }, // +5 GB storage per pack, yearly
      note_group: { type: Number, default: d.prices.note_group, min: 0 }, // one group of notes, forever
      note_sign: { type: Number, default: d.prices.note_sign, min: 0 }, // signature / pen pop-up, forever
      note_style: { type: Number, default: d.prices.note_style, min: 0 }, // style pack, forever
      note_group_icon: { type: Number, default: d.prices.note_group_icon, min: 0 }, // group icon picture, forever (per group)
      note_media: { type: Number, default: d.prices.note_media, min: 0 }, // media manager, forever
      note_theme: { type: Number, default: d.prices.note_theme, min: 0 }, // one public page theme, forever (per theme)
      note_link: { type: Number, default: d.prices.note_link, min: 0 }, // custom links, forever
      note_telegram: { type: Number, default: d.prices.note_telegram, min: 0 }, // Telegram alerts, yearly
      note_ack: { type: Number, default: d.prices.note_ack, min: 0 }, // "I've read it", forever
      note_form: { type: Number, default: d.prices.note_form, min: 0 }, // sign-up fields + Excel, forever
      note_voice: { type: Number, default: d.prices.note_voice, min: 0 }, // voice notes, forever
      note_pdf: { type: Number, default: d.prices.note_pdf, min: 0 }, // PDF export, forever
      stamp_card: { type: Number, default: d.prices.stamp_card, min: 0 }, // Loyalty Stamp Card, yearly
      sc_check: { type: Number, default: d.prices.sc_check, min: 0 }, // customer self-check, yearly
      sc_telegram: { type: Number, default: d.prices.sc_telegram, min: 0 }, // Telegram alerts, yearly
      sc_more: { type: Number, default: d.prices.sc_more, min: 0 },
      sc_levels: { type: Number, default: d.prices.sc_levels, min: 0 },
      sc_expiry: { type: Number, default: d.prices.sc_expiry, min: 0 },
      sc_theme: { type: Number, default: d.prices.sc_theme, min: 0 }, // one premium design, forever
      sc_poster: { type: Number, default: d.prices.sc_poster, min: 0 }, // one shop QR poster, forever
      event: { type: Number, default: d.prices.event, min: 0 }, // Event Tickets, yearly
      ev_doors: { type: Number, default: d.prices.ev_doors, min: 0 }, // more door phones, yearly
      ev_team: { type: Number, default: d.prices.ev_team, min: 0 },
      ev_cashier: { type: Number, default: d.prices.ev_cashier, min: 0 },
      ev_invites: { type: Number, default: d.prices.ev_invites, min: 0 },
      ev_export: { type: Number, default: d.prices.ev_export, min: 0 },
      ev_nobrand: { type: Number, default: d.prices.ev_nobrand, min: 0 },
      ev_theme: { type: Number, default: d.prices.ev_theme, min: 0 }, // one ticket design, forever
      ev_page_theme: { type: Number, default: d.prices.ev_page_theme, min: 0 }, // one event page theme, forever
      ev_cert_theme: { type: Number, default: d.prices.ev_cert_theme, min: 0 }, // one certificate design, forever
      ev_waitlist: { type: Number, default: d.prices.ev_waitlist, min: 0 },
      ev_pricing: { type: Number, default: d.prices.ev_pricing, min: 0 },
      ev_referrals: { type: Number, default: d.prices.ev_referrals, min: 0 },
      ev_bundles: { type: Number, default: d.prices.ev_bundles, min: 0 },
      ev_feedback: { type: Number, default: d.prices.ev_feedback, min: 0 },
      ev_sponsors: { type: Number, default: d.prices.ev_sponsors, min: 0 },
      ev_feature: { type: Number, default: d.prices.ev_feature, min: 0 }, // one event on top of the public events page, 7 days
      ev_telegram: { type: Number, default: d.prices.ev_telegram, min: 0 },
      ev_guest_tg: { type: Number, default: d.prices.ev_guest_tg, min: 0 },
      ev_seats: { type: Number, default: d.prices.ev_seats, min: 0 },
      ev_shows: { type: Number, default: d.prices.ev_shows, min: 0 },
      ev_promos: { type: Number, default: d.prices.ev_promos, min: 0 },
      ev_questions: { type: Number, default: d.prices.ev_questions, min: 0 },
      ev_autopay: { type: Number, default: d.prices.ev_autopay, min: 0 },
      ev_certs: { type: Number, default: d.prices.ev_certs, min: 0 },
      fb_book_slot: { type: Number, default: d.prices.fb_book_slot, min: 0 },
      fb_big_slot: { type: Number, default: d.prices.fb_big_slot, min: 0 },
      fb_categories: { type: Number, default: d.prices.fb_categories, min: 0 },
      fb_stats: { type: Number, default: d.prices.fb_stats, min: 0 },
      fb_password: { type: Number, default: d.prices.fb_password, min: 0 },
      fb_shelf_theme: { type: Number, default: d.prices.fb_shelf_theme, min: 0 },
      fb_reader_theme: { type: Number, default: d.prices.fb_reader_theme, min: 0 },
      fb_leads: { type: Number, default: d.prices.fb_leads, min: 0 }, // contact form, per year
      fb_links: { type: Number, default: d.prices.fb_links, min: 0 }, // clickable pages, forever
      fb_shelf_live: { type: Number, default: d.prices.fb_shelf_live, min: 0 }, // one live library design
      fb_qr_styles: { type: Number, default: d.prices.fb_qr_styles, min: 0 }, // all QR card styles, once
      mart: { type: Number, default: d.prices.mart, min: 0 }, // Mini Mart, yearly
      mart_staff: { type: Number, default: d.prices.mart_staff, min: 0 }, // unlimited cashiers (2 free)
      mart_payments: { type: Number, default: d.prices.mart_payments, min: 0 }, // more than 3 payment methods
      mart_stock: { type: Number, default: d.prices.mart_stock, min: 0 }, // stock control: stock count
      mart_printer: { type: Number, default: d.prices.mart_printer, min: 0 }, // print receipts
      mart_history: { type: Number, default: d.prices.mart_history, min: 0 }, // full report history
      mart_debt: { type: Number, default: d.prices.mart_debt, min: 0 }, // debt book, yearly
      mart_shifts: { type: Number, default: d.prices.mart_shifts, min: 0 }, // shifts & cash drawer, forever
      mart_labels: { type: Number, default: d.prices.mart_labels, min: 0 }, // barcode labels, forever
      mart_suppliers: { type: Number, default: d.prices.mart_suppliers, min: 0 }, // suppliers, forever
      mart_website: { type: Number, default: d.prices.mart_website, min: 0 }, // shop website, yearly
      mart_site_theme: { type: Number, default: d.prices.mart_site_theme, min: 0 }, // website look, forever
      mart_shop: { type: Number, default: d.prices.mart_shop, min: 0 }, // online orders, yearly
      mart_portal_theme: { type: Number, default: d.prices.mart_portal_theme, min: 0 }, // customer dashboard look, forever
      mart_pos_theme: { type: Number, default: d.prices.mart_pos_theme, min: 0 }, // POS look, forever
      mart_telegram: { type: Number, default: d.prices.mart_telegram, min: 0 }, // Telegram alerts, yearly
      mart_expiry: { type: Number, default: d.prices.mart_expiry, min: 0 },
      mart_loyalty: { type: Number, default: d.prices.mart_loyalty, min: 0 },
      mart_promos: { type: Number, default: d.prices.mart_promos, min: 0 },
      mart_profit: { type: Number, default: d.prices.mart_profit, min: 0 },
      mart_purchase: { type: Number, default: d.prices.mart_purchase, min: 0 },
      mart_display: { type: Number, default: d.prices.mart_display, min: 0 },
      mart_scale: { type: Number, default: d.prices.mart_scale, min: 0 },
      mart_delivery: { type: Number, default: d.prices.mart_delivery, min: 0 },
      mart_branches: { type: Number, default: d.prices.mart_branches, min: 0 },
      mart_print_theme: { type: Number, default: d.prices.mart_print_theme, min: 0 }, // one receipt template
      gh_rooms: { type: Number, default: d.prices.gh_rooms, min: 0 }, // unlimited rooms, forever
      gh_types: { type: Number, default: d.prices.gh_types, min: 0 }, // unlimited room types, forever
      gh_payments: { type: Number, default: d.prices.gh_payments, min: 0 }, // more payment methods, forever
      gh_staff: { type: Number, default: d.prices.gh_staff, min: 0 }, // more desk staff, yearly
      gh_display: { type: Number, default: d.prices.gh_display, min: 0 }, // guest display, forever
      gh_display_theme: { type: Number, default: d.prices.gh_display_theme, min: 0 }, // one guest-display look, forever
      gh_printer: { type: Number, default: d.prices.gh_printer, min: 0 }, // printing, forever
      gh_print_theme: { type: Number, default: d.prices.gh_print_theme, min: 0 }, // one receipt template, forever
      gh_website: { type: Number, default: d.prices.gh_website, min: 0 }, // guest house website, yearly
      gh_site_theme: { type: Number, default: d.prices.gh_site_theme, min: 0 }, // one website look, forever
      gh_promos: { type: Number, default: d.prices.gh_promos, min: 0 }, // promotions, forever
      gh_customers: { type: Number, default: d.prices.gh_customers, min: 0 }, // customer accounts, yearly
      gh_portal_theme: { type: Number, default: d.prices.gh_portal_theme, min: 0 }, // one customer-dashboard look, forever
      gh_telegram: { type: Number, default: d.prices.gh_telegram, min: 0 }, // Telegram alerts: new online bookings
      gh_police: { type: Number, default: d.prices.gh_police, min: 0 }, // foreign guest report for the local police
      gh_services: { type: Number, default: d.prices.gh_services, min: 0 }, // extra services menu (laundry
      gh_reviews: { type: Number, default: d.prices.gh_reviews, min: 0 }, // guest reviews: link after check-out
      gh_loyalty: { type: Number, default: d.prices.gh_loyalty, min: 0 }, // loyalty points for customer accounts
      gh_longstay: { type: Number, default: d.prices.gh_longstay, min: 0 }, // long stay / monthly rent: bills
      gh_ical: { type: Number, default: d.prices.gh_ical, min: 0 }, // Booking.com / Agoda / Airbnb calendar sync (iCal)
      gh_housekeeping: { type: Number, default: d.prices.gh_housekeeping, min: 0 }, // housekeeping: dirty → cleaning → ready + housekeeper phones
      gh_expenses: { type: Number, default: d.prices.gh_expenses, min: 0 }, // expenses & profit
      gh_branches: { type: Number, default: d.prices.gh_branches, min: 0 }, // several guest houses, yearly
      att_roster: { type: Number, default: d.prices.att_roster, min: 0 }, // weekly roster, yearly
      att_holidays: { type: Number, default: d.prices.att_holidays, min: 0 }, // one year of Cambodia public holidays
      team_year: { type: Number, default: d.prices.team_year, min: 0 }, // Team access for one business, yearly
    },

    payment_methods: { type: [String], default: () => [...d.payment_methods] },

    app: {
      status: { type: String, enum: ["coming_soon", "live"], default: d.app.status },
      android_url: { type: String, default: "" },
      ios_url: { type: String, default: "" },
    },

    // order + on/off of the service cards on the homepage
    services: { type: [serviceSchema], default: () => d.services.map((s) => ({ ...s })) },
    groups: { type: [groupSchema], default: () => d.groups.map((g) => ({ ...g, types: [...g.types] })) },

    // text overrides by language: { en: { heroSub: "..." }, km: { ... } }
    // keys = text keys of the website (bizhub/src/homepage/content.js); empty = default text
    texts: {
      en: { type: Map, of: String, default: {} },
      km: { type: Map, of: String, default: {} },
    },

    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
  },
  { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } },
);

// anything that caches homepage data (prices.js) is told when it changes
const listeners = [];
const changed = () => listeners.forEach((fn) => fn());
homepageSchema.post("save", changed);
homepageSchema.post(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"], changed);

const Homepage = mongoose.model("Homepage", homepageSchema);
Homepage.onChange = (fn) => listeners.push(fn);
module.exports = Homepage;
