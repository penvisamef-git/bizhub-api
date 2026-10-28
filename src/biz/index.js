// Businesses (one customer owns many). Each service has its own folder: src/biz/<service>
module.exports = (prop) => {
  require("./business.route")(prop);
  require("./business.report")(prop); // super admin: one business in detail
  require("./dashboard.route")(prop); // owner home screen (sales, coins, what needs attention)
  require("./namecard/namecard.route")(prop); // Digital Name Card
  require("./namecard/portfolio.route")(prop); // its web portfolio (yearly license)
  require("./restaurant/restaurant.route")(prop); // Restaurant setup (menu, tables, staff…) + online QR menu
  require("./attendance/attendance.route")(prop); // Attendance: branches (GPS), shifts, staff clock in on their phone
  require("./guesthouse/guesthouse.route")(prop); // Guest House: rooms, bookings, check-in / check-out, room bills
  require("./branches")(prop); // several places: restaurants + guest houses (rest_branches / gh_branches)
  require("./mart/mart.route")(prop); // Mini Mart: products, barcode sale, offline POS
  require("./menuqr")(prop); // Menu QR: view-only menu behind a QR code
  require("./flipbook")(prop); // Flip Book: PDFs as flip books, shelf + categories
  require("./qrgen")(prop); // QR Code Generator: named QR codes, scans, forms
  require("./website")(prop); // Website Builder: pages made of blocks, /site/<slug>
  require("./debt")(prop); // Debt Book: who owes what, payments, statement links, Telegram reminders
  require("./stamp")(prop); // Loyalty Stamp Card: stamps, rewards, card links, staff desk, Telegram
  require("./event")(prop); // Event Tickets: events, ticket types, KHQR orders, ticket QRs, door phones
  require("./note")(prop); // Digital Note: shared notes (view / add below / edit / collect), files, seen by, history
  require("./tgstore")(prop); // Telegram Store (v2.0): shop inside Telegram, orders to the shop's group, KHQR / cash
  require("./team/team.route")(prop); // Team access (v1.5): Admin / View only members, invite by BizHub ID or link
  require("./search.route")(prop); // Bizi search (v3.0.0): one box for everything in all my businesses (own + team-shared)
  require("./pos_demo")(prop); // "Try demo" in the BizHub POS app: a sample restaurant / mini mart / guest house
};
