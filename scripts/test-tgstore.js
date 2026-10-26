// Tests for the Telegram Store (v2.0): src/biz/tgstore/*. In-memory database only.
// Run: node scripts/test-tgstore.js   (needs mongodb-memory-server: NODE_PATH=…/node_modules)
let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) {
    pass++;
    console.log("  ✓", m);
  } else {
    fail++;
    console.log("  ✗", m, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "");
  }
};

(async () => {
  const crypto = require("crypto");
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mem = await MongoMemoryServer.create();
  const BOT = "123456:TEST-token";
  Object.assign(process.env, { NODE_ENV: "test", API_AUTH_KEY: "k", JWT_SECRET: "s", MONGO_URI: mem.getUri("test"), BIZHUB_ENV: "", TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_BOT_USERNAME: "BizHubTestBot", BAKONG_TOKEN: "" });

  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  const app = require("../index");
  await new Promise((r) => (mongoose.connection.readyState === 1 ? r() : mongoose.connection.once("connected", r)));
  const Customer = require("../src/user/customer.model");
  const Sess = require("../src/user/customer_session.model");
  const AuthKey = require("../src/v1/admin/auth/auth_api_key.model");
  const Wallet = require("../src/coin/wallet.model");
  const coin = require("../src/coin/coin.service");
  const M = require("../src/biz/tgstore/tgstore.models");
  const { tgUser } = require("../src/biz/tgstore/tgstore.route");
  const telegram = require("../src/telegram");

  await AuthKey.create({ api_auth_key: "k" });
  await coin.getTreasury();
  const c = await Customer.create({ name: "Sokha", email: "sokha@test.com", phone: "+85512345678", password: "x", status: true, deleted: false });
  const tok = jwt.sign({ type: "customer", customer_id: String(c._id) }, "s", { expiresIn: "1h" });
  await Sess.create({ customer_id: c._id, access_token: tok, expires_at: new Date(Date.now() + 3600e3) });
  const w = await coin.getCustomerWallet(c._id);
  await Wallet.updateOne({ _id: w._id }, { $set: { balance: 100 } });

  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, body, { auth = true, headers = {} } = {}) => {
    const r = await fetch(base + p, { method: m, headers: { "x-api-key": "k", "Content-Type": "application/json", ...(auth ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  // what Telegram signs when it opens the store
  const initData = (user, botToken = BOT, age = 0) => {
    const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - age), query_id: "AAE", user: JSON.stringify(user) });
    const check = [...p.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    p.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
    return p.toString();
  };

  console.log("\nthe new business type");
  let r = await call("GET", "/api/user/businesses-prices");
  ok(r.j.data?.tg_store === 45 || r.j.tg_store === 45 || JSON.stringify(r.j).includes('"tg_store":45'), "price list has Telegram Store at 45 coins", r.j);
  r = await call("POST", "/api/user/businesses", { name: "Sokha Café", category: "tg_store" });
  ok(r.s === 201 && r.j.charged === 45 && r.j.data?.license?.active, "create: 45 coins, a 1-year license", r.j);
  const bid = r.j.data._id;
  ok((await coin.getCustomerWallet(c._id)).balance === 55, "wallet 100 → 55");
  const B = `/api/user/businesses/${bid}/tgstore`;
  r = await call("GET", B);
  ok(r.s === 200 && r.j.data.store.slug === "sokha-cafe" && r.j.data.links.telegram === "https://t.me/BizHubTestBot?start=st_sokha-cafe", "overview: slug + Telegram link", r.j.data?.links);
  r = await call("GET", "/api/public/homepage");
  ok(JSON.stringify(r.j.data?.groups || r.j.data).includes("tg_store"), "homepage lists the service in Management systems");

  console.log("\nsettings");
  r = await call("PUT", `${B}/settings`, { pay: { khqr: { on: true, bakong_id: "not a bakong id" } } });
  ok(r.s === 400 && r.j.code === "bad_bakong", "a wrong Bakong ID is refused");
  r = await call("PUT", `${B}/settings`, { about: "Coffee · until 21:00", delivery: { on: true, fee: 1, free_from: 20, min_order: 5 }, dine_in: { on: true, tables: 12 }, pay: { khqr: { on: true, bakong_id: "sokha@aba", account_name: "SOKHA CAFE" }, cash: { on: true } } });
  ok(r.s === 200 && r.j.data.store.pay.khqr.on && r.j.data.store.dine_in.tables === 12, "delivery, tables, KHQR + cash saved", r.j);
  r = await call("PUT", `${B}/settings`, { pay: { khqr: { on: false }, cash: { on: false } } });
  ok(r.s === 400 && r.j.code === "need_pay", "at least one way to pay");

  console.log("\ncategories + products");
  r = await call("POST", `${B}/categories`, { name: "Coffee", name_km: "កាហ្វេ" });
  const cat = r.j.data?._id;
  ok(r.s === 201 && cat, "category made");
  r = await call("POST", `${B}/products`, {
    name: "Coconut iced latte",
    price: 2.5,
    category_id: cat,
    options: [
      { name: "Size", required: true, choices: [{ name: "Regular" }, { name: "Large", price: 0.5 }] },
      { name: "Extra", multi: true, choices: [{ name: "Shot", price: 0.5 }, { name: "Cream", price: 0.25 }] },
    ],
  });
  const latte = r.j.data;
  ok(r.s === 201 && latte.options.length === 2, "product with choices", r.j);
  r = await call("POST", `${B}/products`, { name: "Butter croissant", price: 1.5, stock: 3 });
  const croissant = r.j.data;
  ok(r.s === 201 && croissant.stock === 3, "product with stock 3");
  r = await call("POST", `${B}/products`, { name: "Matcha cake", price: 3, sold_out: true });
  const cake = r.j.data;
  r = await call("POST", `${B}/products`, { name: "", price: 1 });
  ok(r.s === 400, "a product needs a name");

  console.log("\nthe public store");
  r = await call("GET", "/api/public/tgstore/sokha-cafe", null, { auth: false });
  ok(r.s === 200 && r.j.data.products.length === 3 && r.j.data.store.pay.khqr && r.j.data.store.dine_in.tables === 12, "store page: 3 products, KHQR, tables", r.j);
  ok(r.j.data.products.find((p) => p._id === cake._id).sold_out === true, "sold out shows");

  console.log("\nordering from a browser");
  const P = "/api/public/tgstore/sokha-cafe/orders";
  r = await call("POST", P, { mode: "delivery", items: [{ product_id: latte._id, qty: 1 }], name: "Dara", phone: "012 345 678", address: "St 271" }, { auth: false });
  ok(r.s === 400 && r.j.code === "need_choice", "a required choice must be picked", r.j);
  r = await call("POST", P, { mode: "delivery", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Regular" }] }], name: "Dara", phone: "012345678", address: "St 271" }, { auth: false });
  ok(r.s === 400 && r.j.code === "min_order", "an order under the $5 minimum is refused for delivery", r.j);
  r = await call("POST", P, { mode: "delivery", items: [{ product_id: cake._id, qty: 1 }], name: "Dara", phone: "012345678", address: "St 271" }, { auth: false });
  ok(r.s === 409 && r.j.code === "sold_out", "sold out can't be ordered");
  r = await call(
    "POST",
    P,
    {
      mode: "delivery",
      pay: "cash",
      items: [
        { product_id: latte._id, qty: 2, options: [{ group: "Size", choice: "Large" }, { group: "Extra", choice: "Shot" }, { group: "Extra", choice: "Cream" }], note: "less ice" },
        { product_id: croissant._id, qty: 2, price: 0.01 },
      ],
      name: "Dara",
      phone: "012345678",
      address: "St 271, Toul Tompoung",
    },
    { auth: false },
  );
  // latte 2.5 + 0.5 + 0.5 + 0.25 = 3.75 × 2 = 7.50 · croissant 1.5 × 2 = 3.00 (the phone's price is ignored) · delivery 1.00
  ok(r.s === 201 && r.j.data.total === 11.5, "prices worked out on the server: $11.50 with delivery", r.j);
  const t1 = r.j.data.token;
  ok((await M.TgProduct.findById(croissant._id)).stock === 1, "stock 3 → 1");
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: croissant._id, qty: 2 }], name: "Mony", phone: "098765432" }, { auth: false });
  ok(r.s === 409 && r.j.code === "stock" && r.j.left === 1, "can't take more than what is left", r.j);
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: croissant._id, qty: 1 }], name: "Mony" }, { auth: false });
  ok(r.s === 400 && r.j.code === "need_phone", "pickup needs a phone", r.j);
  r = await call("POST", P, { mode: "dine_in", items: [{ product_id: croissant._id, qty: 1 }], name: "Table guest" }, { auth: false });
  ok(r.s === 400 && r.j.code === "need_table", "dine-in needs a table");

  r = await call("GET", `/api/public/tgstore/order/${t1}`, null, { auth: false });
  ok(r.s === 200 && r.j.data.order.status === "new" && r.j.data.order.no === 1 && !r.j.data.khqr, "the customer follows order #1", r.j);

  console.log("\nKHQR + Telegram Mini App");
  const user = { id: 777001, first_name: "Vanna", last_name: "Chea", username: "vanna", allows_write_to_pm: true };
  ok(tgUser(initData(user))?.tg_id === "777001", "signed Telegram data is read");
  ok(tgUser(initData(user, "999:other-bot")) === null, "data signed for another bot is refused");
  ok(tgUser(initData(user, BOT, 3 * 86400)) === null, "old data (3 days) is refused");
  ok(tgUser(initData(user).replace("Vanna", "Hacker")) === null, "changed data is refused");
  r = await call("POST", P, { mode: "dine_in", table: "5", pay: "khqr", items: [{ product_id: croissant._id, qty: 1 }] }, { auth: false, headers: { "x-tg-init-data": initData(user) } });
  ok(r.s === 201 && r.j.data.total === 1.5, "Telegram customer orders at table 5 (no name / phone typed)", r.j);
  const t2 = r.j.data.token;
  r = await call("GET", `/api/public/tgstore/order/${t2}`, null, { auth: false });
  ok(r.j.data.khqr?.qr?.startsWith("000201") && r.j.data.khqr.amount === 1.5, "a KHQR with the exact amount", r.j.data?.khqr);
  ok(r.j.data.order.via === "telegram" && r.j.data.order.customer.username === "vanna", "the order knows the Telegram account");
  r = await call("GET", "/api/public/tgstore/sokha-cafe/me", null, { auth: false, headers: { "x-tg-init-data": initData(user) } });
  ok(r.j.data.telegram && r.j.data.orders.length === 1 && r.j.data.can_message, "Telegram customer sees their orders", r.j);

  console.log("\nthe shop moves the orders");
  r = await call("GET", `${B}/orders`);
  ok(r.j.data.length === 2 && r.j.counts.new === 2 && r.j.counts.today_total === 13, "2 open orders, $13 today", r.j.counts);
  const o1 = r.j.data.find((o) => o.no === 1);
  const o2 = r.j.data.find((o) => o.no === 2);
  r = await call("POST", `${B}/orders/${o1._id}/status`, { status: "done" });
  ok(r.s === 409, "can't jump from new to done");
  r = await call("POST", `${B}/orders/${o1._id}/status`, { status: "accepted", eta: 20 });
  ok(r.s === 200 && r.j.data.status === "accepted" && r.j.data.eta_min === 20, "accepted · 20 min");
  r = await call("POST", `${B}/orders/${o1._id}/status`, { status: "on_way" });
  r = await call("POST", `${B}/orders/${o1._id}/paid`);
  ok(r.j.data.pay.status === "paid", "marked paid");
  r = await call("POST", `${B}/orders/${o1._id}/status`, { status: "done" });
  ok(r.j.data.status === "done" && r.j.data.timeline.length >= 4, "done, with its timeline");
  r = await call("POST", `${B}/orders/${o2._id}/status`, { status: "cancelled", reason: "Out of croissants" });
  ok(r.j.data.status === "cancelled" && (await M.TgProduct.findById(croissant._id)).stock === 1, "cancel gives the stock back (0 → 1)");
  r = await call("GET", `${B}/customers`);
  ok(r.j.data.length === 2 && r.j.data.find((x) => x.name === "Dara").orders === 1, "customers: Dara (1 order, $11.50) + the Telegram customer", r.j.data);

  console.log("\nthe staff group buttons");
  await M.TgStore.updateOne({ business_id: bid }, { $set: { "tg.chat_id": "-100555" } });
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Regular" }] }], name: "Mony", phone: "098765432" }, { auth: false });
  const o3 = await M.TgOrder.findOne({ token: r.j.data.token });
  await telegram.handleUpdate({ callback_query: { id: "q1", data: `tgo:${o3._id}:eta15`, from: { first_name: "Srey" }, message: { chat: { id: -100999 } } } });
  ok((await M.TgOrder.findById(o3._id)).status === "new", "a button pressed in another chat does nothing");
  await telegram.handleUpdate({ callback_query: { id: "q2", data: `tgo:${o3._id}:eta15`, from: { first_name: "Srey" }, message: { chat: { id: -100555 } } } });
  let o3b = await M.TgOrder.findById(o3._id);
  ok(o3b.status === "accepted" && o3b.eta_min === 15 && o3b.timeline.at(-1).by === "Srey", "Accept · 15 min from the group, by Srey");
  await telegram.handleUpdate({ callback_query: { id: "q3", data: `tgo:${o3._id}:ready`, from: { first_name: "Srey" }, message: { chat: { id: -100555 } } } });
  await telegram.handleUpdate({ callback_query: { id: "q4", data: `tgo:${o3._id}:paid`, from: { first_name: "Srey" }, message: { chat: { id: -100555 } } } });
  o3b = await M.TgOrder.findById(o3._id);
  ok(o3b.status === "ready" && o3b.pay.status === "paid", "Ready + Paid from the group");

  console.log("\nTelegram /start");
  // what the bot sends to Telegram (no network in tests)
  const replies = [];
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    if (!String(url).startsWith("https://api.telegram.org/")) return fetch0(url, o);
    replies.push({ method: String(url).split("/").pop(), body: JSON.parse(o.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { headers: { "Content-Type": "application/json" } });
  };
  await telegram.handleUpdate({ message: { chat: { id: 4242, type: "private", first_name: "Vanna" }, text: "/start st_sokha-cafe" } });
  const btn = replies.find((x) => x.method === "sendMessage")?.body?.reply_markup?.inline_keyboard?.[0]?.[0];
  ok(btn?.web_app?.url?.endsWith("/t/sokha-cafe"), "the shop link answers with an Open store button (inside Telegram)", replies);
  replies.length = 0;
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Large" }] }], name: "Bopha", phone: "011222333", note: "<b>hi</b>" }, { auth: false });
  const sent = replies.find((x) => x.method === "sendMessage")?.body;
  ok(sent?.chat_id === "-100555" && /#\d+/.test(sent.text) && sent.text.includes("&lt;b&gt;hi") && sent.reply_markup.inline_keyboard[0][0].callback_data.endsWith(":accept"), "a new order goes to the staff group with Accept (text escaped)", sent);

  console.log("\nadd-ons");
  await Wallet.updateOne({ _id: w._id }, { $set: { balance: 500 } });
  const buyAddon = (k) => call("POST", `/api/user/businesses/${bid}/licenses/${k}`, { expect: null });
  r = await call("GET", B);
  const ad = r.j.data.addons;
  ok(ad && ad.ts_promos.price === 25 && ad.ts_promos.days === 365 && !ad.ts_promos.active && ad.ts_hours.days === null && ad.ts_nobrand.price === 20, "overview lists the 5 add-ons with prices", ad);
  r = await call("POST", `${B}/promos`, { code: "SAVE10", kind: "percent", value: 10 });
  ok(r.s === 402 && r.j.product === "ts_promos", "promo codes need the add-on", r.j);
  r = await buyAddon("ts_promos");
  ok(r.j.success && r.j.charged === 25, "buy Promo codes: 25 coins", r.j);
  r = await call("POST", `${B}/promos`, { code: " save10 ", kind: "percent", value: 10, min_order: 5 });
  ok(r.s === 201 && r.j.data.code === "SAVE10", "SAVE10 (10 %, from $5) made, upper case", r.j);
  r = await call("POST", `${B}/promos`, { code: "SAVE10", kind: "amount", value: 1 });
  ok(r.s === 409, "the same code twice is refused");
  r = await call("POST", `${B}/promos`, { code: "x", kind: "amount", value: 1 });
  ok(r.s === 400 && r.j.code === "bad_code", "a too short code is refused");
  r = await call("POST", `${B}/promos`, { code: "ONCE2", kind: "amount", value: 2, max_uses: 1 });
  ok(r.s === 201, "ONCE2 ($2 off, once) made");
  r = await call("GET", "/api/public/tgstore/sokha-cafe", null, { auth: false });
  ok(r.j.data.store.promo === true && r.j.data.store.brand === true, "the store shows the promo field (and the BizHub name)");
  r = await call("POST", "/api/public/tgstore/sokha-cafe/promo", { code: "save10", subtotal: 10 }, { auth: false });
  ok(r.s === 200 && r.j.data.off === 1, "SAVE10 on $10 → $1 off", r.j);
  r = await call("POST", "/api/public/tgstore/sokha-cafe/promo", { code: "SAVE10", subtotal: 3 }, { auth: false });
  ok(r.s === 400 && r.j.code === "promo_min", "SAVE10 under $5 → works from $5", r.j);
  r = await call("POST", "/api/public/tgstore/sokha-cafe/promo", { code: "NOPE", subtotal: 30 }, { auth: false });
  ok(r.s === 400 && r.j.code === "bad_promo", "an unknown code doesn't work");
  replies.length = 0;
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: latte._id, qty: 3, options: [{ group: "Size", choice: "Large" }] }], name: "Bopha", phone: "011222333", promo: "save10" }, { auth: false });
  let po = r.s === 201 && (await M.TgOrder.findOne({ token: r.j.data.token }).lean());
  ok(po && po.discount > 0 && po.promo === "SAVE10" && Math.abs(po.total - (po.subtotal - po.discount)) < 0.001, "an order with SAVE10: discount on the server, total = subtotal − discount", po && { s: po.subtotal, d: po.discount, t: po.total });
  ok(replies.some((x) => x.body?.text?.includes("🏷 SAVE10")), "the staff group sees the promo code");
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Large" }] }], name: "Bopha", phone: "011222333", promo: "ONCE2" }, { auth: false });
  ok(r.s === 201, "ONCE2 works the first time", r.j);
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Large" }] }], name: "Bopha", phone: "011222333", promo: "ONCE2" }, { auth: false });
  ok(r.s === 400 && r.j.code === "bad_promo", "ONCE2 can't be used a second time", r.j);
  r = await call("GET", `${B}/promos`);
  ok(r.j.data.find((x) => x.code === "ONCE2").used === 1 && r.j.data.find((x) => x.code === "SAVE10").used === 1, "promo list counts the uses");
  r = await call("GET", `/api/public/tgstore/order/${(await M.TgOrder.findOne({ promo: "SAVE10" })).token}`, null, { auth: false });
  ok(r.j.data.order.discount > 0 && r.j.data.order.promo === "SAVE10" && r.j.data.store.brand === true, "the customer's order page shows the discount");

  // opening hours
  const allDays = (d) => Array.from({ length: 7 }, () => d);
  r = await call("PUT", `${B}/settings`, { hours: { on: true, days: allDays({ open: "07:00", close: "21:00" }) } });
  ok(r.s === 402 && r.j.product === "ts_hours", "opening hours need the add-on");
  r = await buyAddon("ts_hours");
  ok(r.j.success && r.j.data.forever, "buy Opening hours: forever", r.j);
  r = await call("PUT", `${B}/settings`, { hours: { on: true, days: allDays({ open: "07:00", close: "07:00" }) } });
  ok(r.s === 400 && r.j.code === "bad_hours", "open = close is refused");
  r = await call("PUT", `${B}/settings`, { hours: { on: true, days: allDays({ open: "07:00", close: "21:00", closed: true }) } });
  ok(r.s === 200 && r.j.data.open_now.open === false, "closed every day → closed now");
  r = await call("GET", "/api/public/tgstore/sokha-cafe", null, { auth: false });
  ok(r.j.data.store.open === false && r.j.data.store.hours?.days?.length === 7 && r.j.data.store.opens === null, "customers see it closed (no next opening)");
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Large" }] }], name: "Bopha", phone: "011222333" }, { auth: false });
  ok(r.s === 409 && r.j.code === "closed", "and can't order");
  r = await call("PUT", `${B}/settings`, { hours: { on: true, days: allDays({ open: "00:00", close: "23:59" }) } });
  ok(r.s === 200 && r.j.data.open_now.open === true, "00:00–23:59 every day → open now");
  r = await call("PUT", `${B}/settings`, { hours: { on: false } });
  ok(r.s === 200 && r.j.data.store.hours.on === false, "hours off again");

  // sales report
  r = await call("GET", `${B}/report?days=7`);
  ok(r.s === 402 && r.j.product === "ts_reports", "the report needs the add-on");
  r = await buyAddon("ts_reports");
  ok(r.j.success && r.j.charged === 20, "buy Sales report");
  r = await call("GET", `${B}/report?days=7`);
  ok(r.s === 200 && r.j.data.by_day.length === 7 && r.j.data.totals.orders >= 3 && r.j.data.best[0]?.qty > 0 && r.j.data.hours.length === 24 && r.j.data.totals.discount > 0, "report: 7 days, orders, best sellers, hours, discounts", r.j.data?.totals);
  r = await call("GET", `${B}/report/orders?days=30`);
  ok(r.s === 200 && r.j.data.length >= 3 && r.j.data.some((x) => x.promo === "SAVE10") && typeof r.j.data[0].items === "string", "report orders for Excel", r.j.data?.[0]);

  // message the customers
  r = await call("GET", `${B}/broadcasts`);
  ok(r.s === 200 && r.j.data.reach >= 1 && r.j.data.per_day === 3, "broadcasts: who can be reached", r.j.data);
  r = await call("POST", `${B}/broadcasts`, { text: "New: mango smoothie!" });
  ok(r.s === 402 && r.j.product === "ts_broadcast", "sending needs the add-on");
  await buyAddon("ts_broadcast");
  replies.length = 0;
  r = await call("POST", `${B}/broadcasts`, { text: "New: <mango> smoothie!" });
  const bmsg = replies.find((x) => x.method === "sendMessage" && x.body.text.includes("smoothie"));
  ok(r.s === 201 && r.j.data.sent >= 1 && bmsg && bmsg.body.text.includes("&lt;mango&gt;") && bmsg.body.reply_markup.inline_keyboard[0][0].web_app, "sent to the Telegram customers, with an Open store button (escaped)", r.j);
  await call("POST", `${B}/broadcasts`, { text: "2" });
  await call("POST", `${B}/broadcasts`, { text: "3" });
  r = await call("POST", `${B}/broadcasts`, { text: "4" });
  ok(r.s === 429 && r.j.code === "limit", "3 a day at most");
  r = await call("GET", `${B}/broadcasts`);
  ok(r.j.data.rows.length === 3 && r.j.data.today === 3, "history of what was sent");

  // no BizHub name
  r = await buyAddon("ts_nobrand");
  r = await call("GET", "/api/public/tgstore/sokha-cafe", null, { auth: false });
  ok(r.j.data.store.brand === false, "No BizHub name: the store hides it");

  // order history: the last 60 days unless ts_history
  const old1 = await M.TgOrder.findOne({ business_id: bid }).sort({ created_date: 1 });
  await M.TgOrder.collection.updateOne({ _id: old1._id }, { $set: { created_date: new Date(Date.now() - 90 * 86400e3) } });
  r = await call("GET", `${B}/orders?status=all`);
  ok(r.s === 200 && !r.j.data.some((o) => String(o._id) === String(old1._id)) && r.j.history.all === false && r.j.history.hidden === 1, "history: a 90-day-old order is hidden (60 days)", r.j.history);
  r = await call("GET", `${B}/orders?status=all&from=2020-01-01`);
  ok(!r.j.data.some((o) => String(o._id) === String(old1._id)), "…even asking from 2020");
  r = await call("GET", `${B}/orders?status=all&q=Bopha`);
  ok(r.j.data.length >= 1 && r.j.data.every((o) => o.customer.name === "Bopha") && r.j.sum > 0, "search by name + the sum", r.j.sum);
  r = await call("GET", `${B}/orders?status=all&pay=cash&mode=pickup`);
  ok(r.j.data.every((o) => o.pay.method === "cash" && o.mode === "pickup"), "filter by how + pay");
  r = await buyAddon("ts_history");
  ok(r.j.success && r.j.charged === 45 && r.j.data.forever, "buy Full history: 45 coins, forever", r.j);
  r = await call("GET", `${B}/orders?status=all&limit=100`);
  ok(r.j.data.some((o) => String(o._id) === String(old1._id)) && r.j.history.all === true, "now every order shows");

  // customers
  r = await call("GET", `${B}/customers?sort=spent`);
  ok(r.s === 200 && r.j.stats.all >= 2 && r.j.stats.telegram >= 1 && r.j.data[0].spent >= r.j.data.at(-1).spent && r.j.data[0].placed >= 1, "customers: stats + sorted by spent", r.j.stats);
  const cid = r.j.data.find((c) => c.name === "Bopha")._id;
  r = await call("GET", `${B}/customers/${cid}`);
  ok(r.s === 200 && r.j.data.orders.length >= 1 && r.j.data.favourites[0]?.name, "one customer: their orders + favourites", r.j.data?.favourites);
  r = await call("PUT", `${B}/customers/${cid}`, { note: "Less sugar" });
  ok(r.j.data.note === "Less sugar", "a note on the customer");
  r = await call("GET", `${B}/customers?q=sugar`);
  ok(r.j.data.length === 1, "search finds the note");

  // ways to pay
  r = await call("POST", `${B}/pay-methods`, { name: "ABA", info: "000 123 456 · SOKHA" });
  ok(r.s === 201 && r.j.data.length === 1, "1 own way to pay is free (KHQR + Cash + ABA = 3)");
  const aba = r.j.data[0]._id;
  r = await call("POST", `${B}/pay-methods`, { name: "Wing" });
  ok(r.s === 402 && r.j.product === "ts_pay", "a 4th needs More ways to pay", r.j);
  const fd = new FormData();
  fd.append("image", new Blob([Buffer.from("iVBORw0KGgo=", "base64")], { type: "image/png" }), "qr.png");
  let up = await fetch(`${base}${B}/pay-methods/${aba}/image`, { method: "POST", headers: { "x-api-key": "k", authorization: `Bearer ${tok}` }, body: fd });
  ok(up.status === 402, "a QR picture needs it too");
  r = await buyAddon("ts_pay");
  ok(r.j.success && r.j.charged === 10, "buy More ways to pay: 10 coins");
  r = await call("POST", `${B}/pay-methods`, { name: "Wing", info: "012 345 678" });
  ok(r.s === 201 && r.j.data.length === 2, "now a 4th way works");
  r = await call("GET", "/api/public/tgstore/sokha-cafe", null, { auth: false });
  ok(r.j.data.store.pay.custom.length === 2 && r.j.data.store.pay.custom[0].info.includes("000 123"), "customers see ABA + Wing");
  r = await call("POST", P, { mode: "pickup", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Large" }] }], name: "Bopha", phone: "011222333", pay: `custom:${aba}` }, { auth: false });
  po = r.s === 201 && (await M.TgOrder.findOne({ token: r.j.data.token }).lean());
  ok(po && po.pay.method === "custom" && po.pay.custom.name === "ABA", "an order paid with ABA", r.j);
  r = await call("GET", `/api/public/tgstore/order/${po.token}`, null, { auth: false });
  ok(r.j.data.order.pay.custom?.info.includes("000 123") && r.j.data.khqr === null, "the order page shows how to pay ABA");

  // designs
  r = await call("GET", B);
  ok(r.j.data.themes.count === 120 && r.j.data.themes.free.length === 3 && r.j.data.themes.price === 15 && r.j.data.store.theme === "grid-cream", "120 designs, 3 free, 15 coins each", r.j.data.themes);
  r = await call("POST", `${B}/themes/list-snow`);
  ok(r.j.success && r.j.charged === 0 && r.j.data.theme === "list-snow", "a free design: no coins");
  r = await call("POST", `${B}/themes/nope-x`);
  ok(r.s === 400, "an unknown design is refused");
  r = await call("POST", `${B}/themes/magazine-night`);
  ok(r.j.success && r.j.charged === 15, "a premium design: 15 coins", r.j);
  r = await call("GET", "/api/public/tgstore/sokha-cafe?theme=bubble-rose", null, { auth: false });
  ok(r.j.data.store.theme === "bubble-rose" && r.j.data.store.preview === true, "?theme= shows a preview");
  r = await call("GET", "/api/public/tgstore/sokha-cafe", null, { auth: false });
  ok(r.j.data.store.theme === "magazine-night", "customers see the bought design");

  // channel text, own link + QR
  r = await call("PUT", `${B}/settings`, { channel_text: "☕ {name}: order here {link}" });
  ok(r.j.data.store.channel_text === "☕ {name}: order here {link}", "the channel post wording is saved");
  r = await call("PUT", `${B}/link`, { slug: "sokha" });
  ok(r.s === 402 && r.j.product === "ts_link", "own link needs the add-on");
  r = await call("PUT", `${B}/settings`, { qr: { fg: "#0B77C2" } });
  ok(r.s === 402, "QR colours need it too");
  r = await buyAddon("ts_link");
  ok(r.j.success && r.j.charged === 20, "buy Own link & QR: 20 coins");
  r = await call("PUT", `${B}/link`, { slug: "a" });
  ok(r.s === 400 && r.j.code === "bad_slug", "a too short link is refused");
  r = await call("PUT", `${B}/link`, { slug: "sokha-coffee" });
  ok(r.s === 200 && r.j.data.links.telegram.endsWith("st_sokha-coffee") && r.j.data.links.web.endsWith("/t/sokha-coffee"), "renamed to sokha-coffee", r.j.data);
  r = await call("GET", "/api/public/tgstore/sokha-cafe", null, { auth: false });
  ok(r.s === 200 && r.j.data.store.slug === "sokha-coffee", "the old link still opens the store");
  r = await call("PUT", `${B}/settings`, { qr: { fg: "#0B77C2", bg: "#FFFFFF", logo: true } });
  ok(r.j.data.store.qr.fg === "#0B77C2" && r.j.data.store.qr.logo === true, "QR colours + logo saved");
  console.log("\ncart reminder + order again (ts_remind)");
  await Wallet.updateOne({ _id: w._id }, { $set: { balance: 500 } });
  const S = "/api/public/tgstore/sokha-coffee";
  const kim = { id: 888002, first_name: "Kim", username: "kim_kh", allows_write_to_pm: true };
  const kimH = { auth: false, headers: { "x-tg-init-data": initData(kim) } };
  r = await call("PUT", `${S}/cart`, { items: [{ product_id: latte._id, qty: 2, options: [{ group: "Size", choice: "Large" }] }] }, kimH);
  ok(r.s === 200 && r.j.data.saved === false, "without the add-on the cart isn't kept");
  r = await call("GET", B);
  ok(r.j.data.addons.ts_remind?.price === 20 && r.j.data.addons.ts_zones?.price === 20 && r.j.data.addons.ts_riders?.price === 30, "3 new add-ons: 20 · 20 · 30 coins a year", r.j.data.addons);
  r = await buyAddon("ts_remind");
  ok(r.j.success && r.j.charged === 20, "buy Cart reminder: 20 coins", r.j);
  r = await call("PUT", `${S}/cart`, { items: [{ product_id: latte._id, qty: 2, options: [{ group: "Size", choice: "Large" }] }] }, { auth: false });
  ok(r.j.data.saved === false, "a browser (not Telegram) cart isn't kept");
  r = await call("PUT", `${S}/cart`, { items: [{ product_id: latte._id, qty: 2, options: [{ group: "Size", choice: "Large" }] }, { product_id: "bad" }] }, kimH);
  ok(r.j.data.saved && r.j.data.n === 1, "Kim's cart is kept (1 line; a bad id dropped)", r.j);
  r = await call("GET", `${S}/me`, null, kimH);
  ok(r.j.data.cart.length === 1 && r.j.data.cart[0].qty === 2, "the cart comes back when Kim opens the store again", r.j.data);
  r = await call("GET", `${B}/carts`);
  ok(r.j.data.rows.length === 1 && r.j.data.rows[0].name === "Kim" && r.j.data.rows[0].total === 5 && !r.j.data.rows[0].reminded, "the owner sees Kim's cart ($5)", r.j.data);
  const { tick } = require("../src/biz/tgstore/tgstore.route");
  replies.length = 0;
  let tk = await tick();
  ok(tk.sent === 0, "not reminded straight away");
  await M.TgCart.collection.updateOne({ tg_id: "888002" }, { $set: { at: new Date(Date.now() - 61 * 60000) } });
  tk = await tick();
  const rem = replies.find((x) => x.method === "sendMessage" && x.body.chat_id === "888002");
  ok(tk.sent === 1 && rem && rem.body.text.includes("2 items") && rem.body.reply_markup.inline_keyboard[0][0].web_app.url.endsWith("/t/sokha-coffee"), "after an hour: one reminder with a Finish my order button", rem);
  tk = await tick();
  ok(tk.sent === 0, "only once");
  r = await call("PUT", `${B}/settings`, { remind: { after_min: 30, text: "Hi {name}, your {n} items wait!" } });
  ok(r.j.data.store.remind.after_min === 30 && r.j.data.store.remind.text.includes("{name}"), "own wording + after 30 min");
  r = await call("POST", `${S}/orders`, { mode: "pickup", items: [{ product_id: latte._id, qty: 2, options: [{ group: "Size", choice: "Large" }] }], phone: "012999888" }, kimH);
  ok(r.s === 201, "Kim orders after the reminder", r.j);
  const kimOrder = await M.TgOrder.findOne({ token: r.j.data.token });
  ok(kimOrder.from_remind && !(await M.TgCart.exists({ tg_id: "888002" })), "the order counts as won back; the cart is gone");
  r = await call("GET", `${B}/carts`);
  ok(r.j.data.stats.sent === 1 && r.j.data.stats.back === 1 && r.j.data.stats.back_total === 6, "stats: 1 sent · 1 back · $6", r.j.data.stats);
  await call("PUT", `${S}/cart`, { items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Regular" }] }] }, kimH);
  await M.TgCart.collection.updateOne({ tg_id: "888002" }, { $set: { at: new Date(Date.now() - 31 * 60000) } });
  replies.length = 0;
  await tick();
  const rem2 = replies.find((x) => x.method === "sendMessage" && x.body.chat_id === "888002");
  ok(rem2?.body.text.includes("Hi Kim, your 1 items wait!"), "the owner's own wording", rem2?.body?.text);
  r = await call("PUT", `${S}/cart`, { items: [] }, kimH);
  ok(!(await M.TgCart.exists({ tg_id: "888002" })), "an empty cart is cleared");
  r = await call("GET", `${S}/me`, null, kimH);
  ok(r.j.data.last?.items?.[0]?.product_id === String(latte._id) && r.j.data.last.items[0].options[0].choice === "Large", "Order again: the last order's items", r.j.data.last);
  r = await call("GET", S, null, { auth: false });
  ok(r.j.data.store.again === true, "the store shows Order again");
  replies.length = 0;
  await call("POST", `${B}/orders/${kimOrder._id}/status`, { status: "accepted" });
  await call("POST", `${B}/orders/${kimOrder._id}/status`, { status: "done" });
  const doneMsg = replies.find((x) => x.method === "sendMessage" && x.body.chat_id === "888002" && x.body.text.includes("Done"));
  ok(doneMsg?.body.reply_markup.inline_keyboard[1]?.[0]?.web_app?.url.includes(`?again=${kimOrder.token}`), "the Done message has an Order again button", doneMsg?.body?.reply_markup);

  console.log("\ndelivery zones (ts_zones)");
  r = await call("PUT", `${B}/settings`, { zones: { on: true, kind: "area", areas: [{ name: "Daun Penh", fee: 1 }] } });
  ok(r.s === 402 && r.j.product === "ts_zones", "zones need the add-on");
  r = await buyAddon("ts_zones");
  ok(r.j.success && r.j.charged === 20, "buy Delivery zones: 20 coins");
  r = await call("PUT", `${B}/settings`, { zones: { on: true, kind: "area", areas: [] } });
  ok(r.s === 400 && r.j.code === "need_areas", "areas need at least one");
  r = await call("PUT", `${B}/settings`, { delivery: { free_from: 0, min_order: 0 }, zones: { on: true, kind: "area", areas: [{ name: "Daun Penh", fee: 1 }, { name: "Sen Sok", fee: 2.5, min_order: 8 }, { name: "Kandal", fee: 4, on: false }] } });
  ok(r.s === 200 && r.j.data.store.zones.areas.length === 3, "3 areas saved", r.j);
  const areas = r.j.data.store.zones.areas;
  r = await call("GET", S, null, { auth: false });
  ok(r.j.data.store.zones?.kind === "area" && r.j.data.store.zones.areas.length === 2, "customers see the 2 areas that are on", r.j.data.store.zones);
  const dOrder = (extra) => call("POST", `${S}/orders`, { mode: "delivery", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Regular" }] }], name: "Dara", phone: "012345678", address: "St 271", ...extra }, { auth: false });
  r = await dOrder({});
  ok(r.s === 400 && r.j.code === "need_area", "an area must be picked");
  r = await dOrder({ area: areas[2]._id });
  ok(r.s === 400 && r.j.code === "need_area", "an area that is off can't be picked");
  r = await dOrder({ area: areas[1]._id });
  ok(r.s === 400 && r.j.code === "min_order", "Sen Sok: from $8", r.j);
  r = await dOrder({ area: areas[0]._id, pin: "https://maps.google.com/?q=11.5700,104.9200" });
  const zo = await M.TgOrder.findOne({ token: r.j.data?.token });
  ok(r.s === 201 && r.j.data.total === 3.5 && zo.fee === 1 && zo.zone.name === "Daun Penh" && zo.zone.lat === 11.57, "Daun Penh: $1 delivery + the pin", r.j);
  r = await call("PUT", `${B}/settings`, { zones: { on: true, kind: "distance", steps: [{ upto: 3, fee: 1 }, { upto: 8, fee: 2 }] } });
  ok(r.s === 400 && r.j.code === "need_shop_pin", "distance needs the shop's location");
  r = await call("PUT", `${B}/settings`, { zones: { on: true, kind: "distance", pin: "11.5564, 104.9282", steps: [{ upto: 8, fee: 2 }, { upto: 3, fee: 1 }] } });
  ok(r.s === 200 && r.j.data.store.zones.lat === 11.5564 && r.j.data.store.zones.steps[0].upto === 3, "shop pin + steps (sorted)", r.j.data?.store?.zones);
  r = await call("GET", S, null, { auth: false });
  ok(r.j.data.store.zones.kind === "distance" && r.j.data.store.zones.steps.length === 2 && r.j.data.store.zones.lat === undefined, "customers see the prices, not the shop's pin", r.j.data.store.zones);
  r = await call("POST", `${S}/fee`, { pin: { lat: 11.58, lng: 104.9 } }, { auth: false });
  ok(r.s === 200 && r.j.data.km === 4 && r.j.data.fee === 2, "4 km away → $2", r.j);
  r = await call("POST", `${S}/fee`, { pin: { lat: 11.7, lng: 104.9 } }, { auth: false });
  ok(r.s === 400 && r.j.code === "too_far" && r.j.max_km === 8, "16 km: too far (up to 8 km)", r.j);
  r = await dOrder({});
  ok(r.s === 400 && r.j.code === "need_pin", "distance: the location is needed");
  r = await dOrder({ pin: "nonsense" });
  ok(r.s === 400 && r.j.code === "bad_pin", "a wrong location is refused");
  r = await dOrder({ pin: { lat: 11.557, lng: 104.93 } });
  const zo2 = await M.TgOrder.findOne({ token: r.j.data?.token });
  ok(r.s === 201 && zo2.fee === 1 && zo2.zone.km <= 3, "close by: $1", r.j);

  console.log("\nriders group (ts_riders)");
  r = await call("POST", `${B}/riders/link`);
  ok(r.s === 402 && r.j.product === "ts_riders", "the riders group needs the add-on");
  r = await buyAddon("ts_riders");
  ok(r.j.success && r.j.charged === 30, "buy Riders group: 30 coins");
  r = await call("POST", `${B}/riders/link`);
  ok(r.s === 200 && r.j.data.group_url.includes("startgroup=tr_"), "a link to add the bot to the riders group", r.j);
  const rcode = r.j.data.group_url.split("startgroup=")[1];
  await telegram.handleUpdate({ message: { chat: { id: -100777, type: "supergroup", title: "Sokha riders" }, text: `/start ${rcode}` } });
  r = await call("GET", B);
  ok(r.j.data.riders.connected && r.j.data.riders.chat_name === "Sokha riders" && r.j.data.store.riders.connected && !r.j.data.store.riders.link_code, "riders group connected", r.j.data.riders);
  replies.length = 0;
  const vanna = { id: 777001, first_name: "Vanna", allows_write_to_pm: true };
  r = await call("POST", `${S}/orders`, { mode: "delivery", pay: "cash", items: [{ product_id: latte._id, qty: 2, options: [{ group: "Size", choice: "Regular" }] }], phone: "012111222", address: "St 63, house 12", pin: { lat: 11.56, lng: 104.925 } }, { auth: false, headers: { "x-tg-init-data": initData(vanna) } });
  const ro = await M.TgOrder.findOne({ token: r.j.data.token });
  ok(!replies.some((x) => x.body?.chat_id === "-100777"), "a new order doesn't go to the riders yet");
  await call("POST", `${B}/orders/${ro._id}/status`, { status: "accepted" });
  const toRiders = replies.find((x) => x.method === "sendMessage" && x.body.chat_id === "-100777");
  ok(toRiders && toRiders.body.text.includes("St 63") && toRiders.body.text.includes("Collect") && toRiders.body.text.includes("maps.google.com/?q=11.56,104.925") && toRiders.body.reply_markup.inline_keyboard[0][0].callback_data === `tgr:${ro._id}:take`, "accepted → the riders group: address, map, cash to collect, Take it", toRiders?.body);
  const riderA = { id: 5001, first_name: "Dara", username: "dara_rider" };
  const riderB = { id: 5002, first_name: "Piseth" };
  const press = (who, act, chat = -100777) => telegram.handleUpdate({ callback_query: { id: `r${Math.random()}`, data: `tgr:${ro._id}:${act}`, from: who, message: { chat: { id: chat } } } });
  await press(riderA, "take", -100555);
  ok(!(await M.TgOrder.findById(ro._id)).rider?.tg_id, "a rider button from another chat does nothing");
  replies.length = 0;
  await press(riderA, "take");
  let rob = await M.TgOrder.findById(ro._id);
  ok(rob.rider.tg_id === "5001" && rob.rider.name === "Dara", "Dara took it");
  ok(replies.some((x) => x.body?.chat_id === "777001" && x.body.text.includes("Dara will bring")), "the customer hears Dara will bring it");
  replies.length = 0;
  await press(riderB, "take");
  ok((await M.TgOrder.findById(ro._id)).rider.tg_id === "5001" && replies.some((x) => x.method === "answerCallbackQuery" && /Taken by Dara/.test(x.body.text)), "Piseth can't take it too", replies.map((x) => x.body?.text));
  await press(riderB, "picked");
  ok(!(await M.TgOrder.findById(ro._id)).rider.picked_at, "…nor press Picked up");
  await press(riderA, "back");
  ok(!(await M.TgOrder.findById(ro._id)).rider?.tg_id, "Dara gives it back");
  await press(riderB, "take");
  replies.length = 0;
  await press(riderB, "picked");
  rob = await M.TgOrder.findById(ro._id);
  ok(rob.status === "on_way" && rob.rider.picked_at && rob.timeline.at(-1).by === "Piseth", "Piseth: Picked up → on the way");
  ok(replies.some((x) => x.body?.chat_id === "777001" && x.body.text.includes("Piseth is bringing")), "the customer hears it's on the way with Piseth");
  await press(riderB, "back");
  ok((await M.TgOrder.findById(ro._id)).rider.tg_id === "5002", "can't give back after picking up");
  await press(riderB, "done");
  rob = await M.TgOrder.findById(ro._id);
  ok(rob.status === "done" && rob.rider.delivered_at, "Delivered → done");
  r = await call("GET", `/api/public/tgstore/order/${ro.token}`, null, { auth: false });
  ok(r.j.data.order.rider?.name === "Piseth" && r.j.data.order.rider.delivered_at && r.j.data.order.zone?.lat === 11.56, "the order page shows the rider's steps", r.j.data.order);
  r = await call("GET", `${B}/riders`);
  ok(r.j.data.riders.length === 1 && r.j.data.riders[0].name === "Piseth" && r.j.data.riders[0].delivered === 1, "riders: Piseth 1 delivered (30 days)", r.j.data);
  // send by hand
  r = await call("PUT", `${B}/settings`, { riders: { send_on: "manual" } });
  ok(r.j.data.store.riders.send_on === "manual", "send to riders: by hand");
  r = await call("POST", `${S}/orders`, { mode: "delivery", items: [{ product_id: latte._id, qty: 1, options: [{ group: "Size", choice: "Regular" }] }], name: "Dara", phone: "012345678", address: "St 271", pin: { lat: 11.557, lng: 104.93 } }, { auth: false });
  const ro2 = await M.TgOrder.findOne({ token: r.j.data.token });
  replies.length = 0;
  await call("POST", `${B}/orders/${ro2._id}/status`, { status: "accepted" });
  ok(!replies.some((x) => x.body?.chat_id === "-100777"), "by hand: accepting doesn't send it");
  const staffMsg = replies.find((x) => x.body?.chat_id === "-100555");
  ok(JSON.stringify(staffMsg?.body?.reply_markup || {}).includes(`tgo:${ro2._id}:riders`), "the staff group has Send to riders", staffMsg?.body?.reply_markup);
  r = await call("POST", `${B}/orders/${ro2._id}/riders`);
  ok(r.s === 200 && r.j.data.riders_sent, "sent to the riders from the dashboard", r.j);
  const pickupOrder = await M.TgOrder.findOne({ business_id: bid, mode: "pickup", status: { $nin: ["done", "cancelled"] } });
  if (pickupOrder) {
    r = await call("POST", `${B}/orders/${pickupOrder._id}/riders`);
    ok(r.s === 400 && r.j.code === "not_delivery", "pickup orders can't go to riders");
  }
  await call("POST", `${B}/orders/${ro2._id}/status`, { status: "cancelled", reason: "No" });
  const edited = replies.filter((x) => x.method === "editMessageText" && x.body.chat_id === "-100777").at(-1);
  ok(edited?.body.text.includes("Cancelled") && !edited.body.reply_markup?.inline_keyboard?.length, "cancelled: the riders message says so, no buttons", edited?.body);
  r = await call("DELETE", `${B}/riders`);
  ok(r.j.data.connected === false, "riders group disconnected");
  globalThis.fetch = fetch0;

  console.log("\nlocked");
  await require("../src/license/license.model").updateOne({ business_id: bid, product: "tg_store" }, { $set: { expires_at: new Date(Date.now() - 10 * 86400e3) } });
  r = await call("GET", "/api/public/tgstore/sokha-coffee", null, { auth: false });
  ok(r.s === 404 && r.j.code === "off", "after the year + 7 days the store is closed to customers");
  r = await call("POST", `${B}/products`, { name: "New", price: 1 });
  ok(r.s === 402, "and the owner can't change it until renewing");

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  await mem.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
