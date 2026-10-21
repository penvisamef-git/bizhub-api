// End-to-end test of automatic KHQR payment (ev_autopay) + certificates & attendance (ev_certs)
// on a throwaway in-memory database; Telegram and Bakong are faked (no message leaves the computer).
// Run once:  mkdir -p ~/evtest && cd ~/evtest && npm init -y && npm i mongodb-memory-server@10.1.4
// Then (from the bizhub-api folder):  NODE_PATH=~/evtest/node_modules node scripts/test-event-autopay.js "$PWD"
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
  const khqr = req("src/util/khqr");
  const day = 864e5;
  console.log("KHQR string");
  const k0 = khqr.build({ bakongId: "fest@aba", name: "Fest Co", amount: 12.5, bill: "1001", store: "Fest", expiresAt: new Date(Date.now() + 9e5) });
  ok(k0.qr.startsWith("000201010212") && k0.qr.includes("5303840") && k0.qr.includes("540412.5") && k0.qr.includes("5802KH"), "dynamic USD KHQR with the exact amount", k0.qr);
  ok(khqr.crc16(k0.qr.slice(0, -4)) === k0.qr.slice(-4) && /^[0-9a-f]{32}$/.test(k0.md5), "CRC + md5 right");
  ok(khqr.isBakongId("fest@aba") && !khqr.isBakongId("fest") && !khqr.isBakongId("a b@x"), "Bakong ID check");

  console.log("Payment method with a Bakong ID");
  let r = await own("POST", "/pay-methods", { bank: "ABA", account_name: "Fest Co", link: "https://link.payway.com.kh/x" });
  const PM = r.j.data.pay_methods[0].key;
  r = await own("PUT", `/pay-methods/${PM}`, { bakong_id: "not an id" });
  ok(r.s === 400 && r.j.code === "bad_bakong", "wrong Bakong ID refused", r.j);
  r = await own("PUT", `/pay-methods/${PM}`, { bakong_id: "Fest@ABA" });
  ok(r.s === 200 && r.j.data.pay_methods[0].bakong_id === "fest@aba" && r.j.data.khqr_ready === false, "Bakong ID saved (lower case); Bakong not set up yet", r.j.data);
  r = await own("POST", "/events", { title: "Seminar", starts_at: new Date(Date.now() + 2 * day), status: "published", types: [{ name: "Seat", price: 12.5, qty: 50 }] });
  ok(r.s === 201, "event published", r.j);
  let ev = r.j.data;
  const order = () => call("POST", `/api/public/ev/e/${ev.slug}/order`, { name: "Dara", phone: "012345678", lines: [{ key: ev.types[0].key, qty: 2 }] });
  r = await order();
  const A = r.j.data.token;
  r = await call("GET", `/api/public/ev/o/${A}`);
  ok(r.s === 200 && r.j.data.khqr === null && r.j.data.pays[0].auto === false, "without the add-on: no automatic KHQR (screenshot as usual)", r.j.data.khqr);

  console.log("ev_autopay bought, but no BAKONG_TOKEN");
  await License.create({ customer_id: cust._id, business_id: biz._id, product: "ev_autopay", expires_at: new Date(Date.now() + 365 * day) });
  r = await own("GET", "");
  ok(r.j.data.addons.ev_autopay?.active && r.j.data.addons.ev_autopay.days === 365, "add-on active, yearly", r.j.data.addons.ev_autopay);
  r = await call("GET", `/api/public/ev/o/${A}`);
  ok(r.j.data.khqr === null, "still off until the token is set");
  r = await call("POST", `/api/public/ev/o/${A}/check`, {});
  ok(r.s === 200 && r.j.data.status === "pending" && bk.calls.length === 0, "check does nothing without a token");

  console.log("BAKONG_TOKEN set → automatic KHQR");
  process.env.BAKONG_TOKEN = "BK";
  r = await call("GET", `/api/public/ev/o/${A}`);
  const kq = r.j.data.khqr;
  ok(kq && kq.amount === 25 && kq.bakong_id === "fest@aba" && kq.qr.includes("540225") && r.j.data.pays[0].auto, "order page gets a KHQR for $25", kq);
  let oA = await M.EvOrder.findOne({ token: A }).lean();
  ok(oA.khqr.md5 && oA.khqr.qr === kq.qr, "QR + md5 kept on the order");
  r = await call("GET", `/api/public/ev/o/${A}`);
  ok(r.j.data.khqr.qr === kq.qr, "same QR next time (not made again)");
  r = await call("POST", `/api/public/ev/o/${A}/check`, {});
  ok(r.j.data.status === "pending" && bk.calls[0]?.body.md5 === oA.khqr.md5 && bk.calls[0].auth === "Bearer BK", "not paid yet → pending (asked Bakong with the md5)", bk.calls);
  bk.next = { responseCode: 0, data: { hash: "h-small", fromAccountId: "dara@wing", toAccountId: "fest@aba", amount: 20, currency: "USD" } };
  r = await call("POST", `/api/public/ev/o/${A}/check`, {});
  ok(r.j.data.status === "pending", "paid too little → stays pending");
  bk.next = { responseCode: 0, data: { hash: "h-other", fromAccountId: "dara@wing", toAccountId: "someone@aba", amount: 25, currency: "USD" } };
  r = await call("POST", `/api/public/ev/o/${A}/check`, {});
  ok(r.j.data.status === "pending", "paid to another account → stays pending");
  bk.next = { responseCode: 0, data: { hash: "abc123hash", fromAccountId: "dara@wing", toAccountId: "fest@aba", amount: 25, currency: "USD" } };
  r = await call("POST", `/api/public/ev/o/${A}/check`, {});
  ok(r.j.data.status === "paid", "paid → approved by itself", r.j);
  oA = await M.EvOrder.findOne({ token: A }).lean();
  ok(oA.decided_by === "KHQR (auto)" && oA.reference === "abc123hash" && /KHQR/.test(oA.pay_label), "who = KHQR (auto), reference = Bakong hash", oA);
  ok((await M.EvTicket.countDocuments({ order_id: oA._id })) === 2, "2 tickets made");
  r = await call("POST", `/api/public/ev/o/${A}/check`, {});
  ok(r.j.data.status === "paid", "checking again is harmless");

  console.log("Scheduler: buyer closed the page");
  bk.next = { responseCode: 1, errorCode: 1 };
  r = await order();
  const B = r.j.data.token;
  await call("GET", `/api/public/ev/o/${B}`);
  bk.next = { responseCode: 0, data: { hash: "hashB", toAccountId: "fest@aba", amount: 25, currency: "USD" } };
  const route = req("src/biz/event/event.route");
  const t1 = await route.autopayTick();
  ok(t1.paid === 1 && (await M.EvOrder.findOne({ token: B }).lean()).status === "paid", "the scheduler approved it", t1);
  const evtg = req("src/biz/event/event.telegram");
  const tk = await evtg.tick();
  ok(tk.autopay && tk.autopay.paid === 0, "tick runs autopay too", tk);

  console.log("Certificates & attendance");
  r = await own("PUT", `/events/${ev._id}`, { cert: { on: true } });
  ok(r.s === 402 && r.j.product === "ev_certs", "certificates need ev_certs", r.j);
  await License.create({ customer_id: cust._id, business_id: biz._id, product: "ev_certs", expires_at: null });
  r = await own("PUT", `/events/${ev._id}`, { cert: { on: true, title: "Certificate of Completion", signer: "Mr. Chan", signer_title: "Trainer", design: "royal" } });
  ok(r.s === 200 && r.j.data.cert.on && r.j.data.cert.who === "checked_in" && r.j.data.cert.design === "royal" && /\{name\}/.test(r.j.data.cert.body), "certificates on (checked-in guests, royal design, default text)", r.j.data.cert);
  ev = r.j.data;
  const tA = await M.EvTicket.find({ order_id: oA._id }).sort({ no: 1 }).lean();
  r = await call("GET", `/api/public/ev/c/${tA[0].code}`);
  ok(r.s === 200 && r.j.data.valid === false && r.j.data.waiting === true, "before check-in: not yet (waiting)", r.j.data);
  await M.EvTicket.updateOne({ _id: tA[0]._id }, { $set: { status: "used", used_at: new Date(), used_by: "Gate 1", holder: "Dara" } });
  r = await call("GET", `/api/public/ev/c/${tA[0].code}`);
  ok(r.j.data.valid === true && r.j.data.ticket.holder === "Dara" && r.j.data.cert.title === "Certificate of Completion" && r.j.data.event.title === "Seminar", "after check-in: a real certificate", r.j.data);
  r = await call("GET", `/api/public/ev/c/ZZZZZZZZ`);
  ok(r.s === 404, "unknown code → not found");
  r = await own("GET", `/events/${ev._id}/attendance`);
  ok(r.s === 200 && r.j.data.total === 4 && r.j.data.used === 1 && r.j.data.rows.find((x) => x.code === tA[0].code).used_by === "Gate 1", "attendance: 4 guests, 1 came", r.j.data);
  await M.EvOrder.updateOne({ _id: oA._id }, { $set: { "tg.chat_id": "7001" } });
  tg.length = 0;
  r = await own("POST", `/events/${ev._id}/certs/send`);
  const msg = tg.find((m) => m.method === "sendMessage");
  ok(r.s === 200 && r.j.sent === 1 && msg?.body.chat_id === "7001" && JSON.stringify(msg.body.reply_markup).includes(`/ev/c/${tA[0].code}`), "send now: 1 guest on Telegram gets the link (only the checked-in ticket)", { r: r.j, msg });
  ok(!JSON.stringify(msg.body.reply_markup).includes(tA[1].code), "the ticket that didn't come gets none");
  // after the event: the scheduler sends to those not sent yet
  await M.EvEvent.updateOne({ _id: ev._id }, { $set: { starts_at: new Date(Date.now() - 6 * 3600000), ends_at: new Date(Date.now() - 3600000) } });
  const oB = await M.EvOrder.findOne({ token: B });
  await M.EvOrder.updateOne({ _id: oB._id }, { $set: { "tg.chat_id": "7002" } });
  await M.EvTicket.updateMany({ order_id: oB._id }, { $set: { status: "used", used_at: new Date() } });
  tg.length = 0;
  const tk2 = await evtg.tick();
  ok(tk2.certs === 1 && tg.filter((m) => m.method === "sendMessage" && m.body.chat_id === "7002").length === 1 && !tg.some((m) => m.body.chat_id === "7001"), "after the event: the scheduler sends once, only to those not sent yet", { tk2, tg });
  const tk3 = await evtg.tick();
  ok(tk3.certs === 0, "…and never twice");
  r = await own("PUT", `/events/${ev._id}`, { cert: { who: "all" } });
  ok(r.j.data.cert.who === "all" && r.j.data.cert.title === "Certificate of Completion", "everyone with a ticket (keeps the title)", r.j.data.cert);
  r = await call("GET", `/api/public/ev/c/${tA[1].code}`);
  ok(r.j.data?.valid === true, "→ the guest who didn't come gets one too", r.j);

  console.log("Certificate designs + signature");
  r = await own("GET", "");
  ok(r.j.data.cert_themes.owned.join() === "classic,modern,royal" && r.j.data.cert_themes.price === 35, "3 free designs, others 35 coins", r.j.data.cert_themes);
  r = await own("PUT", `/events/${ev._id}`, { cert: { design: "ornate-emerald" } });
  ok(r.s === 402 && r.j.product === "ev_cert_theme" && r.j.item === "ornate-emerald", "a paid design must be bought first", r.j);
  r = await own("PUT", `/events/${ev._id}`, { cert: { design: "nope-x" } });
  ok(r.s === 400, "unknown design refused");
  await License.create({ customer_id: cust._id, business_id: biz._id, product: "ev_cert_theme", item: "ornate-emerald", expires_at: null });
  r = await own("PUT", `/events/${ev._id}`, { cert: { design: "ornate-emerald" } });
  ok(r.s === 200 && r.j.data.cert.design === "ornate-emerald" && r.j.data.cert.on, "bought → used (certificates stay on)", r.j.data.cert);
  r = await own("POST", `/cert-themes/medal-sky`, { event_id: ev._id });
  ok(r.s !== 404, "buy route exists", r.s);
  const f = new FormData();
  f.append("file", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "signature.png");
  let s2 = await fetch(`${base}/api/user/businesses/${biz._id}/events/events/${ev._id}/cert-signature`, { method: "POST", headers: { "x-api-key": "k", authorization: `Bearer ${tok}` }, body: f });
  let j2 = await s2.json();
  ok(s2.status === 200 && j2.data.cert.signature.startsWith("https://"), "signature uploaded", j2);
  r = await call("GET", `/api/public/ev/c/${tA[0].code}`);
  ok(typeof r.j.data.cert.signature === "string" && r.j.data.cert.signature.startsWith("https://") && !JSON.stringify(r.j.data).includes("public_id"), "certificate page gets the signature URL only", r.j.data.cert);
  r = await own("DELETE", `/events/${ev._id}/cert-signature`);
  ok(r.s === 200 && r.j.data.cert.signature === "", "signature removed");

  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  await mem.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
