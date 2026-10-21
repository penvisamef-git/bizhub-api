// End-to-end test of waitlist, timed prices, promoters, group deals, duplicate, refunds + transfers, search + report, my tickets, feedback, calendar, sponsors, public events page
// on a throwaway in-memory database; Telegram and Bakong are faked (no message leaves the computer).
// Run once:  mkdir -p ~/evtest && cd ~/evtest && npm init -y && npm i mongodb-memory-server@10.1.4
// Then (from the bizhub-api folder):  NODE_PATH=~/evtest/node_modules node scripts/test-event-grow.js "$PWD"
const API = process.argv[2];
Object.assign(process.env, { NODE_ENV: "test", API_AUTH_KEY: "k", JWT_SECRET: "s", TELEGRAM_BOT_TOKEN: "TEST", TELEGRAM_BOT_USERNAME: "bizbot", WEB_URL: "https://site.test" });
const req = (p) => require(`${API}/${p}`);
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = req("node_modules/mongoose");
const express = req("node_modules/express");
const jwt = req("node_modules/jsonwebtoken");
const cl = req("src/util/cloudinary");
cl.uploadBuffer = async () => ({ url: "https://x/file.png", public_id: "p" + Math.random() });
cl.deleteFile = async () => {};
// fake Telegram
const tg = [];
let msgId = 100;
// fake Bakong: bk.next = what check_transaction_by_md5 answers
const bk = { calls: [], next: { responseCode: 1, errorCode: 1 } };
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
  if (String(url).includes("api.telegram.org")) {
    const method = String(url).split("/").pop();
    const body = opt.body instanceof FormData ? Object.fromEntries([...opt.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : JSON.parse(opt.body || "{}");
    tg.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "bizbot" } : { message_id: (msgId += 1) } }));
  }
  if (String(url).includes("api-bakong.nbc.gov.kh")) {
    bk.calls.push({ url, auth: opt.headers.Authorization, body: JSON.parse(opt.body) });
    return new Response(JSON.stringify(bk.next));
  }
  return realFetch(url, opt);
};
let pass = 0,
  fail = 0;
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
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const app = express();
  app.use(express.json());
  const { api_auth } = req("src/util/api_auth");
  const prop = { app, jwt, api_auth, jwt_auth: (q, s, n) => n(), request_user: (q, s, n) => n() };
  const telegram = req("src/telegram");
  req("src/biz/event")(prop);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const AuthKey = req("src/v1/admin/auth/auth_api_key.model");
  await AuthKey.create({ api_auth_key: "k" });
  const Customer = req("src/user/customer.model"),
    Sess = req("src/user/customer_session.model"),
    Business = req("src/biz/business.model"),
    License = req("src/license/license.model");
  const cust = await Customer.create({ name: "Owner", password: "x", status: true, deleted: false, email: "o@x.com", phone: "012345678" });
  const tok = jwt.sign({ type: "customer", id: String(cust._id) }, "s");
  await Sess.create({ customer_id: cust._id, access_token: tok, expires_at: new Date(Date.now() + 864e5) });
  const biz = await Business.create({ owner_id: cust._id, name: "Fest Co", category: "event", status: true, deleted: false });
  await License.create({ customer_id: cust._id, business_id: biz._id, product: "event", expires_at: null });
  const H = { "x-api-key": "k", "Content-Type": "application/json" };
  const call = async (m, p, body, h = {}) => {
    const r = await fetch(base + p, { method: m, headers: { ...H, ...h }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const own = (m, p, b) => call(m, `/api/user/businesses/${biz._id}/events${p}`, b, { authorization: `Bearer ${tok}` });
  const M = req("src/biz/event/event.models");
  const day = 864e5;
  const lic = (p, days, item = "") => License.create({ customer_id: cust._id, business_id: biz._id, product: p, item, expires_at: days ? new Date(Date.now() + days * day) : null });
  let r = await own("POST", "/pay-methods", { bank: "ABA", account_name: "Fest Co", link: "https://link.payway.com.kh/x" });
  const order = (slug, b) => call("POST", `/api/public/ev/e/${slug}/order`, { name: "Dara", phone: "012345678", ...b });
  const approveAll = async () => {
    for (const o of await M.EvOrder.find({ status: { $in: ["pending", "review"] } })) await own("POST", `/orders/${o._id}/approve`);
  };

  console.log("Timed prices (ev_pricing) + group deals (ev_bundles)");
  const early = new Date(Date.now() + 3 * day);
  const body = { title: "Gala", starts_at: new Date(Date.now() + 10 * day), status: "published", max_per_order: 20, types: [{ name: "GA", price: 20, qty: 6, tiers: [{ label: "Early bird", price: 15, until: early }], bundles: [{ qty: 4, price: 50 }] }] };
  r = await own("POST", "/events", body);
  ok(r.s === 402 && r.j.product === "ev_pricing", "timed prices need ev_pricing", r.j);
  await lic("ev_pricing");
  r = await own("POST", "/events", body);
  ok(r.s === 402 && r.j.product === "ev_bundles", "group deals need ev_bundles", r.j);
  await lic("ev_bundles");
  r = await own("POST", "/events", body);
  ok(r.s === 201 && r.j.data.types[0].now === 15 && r.j.data.types[0].tier.label === "Early bird", "early-bird price now $15", r.j.data?.types);
  let ev = r.j.data;
  const GA = ev.types[0].key;
  r = await call("GET", `/api/public/ev/e/${ev.slug}`);
  ok(r.j.data.types[0].now === 15 && r.j.data.types[0].bundles[0].qty === 4, "public page shows early-bird + 4-for deal", r.j.data.types[0]);
  r = await order(ev.slug, { lines: [{ key: GA, qty: 5 }] });
  let o1 = await M.EvOrder.findOne({ token: r.j.data.token }).lean();
  // 5 × $15 = 75; best mix: 4 for $50 + 1 × 15 = 65 → $10 off
  ok(o1.subtotal === 75 && o1.bundle_off === 10 && o1.total === 65 && o1.lines[0].price === 15, "5 tickets: $75 → 4-for-$50 deal → $65", o1);

  console.log("Waitlist (ev_waitlist)");
  r = await call("POST", `/api/public/ev/e/${ev.slug}/waitlist`, { name: "Sok", phone: "098765432" });
  ok(r.s === 404, "locked without the add-on");
  await lic("ev_waitlist");
  r = await call("POST", `/api/public/ev/e/${ev.slug}/waitlist`, { name: "Sok", phone: "098765432" });
  ok(r.s === 409 && r.j.code === "not_sold_out", "can't join while tickets are left", r.j);
  r = await order(ev.slug, { phone: "011111111", lines: [{ key: GA, qty: 1 }] });
  const last = r.j.data.token;
  r = await call("GET", `/api/public/ev/e/${ev.slug}`);
  ok(r.j.data.types[0].left === 0 && r.j.data.waitlist === true, "sold out (6/6 held)", r.j.data.types[0]);
  r = await call("POST", `/api/public/ev/e/${ev.slug}/waitlist`, { name: "Sok", phone: "098765432", qty: 1 });
  ok(r.s === 201 && /t\.me\/bizbot\?start=evw_/.test(r.j.data.tg_url) && r.j.data.ahead === 0, "joined the waitlist (with a Telegram link)", r.j);
  const W1 = r.j.data.token;
  const wcode = r.j.data.tg_url.split("start=")[1];
  await telegram.handleUpdate({ message: { chat: { id: 8001, type: "private", first_name: "Sok" }, text: `/start ${wcode}` } });
  ok((await M.EvWait.findOne({ token: W1 }).lean()).tg.chat_id === "8001", "waitlist linked to Telegram");
  r = await call("POST", `/api/public/ev/e/${ev.slug}/waitlist`, { name: "Sok", phone: "098765432" });
  ok(r.s === 409 && r.j.code === "already", "same phone twice refused");
  r = await call("POST", `/api/public/ev/e/${ev.slug}/waitlist`, { name: "Vy", phone: "097777777" });
  ok(r.s === 201 && r.j.data.ahead === 1, "second person: 1 ahead");
  tg.length = 0;
  // the last order is cancelled → 1 ticket back → the first person is told
  const lastO = await M.EvOrder.findOne({ token: last });
  await own("POST", `/orders/${lastO._id}/reject`, { reason: "no money" });
  await new Promise((ok_) => setTimeout(ok_, 300));
  ok(tg.some((m) => m.method === "sendMessage" && m.body.chat_id === "8001" && /Tickets are back/.test(m.body.text)), "first on the list told on Telegram", tg);
  r = await own("GET", `/events/${ev._id}/waitlist`);
  ok(r.j.data.counts.told === 1 && r.j.data.counts.waiting === 1, "only 1 told for 1 ticket; the other still waiting", r.j.data.counts);
  r = await call("GET", `/api/public/ev/w/${W1}`);
  ok(r.j.data.status === "told", "their waitlist page says told");

  console.log("Promoters (ev_referrals)");
  r = await own("POST", "/refs", { code: "dara", name: "Dara Influencer", commission: { kind: "percent", value: 10 } });
  ok(r.s === 402, "needs ev_referrals");
  await lic("ev_referrals", 365);
  r = await own("POST", "/refs", { code: "dara", name: "Dara Influencer", commission: { kind: "percent", value: 10 } });
  ok(r.s === 201 && r.j.data[0].code === "DARA", "promoter code made", r.j);
  const refId = r.j.data[0]._id;
  r = await own("POST", "/refs", { code: "DARA" });
  ok(r.s === 409, "same code twice refused");
  r = await own("POST", "/events", { title: "Concert", starts_at: new Date(Date.now() + 20 * day), status: "published", types: [{ name: "Seat", price: 10, qty: 100 }] });
  const ev2 = r.j.data;
  await call("POST", `/api/public/ev/e/${ev2.slug}/ref`, { code: "dara" });
  r = await order(ev2.slug, { lines: [{ key: ev2.types[0].key, qty: 3 }], ref: "dara" });
  await order(ev2.slug, { lines: [{ key: ev2.types[0].key, qty: 2 }] });
  await approveAll();
  r = await own("GET", "/refs");
  const rd = r.j.data[0];
  ok(rd.clicks === 1 && rd.orders === 1 && rd.tickets === 3 && rd.money === 30 && rd.earned === 3 && rd.owed === 3, "1 click, 1 order, 3 tickets, $30 → $3 commission", rd);
  r = await own("POST", `/refs/${refId}/payout`, { amount: 3 });
  ok(r.j.data[0].owed === 0 && r.j.data[0].paid_out === 3, "commission paid out");

  console.log("Duplicate");
  r = await own("POST", `/events/${ev._id}/duplicate`, { days: 7 });
  ok(r.s === 201 && r.j.data.status === "draft" && r.j.data.title === "Gala (copy)" && r.j.data.types[0].taken === 0 && r.j.data.slug !== ev.slug && new Date(r.j.data.starts_at) - new Date(ev.starts_at) === 7 * day && r.j.data.types[0].bundles.length === 1, "copy: draft, 7 days later, nothing sold, deals kept", r.j.data);

  console.log("Refunds + transfers");
  const paidO = await M.EvOrder.findOne({ event_id: ev2._id, ref: "DARA" });
  let tix = await M.EvTicket.find({ order_id: paidO._id }).sort({ no: 1 }).lean();
  r = await call("POST", `/api/public/ev/o/${paidO.token}/request`, { kind: "transfer", tickets: [tix[0].code], to_name: "Kanha", to_phone: "012000111" });
  ok(r.s === 201 && r.j.data.requests[0].status === "open", "buyer asks to transfer 1 ticket", r.j);
  r = await call("POST", `/api/public/ev/o/${paidO.token}/request`, { kind: "refund", tickets: [tix[1].code] });
  ok(r.s === 409 && r.j.code === "open", "one open request at a time");
  r = await own("GET", "/requests");
  ok(r.j.data.length === 1 && r.j.open === 1 && r.j.data[0].tickets[0].holder, "organiser sees the request", r.j);
  const rq = r.j.data[0];
  r = await own("POST", `/orders/${rq.order._id}/requests/${rq.request._id}`, { ok: true });
  const t0 = await M.EvTicket.findById(tix[0]._id).lean();
  ok(r.s === 200 && t0.holder === "Kanha" && t0.code !== tix[0].code && t0.transfers.length === 1, "transferred: new holder, new code (old QR dead)", t0);
  r = await call("GET", `/api/public/ev/t/${tix[0].code}`);
  ok(r.s === 404, "old ticket link no longer works");
  r = await call("POST", `/api/public/ev/o/${paidO.token}/request`, { kind: "refund", tickets: [tix[1].code], note: "sick" });
  r = await own("GET", "/requests");
  const rq2 = r.j.data[0];
  const before = (await M.EvEvent.findById(ev2._id).lean()).types[0].taken;
  r = await own("POST", `/orders/${rq2.order._id}/requests/${rq2.request._id}`, { ok: true });
  const after = (await M.EvEvent.findById(ev2._id).lean()).types[0].taken;
  ok(r.j.data.refunded === 10 && (await M.EvTicket.findById(tix[1]._id).lean()).status === "cancelled" && after === before - 1, "refund: ticket cancelled, back on sale, $10 noted", { ref: r.j.data.refunded, before, after });
  const t2 = tix[2];
  r = await own("POST", `/tickets/${t2._id}/transfer`, { name: "Bopha" });
  ok(r.s === 200 && r.j.data.holder === "Bopha", "organiser transfers a ticket directly");

  console.log("Search + all-events report");
  r = await own("GET", "/event-search?q=conc");
  ok(r.j.total === 1 && r.j.data[0].title === "Concert", "search finds by name", r.j);
  r = await own("GET", "/event-search?phase=draft");
  ok(r.j.total === 1, "drafts filter");
  r = await own("GET", "/report/overview?months=3");
  ok(r.s === 200 && r.j.data.series.length === 3 && r.j.data.totals.money > 0 && r.j.data.top[0].event.title && r.j.data.totals.refunded === 10, "report: 3 months, money, top events, refunds", r.j.data);

  console.log("My tickets");
  r = await call("POST", "/api/public/ev/my", { tokens: [paidO.token, o1.token, "nope"] });
  ok(r.s === 200 && r.j.data.length === 2 && r.j.data.every((x) => x.event.title), "device list: 2 orders found", r.j);
  await M.EvOrder.updateOne({ _id: paidO._id }, { $set: { "tg.chat_id": "9001" } });
  tg.length = 0;
  await telegram.handleUpdate({ message: { chat: { id: 9001, type: "private" }, text: "/mytickets" } });
  ok(tg.some((m) => m.body.chat_id === 9001 && /Concert/.test(m.body.text) && JSON.stringify(m.body.reply_markup).includes(`/ev/o/${paidO.token}`)), "Telegram /mytickets lists them", tg);

  console.log("Feedback (ev_feedback)");
  r = await own("PUT", `/events/${ev2._id}`, { feedback: { on: true, question: "What should we improve?" } });
  ok(r.s === 402, "needs ev_feedback");
  await lic("ev_feedback");
  r = await own("PUT", `/events/${ev2._id}`, { feedback: { on: true, question: "What should we improve?" } });
  ok(r.j.data.feedback.on && r.j.data.feedback.question, "feedback on");
  r = await call("POST", `/api/public/ev/f/${paidO.token}`, { rating: 5 });
  ok(r.s === 409, "closed before the event");
  await M.EvEvent.updateOne({ _id: ev2._id }, { $set: { starts_at: new Date(Date.now() - 8 * 3600000), ends_at: new Date(Date.now() - 3 * 3600000) } });
  tg.length = 0;
  const evtg = req("src/biz/event/event.telegram");
  const tk = await evtg.tick();
  const ask = tg.find((m) => m.body.chat_id === "9001" && /How was it/.test(m.body.text));
  ok(tk.more.feedback === 1 && ask && JSON.stringify(ask.body.reply_markup).includes(`evf:${paidO._id}:5`), "after the event: asked on Telegram with ⭐ buttons", tk);
  await telegram.handleUpdate({ callback_query: { id: "q1", data: `evf:${paidO._id}:4`, message: { chat: { id: 9001 } } } });
  r = await call("POST", `/api/public/ev/f/${paidO.token}`, { rating: 4, answer: "More food", comment: "Great show!" });
  r = await own("GET", `/events/${ev2._id}/feedback`);
  ok(r.j.data.n === 1 && r.j.data.avg === 4 && r.j.data.list[0].comment === "Great show!" && r.j.data.dist[3] === 1, "1 answer: 4 stars + comment", r.j.data);

  console.log("Calendar");
  const ics = await fetch(`${base}/api/public/ev/e/${ev.slug}/ics`, { headers: { "x-api-key": "k" } });
  const icsText = await ics.text();
  ok(ics.headers.get("content-type").includes("text/calendar") && icsText.includes("BEGIN:VEVENT") && icsText.includes("SUMMARY:Gala"), ".ics file", icsText.slice(0, 200));

  console.log("Sponsors (ev_sponsors)");
  const sp = async (b) => {
    const f = new FormData();
    f.append("file", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "a.png");
    for (const [k, v] of Object.entries(b)) f.append(k, v);
    const x = await fetch(`${base}/api/user/businesses/${biz._id}/events/events/${ev._id}/sponsors`, { method: "POST", headers: { "x-api-key": "k", authorization: `Bearer ${tok}` }, body: f });
    return { s: x.status, j: await x.json() };
  };
  r = await sp({ name: "Cellcard", tier: "main" });
  ok(r.s === 402, "needs ev_sponsors");
  await lic("ev_sponsors");
  r = await sp({ name: "Cellcard", tier: "main", link: "cellcard.com.kh" });
  ok(r.s === 201 && r.j.data.sponsors[0].tier === "main" && r.j.data.sponsors[0].logo && r.j.data.sponsors[0].link.startsWith("https://"), "sponsor added", r.j);
  r = await call("GET", `/api/public/ev/e/${ev.slug}`);
  ok(r.j.data.sponsors.length === 1, "sponsors on the public page");

  console.log("Public events page + featured");
  r = await call("GET", "/api/public/ev/discover");
  ok(r.s === 200 && r.j.data.length === 0, "not listed yet → nothing");
  r = await own("PUT", "/listing", { listed: true });
  ok(r.j.data.listed === true, "organiser shows their events");
  await own("PUT", `/events/${ev._id}`, { category: "music", city: "Phnom Penh" });
  await new Promise((ok_) => setTimeout(ok_, 50));
  await own("PUT", `/events/${ev._id}`, { category: "music", city: "Phnom Penh" });
  const ev3 = (await own("POST", "/events", { title: "Free Yoga", kind: "free", starts_at: new Date(Date.now() + 12 * day), status: "published", types: [{ name: "Spot", qty: 30 }] })).j.data;
  r = await own("POST", `/events/${ev3._id}/feature`);
  ok(r.s !== 404, "feature route (buying needs coins)", r.j);
  await M.EvEvent.updateOne({ _id: ev3._id }, { $set: { featured_until: new Date(Date.now() + 7 * day) } });
  r = await call("GET", "/api/public/ev/discover");
  const titles = r.j.data.map((e) => e.title);
  ok(r.s === 200 && titles[0] === "Free Yoga" && r.j.data[0].featured && titles.includes("Gala") && !titles.includes("Gala (copy)") && !titles.includes("Concert"), "listed: featured first, drafts + past hidden", titles);
  const gala = r.j.data.find((e) => e.title === "Gala");
  ok(gala.from === 15 && gala.city === "Phnom Penh" && gala.category === "music" && gala.org.name, "card: from $15 (early bird), city, category, organiser", gala);
  r = await call("GET", "/api/public/ev/discover?category=music");
  ok(r.j.data.length === 1, "category filter");
  r = await call("GET", "/api/public/ev/discover?q=yoga");
  ok(r.j.data.length === 1 && r.j.cities.includes("Phnom Penh"), "search + city list");

  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  await mem.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
