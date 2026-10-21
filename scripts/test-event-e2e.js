// End-to-end test of Event Tickets on a throwaway in-memory database (never touches the real MongoDB).
// Run once:  mkdir -p ~/evtest && cd ~/evtest && npm init -y && npm i mongodb-memory-server@10.1.4
// Then (from the bizhub-api folder):  NODE_PATH=~/evtest/node_modules node scripts/test-event-e2e.js "$PWD"
const API = process.argv[2];
process.env.NODE_ENV = "test"; process.env.API_AUTH_KEY = "k"; process.env.JWT_SECRET = "s";
const req = (p) => require(`${API}/${p}`);
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = req("node_modules/mongoose");
const express = req("node_modules/express");
const jwt = req("node_modules/jsonwebtoken");
const cl = req("src/util/cloudinary");
cl.uploadBuffer = async () => ({ url: "https://x/proof.png", public_id: "p" + Math.random() });
cl.deleteFile = async () => {};
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m, extra !== undefined ? JSON.stringify(extra) : ""); } };
(async () => {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const app = express(); app.use(express.json());
  const { api_auth } = req("src/util/api_auth");
  req("src/biz/event")({ app, jwt, api_auth, jwt_auth: (q, s, n) => n(), request_user: (q, s, n) => n() });
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  await mongoose.connection.collection("authkeys").insertOne({ api_auth_key: "k" });
  const AuthKey = req("src/v1/admin/auth/auth_api_key.model"); await AuthKey.create({ api_auth_key: "k" });
  const Customer = req("src/user/customer.model"), Sess = req("src/user/customer_session.model"), Business = req("src/biz/business.model"), License = req("src/license/license.model");
  const cust = await Customer.create({ name: "Owner", password: "x", status: true, deleted: false, email: "o@x.com", phone: "012345678" });
  const tok = jwt.sign({ type: "customer", id: String(cust._id) }, "s");
  await Sess.create({ customer_id: cust._id, access_token: tok, expires_at: new Date(Date.now() + 864e5) });
  const biz = await Business.create({ owner_id: cust._id, name: "Show Co", category: "event", status: true, deleted: false });
  for (const p of ["event", "ev_cashier", "ev_invites"]) await License.create({ customer_id: cust._id, business_id: biz._id, product: p, expires_at: null });
  const H = { "x-api-key": "k", "Content-Type": "application/json" };
  const call = async (m, p, body, h = {}) => { const r = await fetch(base + p, { method: m, headers: { ...H, ...h }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const own = (m, p, b) => call(m, `/api/user/businesses/${biz._id}/events${p}`, b, { authorization: `Bearer ${tok}` });
  const M = req("src/biz/event/event.models");
  const taken = async (eid, key) => (await M.EvEvent.findById(eid).lean()).types.find((t) => t.key === key).taken;

  console.log("Owner setup");
  let r = await own("GET", ""); ok(r.s === 200, "dashboard loads", r.j);
  r = await own("POST", "/events", { title: "Rock Night", starts_at: new Date(Date.now() + 7 * 864e5), status: "published", types: [{ name: "Standard", price: 10, qty: 3 }] });
  ok(r.s === 400 && r.j.code === "need_pay", "can't publish a paid event without payment info");
  r = await own("PUT", "/settings", { pay: { link: "Pay here: https://link.payway.com.kh/abc123." , bank: "ABA" } }); ok(r.s === 200 && r.j.data.pay.link === "https://link.payway.com.kh/abc123", "pay link pasted from an ABA message", r.j.data?.pay);
  r = await own("POST", "/events", { title: "Rock Night", starts_at: new Date(Date.now() + 7 * 864e5), status: "published", types: [{ name: "Standard", price: 10, qty: 3 }, { name: "Gold", price: 25, qty: 2 }] });
  ok(r.s === 201, "event created", r.j); const ev = r.j.data; const S = ev.types[0].key, G = ev.types[1].key;

  console.log("Buying online");
  r = await call("GET", `/api/public/ev/e/${ev.slug}`); ok(r.s === 200 && r.j.data.sale === "open" && r.j.data.types.length === 2, "public event page", r.j);
  r = await call("POST", `/api/public/ev/e/${ev.slug}/order`, { name: "Dara", phone: "+855 12 345 678", lines: [{ key: S, qty: 2 }] });
  ok(r.s === 201 && r.j.data.status === "pending", "order A (2 Standard) waits for payment", r.j); const A = r.j.data.token;
  ok((await taken(ev._id, S)) === 2, "2 Standard held");
  r = await call("POST", `/api/public/ev/e/${ev.slug}/order`, { name: "Sok", phone: "0987654321", lines: [{ key: S, qty: 2 }] });
  ok(r.s === 409 && r.j.code === "sold_out", "can't oversell (only 1 left)", r.j);
  r = await call("POST", `/api/public/ev/e/${ev.slug}/order`, { name: "Sok", phone: "0987654321", lines: [{ key: S, qty: 1 }] });
  ok(r.s === 201, "order B (1 Standard)"); const B = r.j.data.token;
  const fd = new FormData(); fd.append("file", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "p.jpg"); fd.append("reference", "TX1");
  let pr = await fetch(`${base}/api/public/ev/o/${A}/proof`, { method: "POST", body: fd }); ok(pr.status === 200 && (await pr.json()).data.status === "review", "A sends the screenshot → review");
  r = await call("GET", `/api/public/ev/o/${A}`); ok(r.j.data.order.status === "review" && r.j.data.pay, "buyer sees 'checking'");
  const oA = await M.EvOrder.findOne({ token: A }).lean(), oB = await M.EvOrder.findOne({ token: B }).lean();
  r = await own("POST", `/orders/${oA._id}/approve`); ok(r.s === 200 && r.j.data.tickets.length === 2, "owner approves A → 2 tickets", r.j);
  const [t1, t2] = r.j.data.tickets;
  r = await call("GET", `/api/public/ev/o/${A}`); ok(r.j.data.order.status === "paid" && r.j.data.tickets.length === 2 && r.j.data.pay === null, "buyer sees tickets");
  r = await call("GET", `/api/public/ev/t/${t1.code}`); ok(r.s === 200 && r.j.data.ticket.status === "valid", "ticket page");

  console.log("Cancelling (the double give-back fix)");
  r = await own("POST", `/tickets/${t2._id}/cancel`); ok(r.s === 200, "cancel one ticket of A");
  ok((await taken(ev._id, S)) === 2, "Standard taken = 2 (A:1 + B:1)", await taken(ev._id, S));
  r = await own("POST", `/orders/${oA._id}/cancel`, { reason: "refund" }); ok(r.s === 200, "cancel the rest of A");
  ok((await taken(ev._id, S)) === 1, "Standard taken = 1 (B still held, not 0)", await taken(ev._id, S));

  console.log("Expired order, approved late");
  await M.EvOrder.updateOne({ _id: oB._id }, { $set: { hold_until: new Date(Date.now() - 1000) } });
  r = await own("GET", "/orders"); ok(r.j.data.find((o) => o.no === oB.no).status === "expired", "B expires, tickets go back");
  ok((await taken(ev._id, S)) === 0, "Standard taken = 0");
  r = await own("POST", `/orders/${oB._id}/approve`); ok(r.s === 200 && r.j.data.tickets.length === 1, "late approval still works", r.j);
  const tB = r.j.data.tickets[0];

  console.log("Turned-off type (gate / invite fix)");
  r = await own("PUT", `/events/${ev._id}`, { types: ev.types.map((t, i) => ({ ...t, active: i === 0 })) }); ok(r.s === 200, "Gold turned off for online sale");
  r = await call("GET", `/api/public/ev/e/${ev.slug}`); ok(r.j.data.types.length === 1, "public page hides Gold");
  r = await own("POST", `/events/${ev._id}/invites`, { name: "VIP Guest", phone: "012000111", key: G, qty: 1 }); ok(r.s === 201, "invite on Gold works", r.j);

  console.log("Door phone");
  r = await own("POST", "/team", { name: "Mony", role: "manager", pin: "1234" }); ok(r.s === 201, "team member added");
  r = await own("POST", "/team", { name: "Door2", role: "door", pin: "1234" }); ok(r.s === 409, "same PIN refused");
  r = await own("POST", "/pair-code"); const code = r.j.data.code;
  r = await call("POST", "/api/evdoor/pair", { code, name: "Gate 1" }); ok(r.s === 201, "phone paired", r.j); const dev = r.j.data.token;
  r = await call("POST", "/api/evdoor/pair", { code }); ok(r.s === 400, "pair code works once");
  r = await call("POST", "/api/evdoor/login", { pin: "9999" }, { "x-ev-device": dev }); ok(r.s === 401, "wrong PIN refused");
  r = await call("POST", "/api/evdoor/login", { pin: "1234" }, { "x-ev-device": dev }); ok(r.s === 200, "PIN login"); const DH = { "x-ev-device": dev, "x-ev-session": r.j.data.session };
  r = await call("GET", "/api/evdoor/boot", null, DH); ok(r.s === 200 && r.j.data.events.length === 1, "door sees the event", r.j);
  r = await call("POST", "/api/evdoor/scan", { event_id: ev._id, code: `https://site/ev/t/${tB.code}` }, DH); ok(r.j.data?.result === "ok", "scan B's ticket → OK", r.j);
  r = await call("POST", "/api/evdoor/scan", { event_id: ev._id, code: tB.code }, DH); ok(r.j.data?.result === "used", "scan again → already used");
  r = await call("POST", "/api/evdoor/scan", { event_id: ev._id, code: t2.code }, DH); ok(r.j.data?.result === "cancelled", "cancelled ticket → refused");
  r = await call("POST", "/api/evdoor/scan", { event_id: ev._id, code: "ZZZZZZZZZZ" }, DH); ok(r.j.data?.result === "not_found", "unknown code → not found");
  r = await call("POST", `/api/evdoor/events/${ev._id}/sell`, { lines: [{ key: G, qty: 1 }], method: "cash" }, DH); ok(r.s === 201 && r.j.data.tickets[0].status === "used", "gate sale of Gold (turned off online) works + checked in", r.j);
  r = await call("POST", "/api/evdoor/sync", { event_id: ev._id, scans: [{ code: t1.code, at: new Date().toISOString() }] }, DH); ok(r.j.data?.results[0].result === "cancelled", "offline sync reports a cancelled ticket", r.j);
  ok((await taken(ev._id, G)) === 2, "Gold taken = 2 (invite + gate)", await taken(ev._id, G));
  r = await call("POST", `/api/evdoor/events/${ev._id}/sell`, { lines: [{ key: G, qty: 1 }] }, DH); ok(r.s === 409, "Gold sold out at the gate too");

  console.log("Report + read-only license");
  r = await own("GET", `/events/${ev._id}/report`); ok(r.s === 200, "report"); console.log("    totals", JSON.stringify(r.j.data.totals));
  ok(r.j.data.totals.sold === 3 && r.j.data.totals.money === 35, "sold 3 (B $10 + gate $25 + invite $0) = $35", r.j.data.totals);
  await License.updateOne({ business_id: biz._id, product: "event" }, { $set: { expires_at: new Date(Date.now() - 864e5) } });
  r = await call("POST", `/api/public/ev/e/${ev.slug}/order`, { name: "Late", phone: "012999888", lines: [{ key: S, qty: 1 }] }); ok(r.s === 409, "expired license: no new online orders");
  r = await call("POST", `/api/evdoor/orders/${oB._id}/approve`, null, DH); ok(r.s === 402, "expired license: door manager can't approve (fix)", r.j);

  console.log("Ticket designs (15 coins each, forever)");
  await License.updateOne({ business_id: biz._id, product: "event" }, { $set: { expires_at: null } });
  const coin = req("src/coin/coin.service");
  const wallet = await coin.getCustomerWallet(cust._id);
  await mongoose.connection.collection(wallet.collection.collectionName).updateOne({ _id: wallet._id }, { $set: { balance: 20 } });
  r = await own("GET", ""); ok(r.j.data.themes.price === 15 && r.j.data.themes.owned.length === 1 && r.j.data.events[0].theme === "classic", "15 coins each, only Classic owned, event uses Classic", r.j.data.themes);
  r = await own("PUT", `/events/${ev._id}`, { theme: "neon-ruby" }); ok(r.s === 402 && r.j.product === "ev_theme", "can't use a design that isn't bought", r.j);
  r = await own("PUT", `/events/${ev._id}`, { theme: "nope" }); ok(r.s === 400, "unknown design refused");
  r = await own("POST", "/themes/classic", { event_id: ev._id }); ok(r.s === 400, "Classic can't be bought (free)");
  r = await own("POST", "/themes/neon-ruby", { event_id: ev._id }); ok(r.s === 200 && r.j.data.charged === 15 && r.j.balance === 5, "buy Neon · Ruby → 15 coins taken, 5 left", r.j);
  r = await call("GET", `/api/public/ev/e/${ev.slug}`); ok(r.j.data.theme === "neon-ruby", "event page now uses the design");
  r = await call("GET", `/api/public/ev/t/${tB.code}`); ok(r.j.data.event.theme === "neon-ruby", "ticket page uses the design");
  r = await call("GET", `/api/public/ev/o/${B}`); ok(r.j.data.event.theme === "neon-ruby", "order page uses the design");
  r = await own("POST", "/themes/neon-ruby", { event_id: ev._id }); ok(r.s === 200 && r.j.data.charged === 0, "buying it again costs nothing");
  r = await own("POST", "/events", { title: "Second Show", starts_at: new Date(Date.now() + 9 * 864e5), types: [{ name: "Free", price: 0, qty: 50 }], kind: "free", theme: "neon-ruby" }); ok(r.s === 201 && r.j.data.theme === "neon-ruby", "a bought design works on another event too", r.j);
  r = await own("POST", "/themes/vip-gold", { event_id: ev._id }); ok(r.s === 402 && r.j.code === "noCoins", "not enough coins for a second one (5 left)", r.j);
  r = await own("GET", ""); ok(r.j.data.themes.owned.includes("neon-ruby") && !r.j.data.themes.owned.includes("vip-gold") && r.j.data.events.find((e) => e._id === ev._id).theme === "neon-ruby", "failed buy changed nothing");
  r = await own("PUT", `/events/${ev._id}`, { theme: "classic" }); ok(r.s === 200 && r.j.data.theme === "classic", "switch back to Classic any time");

  console.log("Event page themes (25 coins each, forever)");
  await mongoose.connection.collection(wallet.collection.collectionName).updateOne({ _id: wallet._id }, { $set: { balance: 30 } });
  r = await own("GET", ""); ok(r.j.data.page_themes.price === 25 && r.j.data.page_themes.owned.length === 1 && r.j.data.events[0].page_theme === "standard", "25 coins each, only Standard owned", r.j.data.page_themes);
  r = await own("PUT", `/events/${ev._id}`, { page_theme: "aurora-violet" }); ok(r.s === 402 && r.j.product === "ev_page_theme", "can't use a page theme that isn't bought", r.j);
  r = await own("POST", "/page-themes/neon-ruby", { event_id: ev._id }); ok(r.s === 400, "a ticket design is not a page theme");
  r = await own("POST", "/page-themes/aurora-violet", { event_id: ev._id }); ok(r.s === 200 && r.j.data.charged === 25 && r.j.balance === 5, "buy Aurora · Violet → 25 coins taken", r.j);
  r = await call("GET", `/api/public/ev/e/${ev.slug}`); ok(r.j.data.page_theme === "aurora-violet" && r.j.data.theme === "classic", "event page uses the page theme (ticket design separate)", { p: r.j.data.page_theme, t: r.j.data.theme });
  r = await call("GET", `/api/public/ev/o/${B}`); ok(r.j.data.event.page_theme === "aurora-violet", "order page uses it");
  r = await own("POST", "/page-themes/cinema-coral", { event_id: ev._id }); ok(r.s === 402 && r.j.code === "noCoins", "not enough coins for another (5 left)");
  r = await own("GET", ""); ok(r.j.data.themes.owned.includes("neon-ruby") && r.j.data.page_themes.owned.includes("aurora-violet"), "both kinds kept separately");

  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  srv.close(); await mongoose.disconnect(); await mem.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
