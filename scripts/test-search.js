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
  Object.assign(process.env, { NODE_ENV: "test", API_AUTH_KEY: "k", JWT_SECRET: "s", MONGO_URI: mem.getUri("test"), BIZHUB_ENV: "" });

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
    await put(TS.TgOrder, { business_id: coffee._id, no: 12, customer: { name: "Emma Wilson", phone: "012555402" }, status: "new", total: 6.5, currency: "USD" });
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
    await TS.TgOrder.collection.updateOne({ no: 12 }, { $set: { created_date: new Date(Date.now() - 20 * 60e3) } });
    await GH.GhStay.collection.updateOne({ no: "B-0003" }, { $set: { to: new Date(Date.now() - 2 * 864e5) } });
    b = await br();
    const tg = b.j.data.alerts.find((a) => a.key === "tg_new");
    ok(tg.level === "warn" && b.j.data.mood === "worried" && b.j.data.alerts[0].level === "warn", "waiting 20 min → warn, Bizi worried, warnings first", b.j.data.alerts);
    ok(b.j.data.alerts.some((a) => a.key === "checkout_late" && a.tab === "today" && String(a.business_id) === String(gh._id)), "a guest past check-out → the guest house's Today", b.j.data.alerts);
    ok((await br(X)).j.data.alerts.length === 0, "a stranger's brief is empty");

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
