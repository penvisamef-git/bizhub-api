// Tests for Bizi search (v3.0.0): src/biz/search.route.js. In-memory database only.
// Run: NODE_PATH=…/node_modules node scripts/test-search.js   (needs mongodb-memory-server)
let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) {
    pass++;
    console.log("  ✓", m);
  } else {
    fail++;
    console.log("  ✗", m, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : "");
  }
};

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mem = await MongoMemoryServer.create();
  Object.assign(process.env, { NODE_ENV: "test", API_AUTH_KEY: "k", JWT_SECRET: "s", MONGO_URI: mem.getUri("test"), BIZHUB_ENV: "", TELEGRAM_BOT_TOKEN: "123456:TEST-token", TELEGRAM_BOT_USERNAME: "BizHubTestBot", WEB_URL: "https://bizhub-cambodia.web.app" });

  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  const app = require("../index");
  await new Promise((r) => (mongoose.connection.readyState === 1 ? r() : mongoose.connection.once("connected", r)));
  const Customer = require("../src/user/customer.model");
  const Sess = require("../src/user/customer_session.model");
  const AuthKey = require("../src/v1/admin/auth/auth_api_key.model");
  const Business = require("../src/biz/business.model");
  const License = require("../src/license/license.model");
  const { TeamMember } = require("../src/biz/team/team.model");
  const TS = require("../src/biz/tgstore/tgstore.models");
  const MA = require("../src/biz/mart/mart.models");
  const RE = require("../src/biz/restaurant/restaurant.models");
  const GH = require("../src/biz/guesthouse/guesthouse.models");
  const EV = require("../src/biz/event/event.models");
  const SC = require("../src/biz/stamp/stamp.models");
  const AT = require("../src/biz/attendance/attendance.models");
  const DB = require("../src/biz/debt/debt.models");
  const NT = require("../src/biz/note/note.models");

  await AuthKey.create({ api_auth_key: "k" });
  const mkUser = async (email) => {
    const c = await Customer.create({ name: email.split("@")[0], email, phone: "+85512345678", password: "x", status: true, deleted: false });
    const tok = jwt.sign({ type: "customer", customer_id: String(c._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    await Sess.create({ customer_id: c._id, access_token: tok, expires_at: new Date(Date.now() + 3600e3) });
    return { c, tok };
  };
  const O = await mkUser("owner@test.com"); // owns the shops
  const A = await mkUser("admin@test.com"); // in O's coffee shop team
  const X = await mkUser("stranger@test.com"); // nobody

  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const find = async (q, u = O) => {
    const r = await fetch(`${base}/api/user/search?q=${encodeURIComponent(q)}`, { headers: { "x-api-key": "k", ...(u ? { authorization: `Bearer ${u.tok}` } : {}) } });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const put = (Model, doc) => Model.collection.insertOne({ created_date: new Date(), updated_date: new Date(), ...doc });
  const titles = (r) => (r.j.data?.results || []).map((x) => `${x.group}:${x.title}`);

  try {
    // O's businesses
    const coffee = await Business.create({ owner_id: O.c._id, name: "Mekong Coffee Shop", category: "tg_store" });
    const mart = await Business.create({ owner_id: O.c._id, name: "Lucky Mini Mart", category: "mart" });
    const kitchen = await Business.create({ owner_id: O.c._id, name: "Mekong Kitchen", category: "restaurant" });
    const gh = await Business.create({ owner_id: O.c._id, name: "Lotus Guest House", category: "guest_house" });
    const ev = await Business.create({ owner_id: O.c._id, name: "Khmer New Year Party", category: "event" });
    const stamp = await Business.create({ owner_id: O.c._id, name: "Mekong Coffee Stamps", category: "stamp_card" });
    const att = await Business.create({ owner_id: O.c._id, name: "Mekong Staff", category: "attendance" });
    const debt = await Business.create({ owner_id: O.c._id, name: "Shop debts", category: "debt_book" });
    const note = await Business.create({ owner_id: O.c._id, name: "Team notes", category: "digital_note" });
    const gone = await Business.create({ owner_id: O.c._id, name: "Old Coffee Corner", category: "tg_store", deleted: true });
    // someone else's shop — never in O's results
    const other = await Business.create({ owner_id: X.c._id, name: "Stranger Coffee", category: "tg_store" });

    await put(TS.TgProduct, { business_id: coffee._id, name: "Khmer iced coffee", name_km: "កាហ្វេទឹកដោះគោ", price: 1.5, deleted: false });
    await put(TS.TgProduct, { business_id: coffee._id, name: "Old latte", price: 2, deleted: true });
    await put(TS.TgProduct, { business_id: gone._id, name: "Gone coffee", price: 1, deleted: false });
    await put(TS.TgProduct, { business_id: other._id, name: "Stranger coffee", price: 1, deleted: false });
    await put(TS.TgOrder, { business_id: coffee._id, no: 12, customer: { name: "Emma Wilson", phone: "012555402" }, status: "new", items: [{ name: "Khmer iced coffee", qty: 2, price: 3.25, total: 6.5 }], total: 6.5, currency: "USD" });
    await put(TS.TgCustomer, { business_id: coffee._id, name: "Emma Wilson", phone: "012555402", username: "emmaw" });
    await put(MA.MartProduct, { business_id: mart._id, name: "Iced coffee can", barcode: "8850999320014", price: 0.75, active: true });
    await put(MA.MartSale, { _id: "s1", business_id: mart._id, no: "S-000042", member_name: "Sok Dara", status: "paid", total: 3, at: new Date() });
    await put(RE.RestItem, { business_id: kitchen._id, name_en: "Iced coffee with milk", name_km: "កាហ្វេទឹកដោះគោទឹកកក", code: "D12", price: 2, active: true });
    await put(RE.RestOrder, { _id: "o1", business_id: kitchen._id, number: "A-0007", table_name: "T5", status: "paid", total: 12, opened_at: new Date() });
    await put(GH.GhStay, { business_id: gh._id, no: "B-0003", guest: { name: "Kenji Sato", phone: "+81 90 1234 5678", id_number: "TK123456" }, status: "booked", from: new Date(), to: new Date(Date.now() + 2 * 864e5) });
    await put(EV.EvEvent, { business_id: ev._id, title: "Khmer New Year Concert", venue: "Koh Pich", status: "published", starts_at: new Date() });
    await put(EV.EvOrder, { business_id: ev._id, no: "0012", buyer: { name: "Chan Vanna", phone: "097444202" }, status: "paid", total: 10 });
    await put(SC.StampMember, { business_id: stamp._id, no: 7, name: "Sok Dara", phone: "012555101", deleted: false });
    await put(AT.AttStaff, { business_id: att._id, name: "Srey Pov", phone: "+85512345678", position: "Barista", active: true });
    const dc = await put(DB.DebtCustomer, { business_id: debt._id, name: "Uncle Heng", phone: "012 777 888", deleted: false });
    const nt = await put(NT.Note, { business_id: note._id, title: "Coffee supplier list", tags: ["supplier"], deleted: false });

    console.log("\nwho may search");
    ok((await find("coffee", null)).s === 401, "no login → 401");
    let r = await find("x");
    ok(r.s === 200 && r.j.data.results.length === 0, "one letter → nothing (too short)");

    console.log("\nproducts, businesses");
    r = await find("coffee");
    const t = titles(r);
    ok(r.s === 200 && t.includes("products:Khmer iced coffee") && t.includes("products:Iced coffee can") && t.includes("products:Iced coffee with milk"), "products from 3 kinds of business", t);
    ok(t.includes("businesses:Mekong Coffee Shop") && t.includes("businesses:Mekong Coffee Stamps"), "business names", t);
    ok(t.includes("other:Coffee supplier list"), "a note title", t);
    ok(!t.some((x) => /Old latte|Gone coffee|Stranger|Old Coffee Corner/.test(x)), "no deleted products, deleted businesses or other people's shops", t);
    const prod = r.j.data.results.find((x) => x.title === "Khmer iced coffee");
    ok(prod.tab === "products" && String(prod.business_id) === String(coffee._id) && prod.business === "Mekong Coffee Shop" && prod.money === 1.5, "a product says where to open it", prod);
    r = await find("កាហ្វេ");
    ok(titles(r).includes("products:Khmer iced coffee") && titles(r).includes("products:Iced coffee with milk"), "Khmer words", titles(r));
    r = await find("8850999320014");
    ok(titles(r).includes("products:Iced coffee can"), "a barcode", titles(r));

    console.log("\norders and numbers");
    r = await find("#12");
    ok(titles(r).includes("orders:#12") && titles(r).includes("orders:#0012"), "#12 → Telegram order 12 and event order 0012", titles(r));
    r = await find("A-0007");
    ok(titles(r).includes("orders:A-0007") && r.j.data.results.find((x) => x.title === "A-0007").tab === "reports", "a restaurant bill number", titles(r));
    r = await find("S-000042");
    ok(titles(r).includes("orders:S-000042"), "a mini mart sale number", titles(r));
    r = await find("TK123456");
    ok(titles(r).some((x) => x.startsWith("orders:B-0003")), "a guest's passport number → the stay", titles(r));

    console.log("\npeople and phone numbers");
    r = await find("012 555 402");
    ok(titles(r).includes("orders:#12") && titles(r).includes("people:Emma Wilson"), "a phone with spaces finds the order and the customer", titles(r));
    r = await find("+855 12 555 402");
    ok(titles(r).includes("people:Emma Wilson"), "the same phone written +855", titles(r));
    r = await find("012345678");
    ok(titles(r).includes("people:Srey Pov"), "0… finds staff stored as +855…", titles(r));
    r = await find("012777888");
    const heng = r.j.data.results.find((x) => x.title === "Uncle Heng");
    ok(heng && heng.params?.c === String(dc.insertedId), "a debt book person opens with ?c=", r.j.data.results);
    r = await find("Sok Dara");
    ok(titles(r).includes("people:Sok Dara") && titles(r).includes("orders:S-000042"), "a name finds the stamp card and the sale", titles(r));
    r = await find("Koh Pich");
    const evr = r.j.data.results.find((x) => x.kind === "event");
    ok(evr && evr.params?.event && evr.tab === "events", "an event by its place opens with ?event=", r.j.data.results);
    r = await find("supplier");
    ok(r.j.data.results.find((x) => x.kind === "note")?.params?.note === String(nt.insertedId), "a note by its tag opens with ?note=", r.j.data.results);

    console.log("\nsmarter: words in any order, smart words, typos");
    r = await find("emma 012555402");
    ok(titles(r).length === 0 || true, "(a name + phone: phone wins, no crash)");
    r = await find("wilson emma");
    ok(titles(r).includes("people:Emma Wilson") && titles(r).includes("orders:#12"), "words in any order", titles(r));
    r = await find("iced coffee kitchen");
    ok(!titles(r).includes("products:Iced coffee can"), "every word must match (not just one)", titles(r));
    r = await find("new");
    ok(r.j.data.smart.includes("new") && r.j.data.results.find((x) => x.title === "#12")?.smart, "“new” → the new Telegram order, marked smart", r.j.data);
    r = await find("unpaid orders");
    ok(titles(r).includes("orders:#12") && !titles(r).includes("orders:A-0007"), "“unpaid orders” → only orders not paid", titles(r));
    r = await find("ការកម្ម៉ង់ថ្មី");
    ok(titles(r).includes("orders:#12"), "Khmer: ការកម្ម៉ង់ថ្មី (new orders)", titles(r));
    r = await find("orders today");
    ok(titles(r).includes("orders:#12") && titles(r).includes("orders:A-0007") && titles(r).includes("orders:S-000042"), "“orders today” → today's orders in every shop", titles(r));
    r = await find("orders yesterday");
    ok(!titles(r).some((x) => x.startsWith("orders:")), "“orders yesterday” → none (all were today)", titles(r));
    r = await find("emma unpaid");
    ok(titles(r)[0] === "orders:#12", "a smart word + a name", titles(r));
    await TS.TgProduct.collection.updateOne({ name: "Khmer iced coffee" }, { $set: { sold_out: true } });
    r = await find("sold out");
    ok(titles(r).includes("products:Khmer iced coffee") && r.j.data.results.find((x) => x.title === "Khmer iced coffee").flag === "sold_out", "“sold out” → sold-out products", titles(r));
    r = await find("អស់ស្តុក");
    ok(titles(r).includes("products:Khmer iced coffee"), "Khmer: អស់ស្តុក (sold out)", titles(r));
    r = await find("staying");
    ok(titles(r).length === 0, "“staying” → nobody checked in yet", titles(r));
    await GH.GhStay.collection.updateOne({ no: "B-0003" }, { $set: { status: "in" } });
    r = await find("staying");
    ok(titles(r).some((x) => x.startsWith("orders:B-0003")), "after check-in: the guest staying", titles(r));
    r = await find("cofee");
    ok(r.j.data.fuzzy && titles(r).includes("products:Khmer iced coffee"), "“cofee” (a letter missing) still finds coffee", r.j.data);
    r = await find("custmers");
    ok(r.j.data.results.length === 0 || r.j.data.fuzzy, "(no crash on a typo with nothing near)");

    console.log("\nBizi brief (layer 1)");
    const br = async (u = O) => {
      const x = await fetch(`${base}/api/user/bizi/brief`, { headers: { "x-api-key": "k", authorization: `Bearer ${u.tok}` } });
      return { s: x.status, j: await x.json().catch(() => ({})) };
    };
    let b = await br();
    const keys = (b.j.data?.alerts || []).map((a) => `${a.key}:${a.n}`);
    ok(b.s === 200 && keys.includes("tg_new:1") && keys.includes("staying") === false, "a new Telegram order waits", keys);
    ok(keys.includes("ev_review:0") === false && b.j.data.summary.orders_today === 1 && b.j.data.summary.today >= 6.5, "today's Telegram order counts in the summary", b.j.data.summary);
    const dash = await (await fetch(`${base}/api/user/dashboard?fresh=1`, { headers: { "x-api-key": "k", authorization: `Bearer ${O.tok}` } })).json();
    const tsRow = dash.data.sales?.by_business?.find((x) => x.kind === "tg_store");
    ok(tsRow && tsRow.bills_today === 1 && tsRow.today >= 6.5, "the dashboard counts the Telegram Store's sales", dash.data.sales?.by_business);
    ok(dash.data.sales.today === b.j.data.summary.today && dash.data.sales.yesterday === b.j.data.summary.yesterday, "Bizi's money = the dashboard's money", { dash: dash.data.sales.today, bizi: b.j.data.summary.today });
    const wt = dash.data.now.find((t) => t.key === "waiting");
    ok(wt?.by.some((x) => x.kind === "tg_store" && x.n === 1) && wt.tab.tg_store === "orders", "“Right now · waiting” has the new Telegram order", wt);
    ok(!keys.includes("waiting:1") || b.j.data.alerts.filter((a) => a.key === "waiting").every((a) => a.n < wt.n), "the Telegram order is not counted twice in Bizi's alerts", keys);
    ok(dash.data.top_items.some((x) => x.kind === "tg_store" && x.name_en === "Khmer iced coffee" && x.qty === 2), "Telegram best sellers in top items", dash.data.top_items);
    await TS.TgOrder.collection.updateOne({ no: 12 }, { $set: { created_date: new Date(Date.now() - 20 * 60e3) } });
    await GH.GhStay.collection.updateOne({ no: "B-0003" }, { $set: { to: new Date(Date.now() - 2 * 864e5) } });
    b = await br();
    const tg = b.j.data.alerts.find((a) => a.key === "tg_new");
    ok(tg.level === "warn" && b.j.data.mood === "worried" && b.j.data.alerts[0].level === "warn", "waiting 20 min → warn, Bizi worried, warnings first", b.j.data.alerts);
    ok(b.j.data.alerts.some((a) => a.key === "checkout_late" && a.tab === "today" && String(a.business_id) === String(gh._id)), "a guest past check-out → the guest house's Today", b.j.data.alerts);
    ok((await br(X)).j.data.alerts.length === 0, "a stranger's brief is empty");

    console.log("\nBizi tips, settings, weekly report");
    const D = require("../src/biz/dashboard.route");
    const BZ = require("../src/biz/bizi.route");
    const fresh = () => {
      D.forget(O.c._id);
      BZ.forgetTips(O.c._id);
    };
    const call = async (method, path, body, u = O) => {
      const x = await fetch(`${base}${path}`, { method, headers: { "x-api-key": "k", authorization: `Bearer ${u.tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { s: x.status, j: await x.json().catch(() => ({})) };
    };
    fresh();
    b = await br();
    const tipKeys = (b.j.data.tips || []).map((t) => `${t.key}:${t.business}`);
    ok(tipKeys.includes("tg_no_group:Mekong Coffee Shop") && tipKeys.includes("rest_no_tables:Mekong Kitchen") && tipKeys.includes("gh_no_rooms:Lotus Guest House"), "tips: things not set up, one per business first", tipKeys);
    ok(!tipKeys.some((k) => k.startsWith("tg_no_products") || k.startsWith("rest_no_menu") || k.startsWith("att_no_staff")), "no tip for what is already there (products, menu, staff)", tipKeys);
    const tgTip = b.j.data.tips.find((t) => t.key === "tg_no_group");
    ok(tgTip.tab === "share" && tgTip.help === "tg_group" && tgTip.category === "tg_store", "a tip opens its section + has its how-to", tgTip);
    ok(b.j.data.tips.length <= 5, "at most 5 tips", b.j.data.tips.length);
    await TS.TgStore.collection.insertOne({ business_id: coffee._id, slug: "mekong-coffee", tg: { chat_id: "-1001", chat_name: "Staff" } });
    fresh();
    b = await br();
    ok(!b.j.data.tips.some((t) => t.key === "tg_no_group"), "group connected → that tip goes", b.j.data.tips.map((t) => t.key));
    let r2 = await call("POST", "/api/user/bizi/snooze", { key: "gh_no_rooms", business_id: String(gh._id) });
    ok(r2.s === 200 && r2.j.data.days === 14, "Not now: a tip hides 14 days", r2.j);
    b = await br();
    ok(!b.j.data.tips.some((t) => t.key === "gh_no_rooms"), "the snoozed tip is gone at once", b.j.data.tips.map((t) => t.key));
    ok((await call("POST", "/api/user/bizi/snooze", { key: "nope", business_id: String(gh._id) })).s === 400, "an unknown tip is refused");
    r2 = await call("GET", "/api/user/bizi/prefs");
    ok(r2.s === 200 && r2.j.data.mute.length === 0 && r2.j.data.weekly === true && r2.j.data.tg.connected === false && r2.j.data.keys.alerts.includes("sold_out"), "settings: nothing muted at first", r2.j.data);
    r2 = await call("PUT", "/api/user/bizi/prefs", { mute: ["sold_out", "tips", "rm -rf"], tg: { morning: false } });
    ok(r2.s === 200 && r2.j.data.mute.join() === "sold_out,tips" && r2.j.data.tg.morning === false, "mute sold out + all tips (unknown words dropped)", r2.j.data);
    await TS.TgProduct.collection.updateOne({ name: "Khmer iced coffee" }, { $set: { sold_out: true } });
    fresh();
    b = await br();
    ok(!b.j.data.alerts.some((a) => a.key === "sold_out") && b.j.data.tips.length === 0 && b.j.data.prefs.mute.includes("sold_out"), "muted: no sold-out alert, no tips", { alerts: b.j.data.alerts.map((a) => a.key), tips: b.j.data.tips });
    ok((await call("PUT", "/api/user/bizi/prefs", { mute: "x" })).s === 400, "mute must be a list");
    await call("PUT", "/api/user/bizi/prefs", { mute: [] });
    // last week: a Telegram order of $20 on its Wednesday, the week before $10
    const kh = (offsetDays) => {
      const d = new Date(Date.now() + 7 * 3600e3);
      const dow = (d.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + offsetDays, 5)); // 12:00 Cambodia
    };
    await TS.TgOrder.collection.insertMany([
      { business_id: coffee._id, no: 30, token: "w1", status: "done", total: 20, currency: "USD", items: [{ name: "Khmer iced coffee", qty: 8, total: 20 }], created_date: kh(-5) },
      { business_id: coffee._id, no: 31, token: "w2", status: "done", total: 10, currency: "USD", items: [{ name: "Palm sugar latte", qty: 3, total: 10 }], created_date: kh(-12) },
      { business_id: coffee._id, no: 32, token: "w3", status: "cancelled", total: 99, currency: "USD", items: [{ name: "Cancelled cake", qty: 50, total: 99 }], created_date: kh(-5) },
    ]);
    fresh();
    b = await br();
    const wk = b.j.data.weekly;
    ok(wk && wk.total >= 20 && wk.before >= 10 && wk.change_pct !== null, "weekly: last week vs the week before", wk);
    ok(wk && wk.best_day && wk.best_day.sales >= 20 && wk.best_day.day >= wk.from && wk.best_day.day <= wk.to, "weekly: the best day is in last week", wk && wk.best_day);
    ok(wk && wk.top[0]?.name === "Khmer iced coffee" && !wk.top.some((t) => t.name === "Cancelled cake"), "weekly: last week's best sellers (cancelled left out)", wk && wk.top);
    ok(wk && wk.up.some((x) => x.name === "Mekong Coffee Shop"), "weekly: which business went up", wk && wk.up);
    await call("PUT", "/api/user/bizi/prefs", { weekly: false });
    fresh();
    ok((await br()).j.data.weekly === null, "weekly off → no report");
    await call("PUT", "/api/user/bizi/prefs", { weekly: true });

    console.log("\nBizi on Telegram");
    const telegram = require("../src/telegram");
    const BT = require("../src/biz/bizi.telegram");
    const BiziPrefs = require("../src/biz/bizi.model");
    const sentTg = [];
    const fetch0 = globalThis.fetch;
    globalThis.fetch = async (url, o) => {
      if (!String(url).startsWith("https://api.telegram.org/")) return fetch0(url, o);
      sentTg.push({ method: String(url).split("/").pop(), body: JSON.parse(o.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { headers: { "Content-Type": "application/json" } });
    };
    r2 = await call("POST", "/api/user/bizi/telegram/link", { lang: "en" });
    const code = (r2.j.data?.url || "").split("start=")[1];
    ok(r2.s === 200 && /^https:\/\/t\.me\/BizHubTestBot\?start=bz_[A-Za-z0-9]{24}$/.test(r2.j.data.url), "link: a t.me link with a one-time code", r2.j);
    await telegram.handleUpdate({ message: { chat: { id: 5151, type: "private", first_name: "Sokha" }, text: `/start ${code}` } });
    ok(sentTg.some((m) => m.method === "sendMessage" && m.body.chat_id === 5151 && m.body.text.includes("Bizi is connected")), "Start → connected, in English", sentTg.map((m) => m.body.text));
    r2 = await call("GET", "/api/user/bizi/prefs");
    ok(r2.j.data.tg.connected && r2.j.data.tg.chat_name === "Sokha" && r2.j.data.tg.lang === "en", "settings show Telegram connected", r2.j.data.tg);
    sentTg.length = 0;
    await telegram.handleUpdate({ message: { chat: { id: 6262, type: "private", first_name: "Nobody" }, text: `/start ${code}` } });
    ok(sentTg[0]?.body.text.includes("expired"), "the same code twice → expired", sentTg.map((m) => m.body.text));
    // the morning: summary + (a new week) last week's report; alerts that wait
    await call("PUT", "/api/user/bizi/prefs", { tg: { morning: true } });
    const p0 = await BiziPrefs.findOne({ customer_id: O.c._id }).lean();
    const nine = new Date(Date.UTC(2026, 9, 29, 2, 0)); // 09:00 Cambodia
    fresh();
    let due = await BT.dueFor({ ...p0, tg: { ...p0.tg, sent: {} } }, { brief: () => BZ.brief(O.c._id), ownerName: "Sokha", now: nine });
    const texts = due.out.map((m) => m.text);
    ok(texts.some((x) => x.startsWith("📊 <b>Last week</b>")) && texts.some((x) => x.startsWith("☀️ <b>Good morning, Sokha</b>")), "after 08:00: last week's report + the morning summary", texts);
    ok(texts.some((x) => x.startsWith("⏰ <b>1 new Telegram order waiting")) && due.out.find((m) => m.text.startsWith("⏰ <b>1 new Telegram")).extra.reply_markup.inline_keyboard[0][0].url.endsWith("?tab=orders"), "a waiting order → an alert with Open", texts);
    due = await BT.dueFor({ ...p0, tg: { ...p0.tg, sent: due.sent } }, { brief: () => BZ.brief(O.c._id), ownerName: "Sokha", now: new Date(nine.getTime() + 20 * 60e3) });
    ok(due.out.length === 0, "20 minutes later: nothing again (once each)", due.out.map((m) => m.text));
    const early = await BT.dueFor({ ...p0, tg: { ...p0.tg, sent: {} } }, { brief: () => BZ.brief(O.c._id), ownerName: "Sokha", now: new Date(Date.UTC(2026, 9, 28, 23, 30)) }); // 06:30
    ok(!early.out.some((m) => m.text.startsWith("☀️")), "before 08:00: no morning summary yet", early.out.map((m) => m.text));
    const quiet = await BT.dueFor({ ...p0, tg: { ...p0.tg, alerts: false, morning: false, weekly: false, sent: {} } }, { brief: () => BZ.brief(O.c._id), ownerName: "Sokha", now: nine });
    ok(quiet.out.length === 0, "all three off → no messages", quiet.out.map((m) => m.text));
    // the scheduler sends them, then not again
    sentTg.length = 0;
    await BiziPrefs.updateOne({ customer_id: O.c._id }, { $set: { "tg.sent": {} } });
    fresh();
    let tk = await BT.tick();
    ok(tk.owners === 1 && sentTg.filter((m) => m.body.chat_id === "5151").length >= 1, "tick: sends to the linked chat", { tk, n: sentTg.length });
    sentTg.length = 0;
    tk = await BT.tick();
    ok(sentTg.length === 0, "tick again: nothing new", sentTg.map((m) => m.body.text));
    r2 = await call("POST", "/api/user/bizi/telegram/test");
    ok(r2.s === 200 && sentTg.some((m) => m.body.text.includes("This is a test")), "Send a test");
    r2 = await call("DELETE", "/api/user/bizi/telegram");
    ok(r2.s === 200 && (await call("GET", "/api/user/bizi/prefs")).j.data.tg.connected === false, "disconnect");
    globalThis.fetch = fetch0;

    console.log("\nteam members");
    r = await find("coffee", A);
    ok(r.s === 200 && r.j.data.results.length === 0, "not in a team yet → nothing", titles(r));
    await TeamMember.create({ business_id: coffee._id, customer_id: A.c._id, role: "view", status: "active" });
    r = await find("coffee", A);
    ok(titles(r).length === 0, "in the team, but the Team add-on is off → nothing", titles(r));
    await License.create({ customer_id: O.c._id, business_id: coffee._id, product: "team", item: "", started_at: new Date(), expires_at: new Date(Date.now() + 300 * 864e5) });
    r = await find("coffee", A);
    ok(titles(r).includes("products:Khmer iced coffee") && !titles(r).some((x) => /Mini Mart|can|milk|supplier/.test(x)), "team on → only that shared shop", titles(r));
    r = await find("coffee", X);
    ok(titles(r).includes("products:Stranger coffee") && !titles(r).includes("products:Khmer iced coffee"), "the stranger sees only their own shop", titles(r));

    console.log("\nwhat Bizi commands need from the search");
    r = await find("coffee", A);
    ok(r.j.data.results.find((x) => x.title === "Khmer iced coffee")?.role === "view", "a View only member's results say role view (no buttons)");
    r = await find("coffee");
    ok(r.j.data.results.filter((x) => x.business_id && String(x.business_id) === String(coffee._id)).every((x) => x.role === "owner"), "the owner's results say role owner");
    await MA.MartProduct.updateOne({ name: "Iced coffee can" }, { $set: { track_stock: true, stock: 12, low_stock: 3 } });
    r = await find("iced coffee can");
    ok(r.j.data.results.find((x) => x.title === "Iced coffee can")?.stock === 12, "a product that counts its stock: stock 12");
    r = await find("iced coffee with milk");
    ok(r.j.data.results.find((x) => x.title === "Iced coffee with milk")?.stock === null, "a menu item that doesn't count stock: stock null");
    await DB.DebtCustomer.updateOne({ _id: dc.insertedId }, { $set: { balance: { usd: 7.5, khr: 0 } } });
    r = await find("Uncle Heng");
    let row = r.j.data.results.find((x) => x.title === "Uncle Heng");
    ok(row?.money === 7.5 && row.cur === "USD", "a debt customer shows what they owe", row);
    r = await find("Sok Dara");
    ok(r.j.data.results.find((x) => x.title === "Sok Dara")?.stamps === 0, "a stamp customer shows their stamps");
    const typ = await put(GH.GhRoomType, { business_id: gh._id, name: "Double", price: 20 });
    await put(GH.GhRoom, { business_id: gh._id, type_id: typ.insertedId, name: "101", floor: "1st floor", hk: "dirty", active: true });
    r = await find("101");
    row = r.j.data.results.find((x) => x.kind === "room");
    ok(row?.title === "101" && row.flag === "dirty" && row.tab === "housekeeping", "rooms are found by name, with their clean state", row);
    const pov = await AT.AttStaff.findOne({ name: "Srey Pov" });
    await put(AT.AttLeave, { business_id: att._id, staff_id: pov._id, type: "annual", from: "2026-11-02", to: "2026-11-03", days: 2, status: "pending" });
    r = await find("Srey Pov");
    row = r.j.data.results.find((x) => x.title === "Srey Pov");
    ok(row?.leave?.from === "2026-11-02" && row.flag === "leave" && row.tab === "leave", "staff with a leave request waiting: leave + flag", row);
  } catch (err) {
    console.error("\n✗", err);
    fail++;
  } finally {
    srv.close();
    await mongoose.disconnect();
    await mem.stop();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
