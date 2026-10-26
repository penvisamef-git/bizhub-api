// Everything a customer can buy for a business that lasts (forever or for some days).
// To add a monthly / yearly service later: add one line here + its price key in homepage.defaults.js
//   price_key  → Homepage.prices.<key>   days → null = forever, 30 = monthly, 365 = yearly
//   category   → which business type can buy it
//   retired    → can't be bought any more (old records stay valid)
//   soon       → shown, but can't be bought until the feature ships (the POS phase)
const PRODUCTS = {
  // Team access (v1.5): other BizHub accounts open this business as Admin / View only. Any business type, yearly.
  team: { price_key: "team_year", days: 365, category: "*", service: "team" },
  no_branding: { price_key: "remove_branding", days: null, category: "namecard", service: "namecard_branding", retired: true }, // "Made with BizHub" is gone for everyone
  portfolio: { price_key: "portfolio_year", days: 365, category: "namecard", service: "namecard_portfolio" },
  // a restaurant is paid per year: the first year when it's created, then renewed here
  restaurant: { price_key: "restaurant", days: 365, category: "restaurant", service: "restaurant" },
  // restaurant add-ons — each yearly one runs 365 days from the day it was bought
  rest_kitchen: { price_key: "rest_kitchen", days: 365, category: "restaurant", service: "rest_kitchen" }, // kitchen stations + tickets
  rest_history: { price_key: "rest_history", days: 365, category: "restaurant", service: "rest_history" }, // reports + invoices older than 30 days
  rest_payments: { price_key: "rest_payments", days: null, category: "restaurant", service: "rest_payments" }, // more than 2 payment methods
  rest_staff: { price_key: "rest_staff", days: 365, category: "restaurant", service: "rest_staff" }, // more than 2 staff accounts
  rest_rewards: { price_key: "rest_rewards", days: 365, category: "restaurant", service: "rest_rewards" }, // members collect points, swap them for rewards
  rest_table_order: { price_key: "rest_table_order", days: 365, category: "restaurant", service: "rest_table_order" }, // guests order from the table QR
  rest_promos: { price_key: "rest_promos", days: null, category: "restaurant", service: "rest_promos" }, // automatic promotions: % / $ off, buy X get Y, happy hours
  rest_stock: { price_key: "rest_stock", days: 365, category: "restaurant", service: "rest_stock" }, // stock per item: qty, stock in / out, counts, alerts
  rest_branches: { price_key: "rest_branches", days: 365, category: "restaurant", service: "rest_branches" }, // several restaurants in one group: one report for all, yearly (on the main one)
  rest_qr_menu: { price_key: "rest_qr_menu", days: null, category: "restaurant", service: "rest_qr_menu" }, // table QR + online menu
  rest_printer: { price_key: "rest_printer", days: 365, category: "restaurant", service: "rest_printer" }, // connect receipt + kitchen printers
  rest_telegram: { price_key: "rest_telegram", days: 365, category: "restaurant", service: "rest_telegram" }, // reports to the owner's Telegram
  rest_website: { price_key: "rest_website", days: 365, category: "restaurant", service: "rest_website" }, // own website at /s/<name>
  // BizHub POS app for Android / iOS (one app for all the business's places) — ships later
  rest_app: { price_key: "rest_app", days: 365, category: "restaurant", service: "rest_app", soon: true },
  // a paid website theme, bought once per restaurant (item = theme key)
  rest_site_theme: { price_key: "rest_site_theme", days: null, category: "restaurant", service: "rest_site_theme", item: true },
  // a paid receipt (printing) look, bought once per restaurant (item = theme key)
  rest_receipt_theme: { price_key: "rest_receipt_theme", days: null, category: "restaurant", service: "rest_receipt_theme", item: true },
  rest_pos_theme: { price_key: "rest_pos_theme", days: null, category: "restaurant", service: "rest_pos_theme", item: true }, // one POS look, forever
  rest_qr_theme: { price_key: "rest_qr_theme", days: null, category: "restaurant", service: "rest_qr_theme", item: true }, // one table-sticker look, forever
  rest_points_theme: { price_key: "rest_points_theme", days: 365, category: "restaurant", service: "rest_points_theme", item: true }, // one look for the members' pages, yearly
  rest_order_theme: { price_key: "rest_order_theme", days: null, category: "restaurant", service: "rest_order_theme", item: true }, // one guest-page look, forever
  // customer display: the screen facing the guest (forever) + its paid looks
  rest_display: { price_key: "rest_display", days: null, category: "restaurant", service: "rest_display" },
  rest_display_theme: { price_key: "rest_display_theme", days: null, category: "restaurant", service: "rest_display_theme", item: true },
  // attendance: the business is yearly (5 staff + 1 branch included); each extra branch is its own yearly slot (item = slot key)
  attendance: { price_key: "attendance", days: 365, category: "attendance", service: "attendance" },
  att_branch: { price_key: "att_branch", days: 365, category: "attendance", service: "att_branch", item: true },
  att_app_theme: { price_key: "att_app_theme", days: null, category: "attendance", service: "att_app_theme", item: true }, // one staff-app look, forever
  att_qr_theme: { price_key: "att_qr_theme", days: null, category: "attendance", service: "att_qr_theme", item: true }, // one QR sticker style, forever
  att_staff: { price_key: "att_staff", days: 365, category: "attendance", service: "att_staff", item: true }, // +5 staff, its own yearly slot
  att_telegram: { price_key: "att_telegram", days: 365, category: "attendance", service: "att_telegram" },
  att_leave: { price_key: "att_leave", days: 365, category: "attendance", service: "att_leave" },
  att_selfie: { price_key: "att_selfie", days: 365, category: "attendance", service: "att_selfie" },
  att_kiosk: { price_key: "att_kiosk", days: 365, category: "attendance", service: "att_kiosk" },
  att_payroll: { price_key: "att_payroll", days: 365, category: "attendance", service: "att_payroll" },
  att_kiosk_theme: { price_key: "att_kiosk_theme", days: 365, category: "attendance", service: "att_kiosk_theme", item: true }, // one door-kiosk look, yearly
  att_website: { price_key: "att_website", days: 365, category: "attendance", service: "att_website" }, // company website at /w/<slug>
  att_khpay: { price_key: "att_khpay", days: 365, category: "attendance", service: "att_khpay" }, // Cambodia payroll: tax, NSSF, seniority
  att_manager: { price_key: "att_manager", days: 365, category: "attendance", service: "att_manager" }, // Manager login
  att_docs: { price_key: "att_docs", days: 365, category: "attendance", service: "att_docs" }, // Staff documents
  att_news: { price_key: "att_news", days: 365, category: "attendance", service: "att_news" }, // Announcements
  att_rewards: { price_key: "att_rewards", days: 365, category: "attendance", service: "att_rewards" }, // On-time rewards
  att_gps_guard: { price_key: "att_gps_guard", days: 365, category: "attendance", service: "att_gps_guard" }, // Fake GPS check
  guest_house: { price_key: "guest_house", days: 365, category: "guest_house", service: "guest_house" }, // Guest House (rooms, bookings, room bills)
  // Menu QR: a menu to look at behind a QR code (yearly) + its add-ons
  menu_qr: { price_key: "menu_qr", days: 365, category: "menu_qr", service: "menu_qr" },
  mq_categories: { price_key: "mq_categories", days: null, category: "menu_qr", service: "mq_categories" }, // more than 5 categories, forever
  mq_items: { price_key: "mq_items", days: null, category: "menu_qr", service: "mq_items" }, // more than 20 items, forever
  mq_promos: { price_key: "mq_promos", days: null, category: "menu_qr", service: "mq_promos" }, // sale prices + promotions, forever
  mq_feedback: { price_key: "mq_feedback", days: 365, category: "menu_qr", service: "mq_feedback" }, // customer feedback after the scan, yearly
  mq_stats: { price_key: "mq_stats", days: 365, category: "menu_qr", service: "mq_stats" }, // scan stats, yearly
  mq_theme: { price_key: "mq_theme", days: null, category: "menu_qr", service: "mq_theme", item: true }, // one menu look (basic), forever
  mq_theme_pro: { price_key: "mq_theme_pro", days: null, category: "menu_qr", service: "mq_theme_pro", item: true }, // one menu look (premium), forever
  mq_qr_style: { price_key: "mq_qr_style", days: null, category: "menu_qr", service: "mq_qr_style", item: true }, // one QR code style, forever
  // Flip Book (35 coins once, no license) — its add-ons
  fb_categories: { price_key: "fb_categories", days: null, category: "flipbook", service: "fb_categories" }, // more than 1 category, forever
  fb_stats: { price_key: "fb_stats", days: 365, category: "flipbook", service: "fb_stats" }, // reading stats, yearly
  fb_password: { price_key: "fb_password", days: null, category: "flipbook", service: "fb_password", item: true }, // a password on one book (item = book id), forever
  fb_shelf_theme: { price_key: "fb_shelf_theme", days: null, category: "flipbook", service: "fb_shelf_theme", item: true }, // one shelf design, forever
  fb_qr_styles: { price_key: "fb_qr_styles", days: null, category: "flipbook", service: "fb_qr_styles" }, // all 12 QR card styles, once, forever
  fb_leads: { price_key: "fb_leads", days: 365, category: "flipbook", service: "fb_leads" }, // contact form on books + list of contacts, yearly
  fb_links: { price_key: "fb_links", days: null, category: "flipbook", service: "fb_links" }, // clickable boxes on pages (links, phone, video…), forever
  fb_shelf_live: { price_key: "fb_shelf_live", days: null, category: "flipbook", service: "fb_shelf_live", item: true }, // one live (animated) library design, forever
  qr_forms: { price_key: "qr_forms", days: null, category: "qr_gen", service: "qr_forms" }, // Form QR codes + inbox, forever
  qr_telegram: { price_key: "qr_telegram", days: 365, category: "qr_gen", service: "qr_telegram" }, // Telegram alerts (form replies, scans), yearly
  qr_stats: { price_key: "qr_stats", days: null, category: "qr_gen", service: "qr_stats" }, // scan stats + full history, forever
  qr_geo: { price_key: "qr_geo", days: 365, category: "qr_gen", service: "qr_geo" }, // city / country + device of each scan, yearly
  qr_bulk: { price_key: "qr_bulk", days: null, category: "qr_gen", service: "qr_bulk" }, // many QR codes from an Excel list, forever
  qr_rules: { price_key: "qr_rules", days: null, category: "qr_gen", service: "qr_rules" }, // end date / scan limit / password per QR, forever
  qr_design: { price_key: "qr_design", days: null, category: "qr_gen", service: "qr_design", item: true }, // one QR design, forever
  qr_links: { price_key: "qr_links", days: null, category: "qr_gen", service: "qr_links" }, // link page QR type, forever
  qr_coupons: { price_key: "qr_coupons", days: null, category: "qr_gen", service: "qr_coupons" }, // coupon QR type, forever
  qr_nobrand: { price_key: "qr_nobrand", days: null, category: "qr_gen", service: "qr_nobrand" }, // no "Made with BizHub", forever
  qr_form_pro: { price_key: "qr_form_pro", days: null, category: "qr_gen", service: "qr_form_pro" }, // photo, signature, stars, conditions in forms, forever
  qr_smart: { price_key: "qr_smart", days: null, category: "qr_gen", service: "qr_smart" }, // iPhone / Android / time-of-day links, forever
  qr_slug: { price_key: "qr_slug", days: null, category: "qr_gen", service: "qr_slug", item: true }, // custom link name for one QR (item = code id), forever
  qr_print: { price_key: "qr_print", days: null, category: "qr_gen", service: "qr_print", item: true }, // one print template, forever
  qr_theme: { price_key: "qr_theme", days: null, category: "qr_gen", service: "qr_theme", item: true }, // one page theme (page after scanning), forever
  // Website Builder: yearly (first year paid when it's made) + add-ons bought once, forever
  website: { price_key: "website", days: 365, category: "website", service: "website" },
  web_telegram: { price_key: "web_telegram", days: null, category: "website", service: "web_telegram" }, // contact-form messages to Telegram
  web_brand: { price_key: "web_brand", days: null, category: "website", service: "web_brand" }, // any colour, all fonts, colours from the logo
  web_pages: { price_key: "web_pages", days: null, category: "website", service: "web_pages" }, // up to 30 pages (5 free)
  web_blog: { price_key: "web_blog", days: null, category: "website", service: "web_blog" }, // blog / news posts
  web_nobrand: { price_key: "web_nobrand", days: null, category: "website", service: "web_nobrand" }, // no "Made with BizHub" in the footer
  web_slug: { price_key: "web_slug", days: null, category: "website", service: "web_slug" }, // choose the /site/<name> link
  web_stats: { price_key: "web_stats", days: 365, category: "website", service: "web_stats" }, // Visits Pro: countries, cities, devices, sources, IPs — yearly
  web_theme: { price_key: "web_theme", days: null, category: "website", service: "web_theme", item: true }, // one paid look (item = theme key)
  // Debt Book (yearly) + add-ons
  debt_book: { price_key: "debt_book", days: null, category: "debt_book", service: "debt_book" }, // paid once when the business is added (no yearly license)
  debt_remind: { price_key: "debt_remind", days: 365, category: "debt_book", service: "debt_remind" }, // auto reminders on Telegram + owner's daily summary, yearly
  debt_more: { price_key: "debt_more", days: null, category: "debt_book", service: "debt_more" }, // more than 100 customers, forever
  debt_excel: { price_key: "debt_excel", days: null, category: "debt_book", service: "debt_excel" }, // import / export (Excel), forever
  debt_nobrand: { price_key: "debt_nobrand", days: null, category: "debt_book", service: "debt_nobrand" }, // no BizHub name on statements, forever
  // Digital Note (yearly): shared notes (view / add below / edit / collect), files, seen by, history — 5 GB included
  digital_note: { price_key: "digital_note", days: 365, category: "digital_note", service: "digital_note" },
  note_storage: { price_key: "note_storage", days: 365, category: "digital_note", service: "note_storage", item: true }, // +5 GB per pack, each pack its own yearly slot (item = "slot-N")
  note_group: { price_key: "note_group", days: null, category: "digital_note", service: "note_group", item: true }, // one group of notes (item = group id), paid when it's made, forever
  note_sign: { price_key: "note_sign", days: null, category: "digital_note", service: "note_sign" }, // signature / pen pop-up, forever
  note_style: { price_key: "note_style", days: null, category: "digital_note", service: "note_style" }, // style pack: colours, sizes, emoji, stickers, callouts, paper — forever
  note_group_icon: { price_key: "note_group_icon", days: null, category: "digital_note", service: "note_group_icon", item: true }, // a picture as a group's icon (item = group id), forever
  note_media: { price_key: "note_media", days: null, category: "digital_note", service: "note_media" }, // media manager: every stored file, sizes, clean up — forever
  note_link: { price_key: "note_link", days: null, category: "digital_note", service: "note_link" }, // custom links /n/<name> for notes + groups, forever
  note_theme: { price_key: "note_theme", days: null, category: "digital_note", service: "note_theme", item: true }, // one public page theme (item = theme key), forever
  // v4 (NOTE_V4.md)
  note_telegram: { price_key: "note_telegram", days: 365, category: "digital_note", service: "note_telegram" }, // Telegram alerts + checklist reminders, yearly
  note_ack: { price_key: "note_ack", days: null, category: "digital_note", service: "note_ack" }, // "I've read it" confirmations, forever
  note_form: { price_key: "note_form", days: null, category: "digital_note", service: "note_form" }, // sign-up list fields + Excel export, forever
  note_voice: { price_key: "note_voice", days: null, category: "digital_note", service: "note_voice" }, // voice notes in notes + replies, forever
  note_pdf: { price_key: "note_pdf", days: null, category: "digital_note", service: "note_pdf" }, // branded PDF export, forever
  // Loyalty Stamp Card (yearly) + add-ons
  stamp_card: { price_key: "stamp_card", days: 365, category: "stamp_card", service: "stamp_card" }, // the card: stamps, rewards, customers' card links, shop QR, staff desk
  sc_check: { price_key: "sc_check", days: 365, category: "stamp_card", service: "sc_check" }, // customers open their card again with their phone (shop QR), yearly
  sc_telegram: { price_key: "sc_telegram", days: 365, category: "stamp_card", service: "sc_telegram" }, // Telegram: owner alerts + daily summary, customers get their stamps, yearly
  sc_more: { price_key: "sc_more", days: null, category: "stamp_card", service: "sc_more" }, // more than 100 customers, forever
  sc_levels: { price_key: "sc_levels", days: null, category: "stamp_card", service: "sc_levels" }, // several rewards on one card (5 = topping, 10 = free drink), forever
  sc_expiry: { price_key: "sc_expiry", days: null, category: "stamp_card", service: "sc_expiry" }, // stamps end after some months without a visit, forever
  sc_theme: { price_key: "sc_theme", days: null, category: "stamp_card", service: "sc_theme", item: true }, // one premium card design, forever
  sc_poster: { price_key: "sc_poster", days: null, category: "stamp_card", service: "sc_poster", item: true }, // one shop QR poster design, forever
  // Event Tickets: events, ticket types, KHQR orders + screenshot, ticket QRs, 1 door phone, 3 team members
  event: { price_key: "event", days: 365, category: "event", service: "event" },
  ev_doors: { price_key: "ev_doors", days: 365, category: "event", service: "ev_doors" }, // more door phones (up to 20), yearly
  ev_team: { price_key: "ev_team", days: null, category: "event", service: "ev_team" }, // more than 3 team members, forever
  ev_cashier: { price_key: "ev_cashier", days: null, category: "event", service: "ev_cashier" }, // gate cashier: sell tickets at the door, forever
  ev_invites: { price_key: "ev_invites", days: null, category: "event", service: "ev_invites" }, // free / VIP invite tickets, forever
  ev_export: { price_key: "ev_export", days: null, category: "event", service: "ev_export" }, // guest list export (Excel / CSV), forever
  ev_nobrand: { price_key: "ev_nobrand", days: null, category: "event", service: "ev_nobrand" }, // no "Made with BizHub" on event pages + tickets, forever
  ev_telegram: { price_key: "ev_telegram", days: 365, category: "event", service: "ev_telegram" }, // organisers: Approve / Reject in Telegram + daily summary, yearly
  ev_guest_tg: { price_key: "ev_guest_tg", days: 365, category: "event", service: "ev_guest_tg" }, // guests: tickets, reminders, live updates, documents on Telegram, yearly
  ev_seats: { price_key: "ev_seats", days: null, category: "event", service: "ev_seats" }, // seat map, forever
  ev_shows: { price_key: "ev_shows", days: null, category: "event", service: "ev_shows" }, // showtimes, forever
  ev_promos: { price_key: "ev_promos", days: null, category: "event", service: "ev_promos" }, // promo codes, forever
  ev_questions: { price_key: "ev_questions", days: null, category: "event", service: "ev_questions" }, // registration questions + names per ticket, forever
  ev_autopay: { price_key: "ev_autopay", days: 365, category: "event", service: "ev_autopay" }, // automatic KHQR payment (Bakong checks it, tickets come by themselves), yearly
  ev_certs: { price_key: "ev_certs", days: null, category: "event", service: "ev_certs" }, // certificates of attendance + attendance list, forever
  ev_page_theme: { price_key: "ev_page_theme", days: null, category: "event", service: "ev_page_theme", item: true }, // one event page theme (item = key), forever, for every event
  ev_waitlist: { price_key: "ev_waitlist", days: null, category: "event", service: "ev_waitlist" }, // waitlist for sold-out events, forever
  ev_pricing: { price_key: "ev_pricing", days: null, category: "event", service: "ev_pricing" }, // early-bird + timed prices, forever
  ev_referrals: { price_key: "ev_referrals", days: 365, category: "event", service: "ev_referrals" }, // promoters' links + commission, yearly
  ev_bundles: { price_key: "ev_bundles", days: null, category: "event", service: "ev_bundles" }, // group deals (4 for $30), forever
  ev_feedback: { price_key: "ev_feedback", days: null, category: "event", service: "ev_feedback" }, // stars + comments after the event, forever
  ev_sponsors: { price_key: "ev_sponsors", days: null, category: "event", service: "ev_sponsors" }, // sponsor logos on pages + certificates, forever
  ev_feature: { price_key: "ev_feature", days: 7, category: "event", service: "ev_feature", item: true }, // one event featured on the public events page, 7 days (item = event id)
  ev_cert_theme: { price_key: "ev_cert_theme", days: null, category: "event", service: "ev_cert_theme", item: true }, // one certificate design (item = key), forever, for every event
  ev_theme: { price_key: "ev_theme", days: null, category: "event", service: "ev_theme", item: true }, // one ticket design (item = theme key), forever, for every event
  fb_reader_theme: { price_key: "fb_reader_theme", days: null, category: "flipbook", service: "fb_reader_theme", item: true }, // one reader look, forever
  mart: { price_key: "mart", days: 365, category: "mart", service: "mart" }, // Mini Mart (fast sale, barcode, products, offline POS)
  mart_staff: { price_key: "mart_staff", days: 365, category: "mart", service: "mart_staff" }, // unlimited cashiers (2 free), yearly
  mart_payments: { price_key: "mart_payments", days: null, category: "mart", service: "mart_payments" }, // more than 3 payment methods, forever
  mart_stock: { price_key: "mart_stock", days: 365, category: "mart", service: "mart_stock" }, // stock control: stock count, receive, adjust, sales take stock, yearly
  mart_printer: { price_key: "mart_printer", days: null, category: "mart", service: "mart_printer" }, // print receipts, forever
  mart_history: { price_key: "mart_history", days: 365, category: "mart", service: "mart_history" }, // see sales + reports older than 30 days, yearly
  mart_debt: { price_key: "mart_debt", days: 365, category: "mart", service: "mart_debt" }, // debt book: customers buying on credit + repayments, yearly
  mart_shifts: { price_key: "mart_shifts", days: null, category: "mart", service: "mart_shifts" }, // shifts & cash drawer: open / count / close, forever
  mart_labels: { price_key: "mart_labels", days: null, category: "mart", service: "mart_labels" }, // print barcode labels for the shelves, forever
  mart_suppliers: { price_key: "mart_suppliers", days: null, category: "mart", service: "mart_suppliers" }, // suppliers: who you buy from, what was received, notes, forever
  mart_website: { price_key: "mart_website", days: 365, category: "mart", service: "mart_website" }, // the shop website at /m/<slug>, yearly
  mart_site_theme: { price_key: "mart_site_theme", days: null, category: "mart", service: "mart_site_theme", item: true }, // one website look, forever
  mart_shop: { price_key: "mart_shop", days: 365, category: "mart", service: "mart_shop", needs: "mart_website" }, // online orders + customer accounts, yearly
  mart_portal_theme: { price_key: "mart_portal_theme", days: null, category: "mart", service: "mart_portal_theme", item: true }, // one customer-dashboard look, forever
  mart_pos_theme: { price_key: "mart_pos_theme", days: null, category: "mart", service: "mart_pos_theme", item: true }, // one POS look, forever
  mart_telegram: { price_key: "mart_telegram", days: 365, category: "mart", service: "mart_telegram" }, // Telegram alerts: website orders, shift closed, low stock, messages, yearly
  mart_expiry: { price_key: "mart_expiry", days: 365, category: "mart", service: "mart_expiry" }, // expiry dates: batches, near-expiry alerts, sell first, waste, yearly
  mart_loyalty: { price_key: "mart_loyalty", days: 365, category: "mart", service: "mart_loyalty" }, // loyalty points by phone, POS + website, yearly
  mart_promos: { price_key: "mart_promos", days: 365, category: "mart", service: "mart_promos" }, // promotions: buy X get Y, % off, happy hour, coupons, yearly
  mart_profit: { price_key: "mart_profit", days: 365, category: "mart", service: "mart_profit" }, // profit report: cost vs price, margins, yearly
  mart_purchase: { price_key: "mart_purchase", days: null, category: "mart", service: "mart_purchase", needs: "mart_stock" }, // reorder list + purchase orders, forever
  mart_display: { price_key: "mart_display", days: null, category: "mart", service: "mart_display" }, // customer screen on a second display, forever
  mart_scale: { price_key: "mart_scale", days: null, category: "mart", service: "mart_scale" }, // weighing-scale barcodes (weight / price inside), forever
  mart_delivery: { price_key: "mart_delivery", days: 365, category: "mart", service: "mart_delivery", needs: "mart_shop" }, // delivery zones + drivers, yearly
  mart_branches: { price_key: "mart_branches", days: 365, category: "mart", service: "mart_branches" }, // several shops: transfers, stock everywhere, combined report, yearly
  mart_print_theme: { price_key: "mart_print_theme", days: null, category: "mart", service: "mart_print_theme", item: true }, // one receipt template, forever
  gh_rooms: { price_key: "gh_rooms", days: null, category: "guest_house", service: "gh_rooms" }, // unlimited rooms (5 free), forever
  gh_types: { price_key: "gh_types", days: null, category: "guest_house", service: "gh_types" }, // unlimited room types (2 free), forever
  gh_payments: { price_key: "gh_payments", days: null, category: "guest_house", service: "gh_payments" }, // more than 3 payment methods, forever
  gh_staff: { price_key: "gh_staff", days: 365, category: "guest_house", service: "gh_staff" }, // more desk staff (2 free), yearly
  gh_display: { price_key: "gh_display", days: null, category: "guest_house", service: "gh_display" }, // guest display at the desk, forever
  gh_display_theme: { price_key: "gh_display_theme", days: null, category: "guest_house", service: "gh_display_theme", item: true }, // one guest-display look, forever
  gh_printer: { price_key: "gh_printer", days: null, category: "guest_house", service: "gh_printer" }, // print bills + receipts, forever
  gh_print_theme: { price_key: "gh_print_theme", days: null, category: "guest_house", service: "gh_print_theme", item: true }, // one receipt template, forever
  gh_website: { price_key: "gh_website", days: 365, category: "guest_house", service: "gh_website" }, // the guest house website at /g/<slug>, yearly
  gh_site_theme: { price_key: "gh_site_theme", days: null, category: "guest_house", service: "gh_site_theme", item: true }, // one website look, forever
  gh_promos: { price_key: "gh_promos", days: null, category: "guest_house", service: "gh_promos" }, // season / date deals, forever
  gh_customers: { price_key: "gh_customers", days: 365, category: "guest_house", service: "gh_customers", needs: "gh_website" }, // customer accounts on the website, yearly
  gh_portal_theme: { price_key: "gh_portal_theme", days: null, category: "guest_house", service: "gh_portal_theme", item: true }, // one customer-dashboard look, forever
  gh_telegram: { price_key: "gh_telegram", days: 365, category: "guest_house", service: "gh_telegram" }, // Telegram alerts: new online bookings, check-in/out, payments + daily summary, yearly
  gh_police: { price_key: "gh_police", days: null, category: "guest_house", service: "gh_police" }, // foreign guest report for the local police, forever
  gh_services: { price_key: "gh_services", days: null, category: "guest_house", service: "gh_services" }, // extra services menu (laundry, motorbike, tours…), forever
  gh_branch: { price_key: "gh_branch", days: 365, category: "guest_house", service: "gh_branch", item: true, retired: true }, // (removed) branches — one place per guest house; another place = another business
  gh_pro: { price_key: "gh_pro", days: 365, category: "guest_house", service: "gh_pro", retired: true }, // (removed) Guest House Pro pack — not sold
  gh_reviews: { price_key: "gh_reviews", days: 365, category: "guest_house", service: "gh_reviews" }, // guest reviews: link after check-out, good ones on the website, yearly
  gh_loyalty: { price_key: "gh_loyalty", days: 365, category: "guest_house", service: "gh_loyalty", needs: "gh_customers" }, // loyalty points for customer accounts, yearly
  gh_longstay: { price_key: "gh_longstay", days: 365, category: "guest_house", service: "gh_longstay" }, // long stay / monthly rent: bills, meters, reminders, yearly
  gh_ical: { price_key: "gh_ical", days: 365, category: "guest_house", service: "gh_ical" }, // Booking.com / Agoda / Airbnb calendar sync (iCal), yearly
  gh_housekeeping: { price_key: "gh_housekeeping", days: null, category: "guest_house", service: "gh_housekeeping" }, // housekeeping: dirty → cleaning → ready + housekeeper phones, forever
  gh_branches: { price_key: "gh_branches", days: 365, category: "guest_house", service: "gh_branches" }, // several guest houses in one group: one report for all, yearly (on the main one)
  gh_expenses: { price_key: "gh_expenses", days: null, category: "guest_house", service: "gh_expenses" }, // expenses & profit, forever
  att_roster: { price_key: "att_roster", days: 365, category: "attendance", service: "att_roster" }, // weekly roster
  att_holidays: { price_key: "att_holidays", days: null, category: "attendance", service: "att_holidays", item: true }, // one year's Cambodia public holidays (item = year)
  att_web_theme: { price_key: "att_web_theme", days: null, category: "attendance", service: "att_web_theme", item: true }, // one website look, forever
  // BizHub app for attendance: staff + owner use the phone app — ships later
  att_app: { price_key: "att_app", days: 365, category: "attendance", service: "att_app", soon: true },
};

// A license that ends within this many days is "expiring" (shown in orange, time to renew)
const EXPIRING_DAYS = 14;

// business types that are a yearly license themselves (product key = business type)
// restaurant add-ons, in the order the dashboard shows them
const REST_ADDONS = [
  "rest_website",
  "rest_telegram",
  "rest_display",
  "rest_app",
  "rest_printer",
  "rest_kitchen",
  "rest_qr_menu",
  "rest_payments",
  "rest_staff",
  "rest_history",
  "rest_stock",
  "rest_promos",
  "rest_table_order",
  "rest_rewards",
  "rest_branches",
];

const YEARLY_TYPES = Object.keys(PRODUCTS).filter((k) => PRODUCTS[k].category === k && PRODUCTS[k].days);

module.exports = { PRODUCTS, PRODUCT_KEYS: Object.keys(PRODUCTS), EXPIRING_DAYS, YEARLY_TYPES, REST_ADDONS };
