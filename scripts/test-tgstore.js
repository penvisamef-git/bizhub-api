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
  globalThis.fetch = fetch0;

  console.log("\nlocked");
  await require("../src/license/license.model").updateOne({ business_id: bid, product: "tg_store" }, { $set: { expires_at: new Date(Date.now() - 10 * 86400e3) } });
  r = await call("GET", "/api/public/tgstore/sokha-cafe", null, { auth: false });
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
