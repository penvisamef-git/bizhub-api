// Default website content. Used the first time (before the super admin saves anything).
// Keep in sync with bizhub/src/homepage/defaults.js

// Services the website knows about (each one has text + icons on the web side)
// homepage service cards (guest = guest_house, attend = attendance); "warehouse" is old — kept so saved settings stay valid
const SERVICE_KEYS = ["namecard", "website", "menu_qr", "flipbook", "qr_gen", "restaurant", "mart", "guest", "tg_store", "attend", "debt_book", "stamp_card", "event", "digital_note", "warehouse"];
const SHOWN_SERVICES = SERVICE_KEYS.filter((k) => k !== "warehouse");

const DEFAULT_HOMEPAGE = {
  contact: {
    phones: ["089 288 105"],
    telegram: "@bizhubcambodia",
    telegram_url: "https://t.me/bizhubcambodia",
    email: "bizhubcambodia@gmail.com",
    address: "",
    facebook_url: "",
    map_url: "",
  },
  coin: { pack_coins: 100, pack_price_usd: 10, signup_bonus: 200 },
  // coins a customer pays to add one business of each type (keys = business types in src/biz)
  // premium_theme = coins to unlock one premium name card theme (per card)
  prices: {
    namecard: 5,
    restaurant: 100,
    premium_theme: 15,
    portfolio_year: 50,
    portfolio_theme: 20,
    rest_kitchen: 25,
    rest_history: 50,
    rest_payments: 25,
    rest_staff: 50,
    rest_stock: 50,
    rest_qr_menu: 40,
    rest_printer: 60,
    rest_telegram: 40,
    rest_website: 100,
    rest_site_theme: 50,
    rest_app: 120,
    rest_receipt_theme: 45,
    rest_pos_theme: 45,
    rest_display: 65,
    rest_display_theme: 75,
    rest_promos: 35,
    rest_table_order: 125,
    rest_qr_theme: 15,
    rest_order_theme: 70,
    rest_rewards: 130,
    rest_branches: 60,
    rest_points_theme: 35,
    attendance: 125,
    att_branch: 30,
    att_app_theme: 55,
    att_qr_theme: 35,
    att_staff: 30,
    att_telegram: 40,
    att_leave: 50,
    att_selfie: 60,
    att_kiosk: 45,
    att_payroll: 80,
    att_kiosk_theme: 85,
    att_app: 150,
    att_website: 95,
    att_web_theme: 35,
    att_holidays: 45,
    team_year: 5, // Team access for one business (Admin / View only members), yearly
    att_roster: 60,
    att_khpay: 80,
    att_manager: 40,
    att_docs: 35,
    att_news: 30,
    att_rewards: 30,
    att_gps_guard: 40,
    guest_house: 150,
    menu_qr: 50,
    mq_categories: 35,
    mq_items: 20,
    mq_promos: 65,
    mq_feedback: 15,
    mq_stats: 20,
    mq_theme: 20,
    mq_theme_pro: 35,
    mq_qr_style: 10,
    mq_media_slot: 1,
    flipbook: 35,
    qr_gen: 25,
    qr_forms: 75,
    qr_telegram: 50,
    qr_stats: 35,
    qr_geo: 20,
    qr_bulk: 30,
    qr_rules: 15,
    qr_design: 5,
    qr_theme: 10,
    qr_links: 30,
    qr_coupons: 40,
    qr_nobrand: 20,
    qr_form_pro: 25,
    qr_smart: 20,
    qr_slug: 10,
    qr_print: 5,
    qr_file_pack: 25,
    website: 100,
    web_telegram: 35,
    web_brand: 35,
    web_pages: 35,
    web_blog: 35,
    web_nobrand: 35,
    web_slug: 35,
    web_stats: 50,
    web_theme: 35,
    debt_book: 20,
    debt_remind: 15,
    debt_more: 10,
    debt_excel: 10,
    debt_nobrand: 10,
    digital_note: 10, // Digital Note, yearly
    note_storage: 15, // +5 GB file storage per pack, yearly
    note_group: 1, // one group of notes (sent with one link), forever
    note_sign: 5, // signature / pen pop-up, forever
    note_style: 5, // style pack (colours, emoji, stickers…), forever
    note_group_icon: 2, // a picture as one group's icon, forever
    note_media: 8, // media manager, forever
    note_theme: 3, // one public page theme (per theme), forever
    note_link: 10, // custom links for notes + groups, forever
    note_telegram: 10, // Telegram alerts + checklist reminders, yearly
    note_ack: 5, // "I've read it" confirmations, forever
    note_form: 5, // sign-up list fields + Excel export, forever
    note_voice: 5, // voice notes, forever
    note_pdf: 5, // branded PDF export, forever
    stamp_card: 40,
    sc_check: 20,
    sc_telegram: 30,
    sc_more: 20,
    sc_levels: 15,
    sc_expiry: 10,
    sc_theme: 15,
    sc_poster: 10,
    event: 75,
    ev_doors: 50,
    ev_team: 30,
    ev_cashier: 40,
    ev_invites: 30,
    ev_export: 30,
    ev_nobrand: 60,
    ev_theme: 15,
    ev_page_theme: 25,
    ev_cert_theme: 35,
    ev_waitlist: 30,
    ev_pricing: 30,
    ev_referrals: 50,
    ev_bundles: 30,
    ev_feedback: 30,
    ev_sponsors: 40,
    ev_feature: 20,
    ev_telegram: 40,
    ev_guest_tg: 50,
    ev_seats: 60,
    ev_shows: 40,
    ev_promos: 30,
    ev_questions: 30,
    ev_autopay: 60,
    ev_certs: 40,
    tg_store: 45, // Telegram Store, per year (v2.0)
    ts_promos: 25, // promo codes, per year
    ts_broadcast: 30, // message your customers, per year
    ts_reports: 20, // sales report + Excel, per year
    ts_hours: 10, // opening hours, forever
    ts_nobrand: 20, // no BizHub name, forever
    ts_history: 45, // every order, not only the last 60 days, forever
    ts_pay: 10, // more ways to pay + picture / QR, forever
    ts_link: 20, // own link name + QR style, forever
    ts_remind: 20, // cart reminder + order again, per year
    ts_zones: 20, // delivery zones, per year
    ts_riders: 30, // riders group, per year
    ts_theme: 15, // one store design, forever
    fb_book_slot: 1, // v1.5.5: 5 more books = 5 coins (was 5 each)
    fb_big_slot: 10,
    fb_categories: 100,
    fb_stats: 20,
    fb_password: 15,
    fb_shelf_theme: 15,
    fb_reader_theme: 10,
    fb_qr_styles: 35,
    fb_shelf_live: 25,
    fb_leads: 30,
    fb_links: 25, // v1.5.5 (was 60)
    mart: 150,
    mart_staff: 45,
    mart_payments: 55,
    mart_stock: 115,
    mart_printer: 75,
    mart_history: 35,
    mart_debt: 50,
    mart_shifts: 40,
    mart_labels: 45,
    mart_suppliers: 55,
    mart_website: 110,
    mart_site_theme: 35,
    mart_shop: 75,
    mart_portal_theme: 85,
    mart_pos_theme: 15,
    mart_telegram: 90,
    mart_expiry: 50,
    mart_loyalty: 60,
    mart_promos: 50,
    mart_profit: 45,
    mart_purchase: 60,
    mart_display: 40,
    mart_scale: 50,
    mart_delivery: 60,
    mart_branches: 60,
    mart_print_theme: 25,
    gh_rooms: 45,
    gh_types: 50,
    gh_payments: 60,
    gh_staff: 50,
    gh_display: 65,
    gh_display_theme: 75,
    gh_printer: 65,
    gh_print_theme: 45,
    gh_website: 85,
    gh_site_theme: 65,
    gh_promos: 95,
    gh_customers: 200,
    gh_portal_theme: 25,
    gh_telegram: 40,
    gh_police: 45,
    gh_services: 40,
    gh_reviews: 35,
    gh_loyalty: 50,
    gh_longstay: 60,
    gh_ical: 120,
    gh_housekeeping: 55,
    gh_expenses: 50,
    gh_branches: 60,
  },
  payment_methods: ["KHQR", "ABA", "Card"],
  app: { status: "coming_soon", android_url: "", ios_url: "" },
  services: SHOWN_SERVICES.map((key, i) => ({ key, enabled: true, coming_soon: false, sort_order: i })),
  // service groups on the website + in "Add business" (Super admin → Business groups). Keys are homepage service keys.
  groups: [
    { key: "online", en: "Online & QR", km: "អនឡាញ & QR", types: ["namecard", "website", "menu_qr", "qr_gen", "stamp_card"] },
    { key: "system", en: "Management systems", km: "ប្រព័ន្ធគ្រប់គ្រង", types: ["restaurant", "mart", "guest", "attend", "event", "tg_store"] },
    { key: "personal", en: "Personal", km: "ផ្ទាល់ខ្លួន", types: ["flipbook", "debt_book", "digital_note"] },
  ],
  texts: { en: {}, km: {} },
};

const PRICE_KEYS = Object.keys(DEFAULT_HOMEPAGE.prices);

module.exports = { DEFAULT_HOMEPAGE, SERVICE_KEYS, PRICE_KEYS };
