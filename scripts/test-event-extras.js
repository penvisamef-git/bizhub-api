// End-to-end test of Event Tickets add-ons (showtimes, seat map, promo codes, questions, Telegram for organisers + guests)
// on a throwaway in-memory database; Telegram is faked (no message leaves the computer).
// Run once:  mkdir -p ~/evtest && cd ~/evtest && npm init -y && npm i mongodb-memory-server@10.1.4
// Then (from the bizhub-api folder):  NODE_PATH=~/evtest/node_modules node scripts/test-event-extras.js "$PWD"
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
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
  if (String(url).includes("api.telegram.org")) {
    const method = String(url).split("/").pop();
    const body = opt.body instanceof FormData ? Object.fromEntries([...opt.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : JSON.parse(opt.body || "{}");
    tg.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "bizbot" } : { message_id: (msgId += 1) } }));
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
  await own("PUT", "/settings", { pay: { link: "https://link.payway.com.kh/x" } });
  const day = 864e5;
  const evBody = {
    title: "Fest",
    starts_at: new Date(Date.now() + 10 * day),
    status: "published",
    types: [
      { name: "Seat", price: 20, qty: 4 },
      { name: "GA", price: 5, qty: 10 },
    ],
    shows: [{ starts_at: new Date(Date.now() + 10 * day) }, { starts_at: new Date(Date.now() + 11 * day), label: "Sunday" }],
  };

  console.log("Add-ons are locked until bought");
  let r = await own("POST", "/events", evBody);
  ok(r.s === 402 && r.j.product === "ev_shows", "showtimes need ev_shows", r.j);
  for (const p of ["ev_shows", "ev_seats", "ev_promos", "ev_questions", "ev_telegram", "ev_guest_tg"]) await License.create({ customer_id: cust._id, business_id: biz._id, product: p, expires_at: p.endsWith("tg") || p === "ev_telegram" ? new Date(Date.now() + 365 * day) : null });
  r = await own("GET", "");
  ok(["ev_shows", "ev_seats", "ev_promos", "ev_questions", "ev_telegram", "ev_guest_tg"].every((k) => r.j.data.addons[k]?.active) && r.j.data.addons.ev_telegram.days === 365, "6 add-ons listed and active (Telegram ones yearly)", Object.keys(r.j.data.addons));

  console.log("Event with showtimes + seat map + questions");
  r = await own("POST", "/events", evBody);
  ok(r.s === 201 && r.j.data.shows.length === 2, "event with 2 showtimes", r.j);
  let ev = r.j.data;
  const [S1, S2] = ev.shows.map((s) => s.key);
  const SEAT = ev.types[0].key,
    GA = ev.types[1].key;
  r = await own("PUT", `/events/${ev._id}`, {
    seating: { on: true, sections: [{ key: "fl", name: "Floor", type_key: SEAT, rows: 2, cols: 3, blocked: ["A2"] }] },
    questions: [
      { label: "T-shirt size", kind: "choice", options: ["S", "M", "L"], required: true },
      { label: "Email", kind: "email" },
    ],
    ask_names: true,
  });
  ok(r.s === 200 && r.j.data.seating.on && r.j.data.questions.length === 2 && r.j.data.ask_names, "seat map (2×3, A2 blocked) + 2 questions + names", r.j);
  ev = r.j.data;
  const QS = ev.questions[0].key,
    QE = ev.questions[1].key;
  r = await call("GET", `/api/public/ev/e/${ev.slug}`);
  ok(r.j.data.shows.length === 2 && r.j.data.shows[0].left[SEAT] === 4 && r.j.data.seating.sections[0].rows === 2 && r.j.data.questions.length === 2, "public page: shows with tickets left, seat map, questions", r.j.data.shows);

  console.log("Ordering rules");
  const order = (b) => call("POST", `/api/public/ev/e/${ev.slug}/order`, { name: "Dara", phone: "012345678", ...b });
  r = await order({ lines: [{ key: GA, qty: 1 }], answers: { [QS]: "M" } });
  ok(r.s === 400 && r.j.code === "pick_show", "must choose a showtime");
  r = await order({ show: S1, lines: [{ key: SEAT, qty: 2 }], seats: ["fl:A1"], answers: { [QS]: "M" } });
  ok(r.s === 400 && r.j.code === "pick_seats", "one seat per seated ticket");
  r = await order({ show: S1, lines: [{ key: SEAT, qty: 1 }], seats: ["fl:A2"], answers: { [QS]: "M" } });
  ok(r.s === 400 && r.j.code === "bad_seat", "a blocked seat can't be bought");
  r = await order({ show: S1, lines: [{ key: SEAT, qty: 1 }], seats: ["fl:A1"] });
  ok(r.s === 400 && r.j.code === "need_answer", "required question must be answered");
  r = await order({ show: S1, lines: [{ key: SEAT, qty: 1 }], seats: ["fl:A1"], answers: { [QS]: "M", [QE]: "nope" } });
  ok(r.s === 400 && r.j.code === "bad_answer", "email answer is checked");

  console.log("Promo codes");
  r = await own("POST", "/promos", { code: "save10", kind: "percent", value: 10, max_uses: 1 });
  ok(r.s === 201 && r.j.data[0].code === "SAVE10", "code made (upper case)", r.j);
  const promoId = r.j.data[0]._id;
  r = await own("POST", "/promos", { code: "SAVE10" });
  ok(r.s === 409, "same code twice refused");
  r = await call("POST", `/api/public/ev/e/${ev.slug}/promo`, { code: "save10", lines: [{ key: SEAT, qty: 2 }] });
  ok(r.s === 200 && r.j.data.off === 4 && r.j.data.total === 36, "check: 10% of $40 = $4 off", r.j);
  r = await call("POST", `/api/public/ev/e/${ev.slug}/promo`, { code: "NOPE", lines: [{ key: SEAT, qty: 2 }] });
  ok(r.s === 400 && r.j.code === "promo_bad", "unknown code");

  console.log("Order A: show 1, 2 seats, names, answers, promo");
  r = await order({ show: S1, lines: [{ key: SEAT, qty: 2 }], seats: ["fl:A1", "fl:A3"], answers: { [QS]: "M", [QE]: "dara@mail.com" }, names: ["Dara", "Sok"], promo: "SAVE10" });
  ok(r.s === 201 && r.j.data.status === "pending", "order A placed", r.j);
  const A = r.j.data.token;
  let oA = await M.EvOrder.findOne({ token: A }).lean();
  ok(oA.subtotal === 40 && oA.total === 36 && oA.promo.code === "SAVE10" && oA.seats.length === 2 && oA.answers.length === 2 && oA.names[1] === "Sok", "subtotal 40 → total 36, seats, answers, names saved", oA);
  r = await order({ show: S1, lines: [{ key: SEAT, qty: 1 }], seats: ["fl:A1"], answers: { [QS]: "S" } });
  ok(r.s === 409 && r.j.code === "seat_taken", "seat A1 can't be sold twice for show 1");
  r = await call("GET", `/api/public/ev/e/${ev.slug}`);
  ok(r.j.data.shows[0].left[SEAT] === 2 && r.j.data.shows[1].left[SEAT] === 4, "stock per show: show 1 has 2 left, show 2 still 4", r.j.data.shows.map((s) => s.left));
  r = await order({ show: S2, lines: [{ key: SEAT, qty: 1 }], seats: ["fl:A1"], answers: { [QS]: "S" }, promo: "SAVE10" });
  ok(r.s === 400 && r.j.code === "promo_used", "promo used up (max 1)", r.j);
  r = await order({ show: S2, lines: [{ key: SEAT, qty: 1 }], seats: ["fl:A1"], answers: { [QS]: "S" } });
  ok(r.s === 201, "same seat A1 is free on show 2 → order B");
  const B = r.j.data.token;
  r = await call("GET", `/api/public/ev/e/${ev.slug}/seats?show=${S1}`);
  ok(r.j.data.taken.sort().join() === "fl:A1,fl:A3", "taken seats for show 1", r.j.data);

  console.log("Telegram for organisers");
  r = await own("POST", "/telegram/link");
  ok(r.s === 200 && /t\.me\/bizbot\?start=evo_/.test(r.j.data.url), "connect link", r.j);
  const code = r.j.data.url.split("start=")[1];
  await telegram.handleUpdate({ message: { chat: { id: 5001, type: "private", first_name: "Owner" }, text: `/start ${code}` } });
  r = await own("GET", "/telegram");
  ok(r.j.data.org.connected && r.j.data.org.chat_name === "Owner", "chat connected", r.j.data);
  tg.length = 0;
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "p.jpg");
  await fetch(`${base}/api/public/ev/o/${A}/proof`, { method: "POST", body: fd });
  const photo = tg.find((x) => x.method === "sendPhoto");
  ok(photo && String(photo.body.chat_id) === "5001" && /Order #/.test(photo.body.caption) && photo.body.reply_markup.inline_keyboard[0][0].callback_data.startsWith("evo:a:"), "screenshot sent with ✅ Approve / ❌ Reject", photo);
  tg.length = 0;
  await telegram.handleUpdate({ callback_query: { id: "cb1", data: `evo:a:${oA._id}`, message: { chat: { id: 9999 } }, from: { first_name: "Hacker" } } });
  oA = await M.EvOrder.findById(oA._id).lean();
  ok(oA.status === "review" && tg.some((x) => x.method === "answerCallbackQuery" && /Not allowed/.test(x.body.text)), "a button press from another chat is refused");
  tg.length = 0;
  await telegram.handleUpdate({ callback_query: { id: "cb2", data: `evo:a:${oA._id}`, message: { chat: { id: 5001 } }, from: { first_name: "Mony" } } });
  oA = await M.EvOrder.findById(oA._id).lean();
  ok(oA.status === "paid" && oA.decided_by.includes("Mony"), "Approve in Telegram → paid", oA.status);
  ok(tg.some((x) => x.method === "editMessageCaption" && /Approved/.test(x.body.caption)), "the message changes to ✅ Approved");
  const tA = await M.EvTicket.find({ order_id: oA._id }).sort({ no: 1 }).lean();
  ok(tA.length === 2 && tA[0].holder === "Dara" && tA[1].holder === "Sok" && tA[0].seat_label === "Floor · A1" && tA[0].show === S1 && tA[0].show_at, "tickets: a name each, seat label, showtime", tA.map((t) => [t.holder, t.seat_label, t.show]));
  await telegram.handleUpdate({ callback_query: { id: "cb3", data: `evo:a:${oA._id}`, message: { chat: { id: 5001 } }, from: { first_name: "Mony" } } });
  ok(tg.some((x) => x.method === "answerCallbackQuery" && /already/.test(x.body.text)), "pressing again: 'already paid'");

  console.log("Telegram for guests");
  r = await call("GET", `/api/public/ev/o/${A}`);
  ok(r.j.data.tg && /start=evg_/.test(r.j.data.tg.url) && !r.j.data.tg.linked, "order page offers 'Get tickets on Telegram'", r.j.data.tg);
  tg.length = 0;
  await telegram.handleUpdate({ message: { chat: { id: 777, type: "private", first_name: "Dara" }, text: `/start ${r.j.data.tg.url.split("start=")[1]}` } });
  const pics = tg.filter((x) => x.method === "sendPhoto" && String(x.body.chat_id) === "777");
  ok(pics.length === 2 && pics[0].body.photo === "<file>" && /Floor · A1/.test(pics[0].body.caption), "2 ticket QR pictures sent to the guest", pics.map((p) => p.body.caption));
  r = await call("GET", `/api/public/ev/o/${A}`);
  ok(r.j.data.tg.linked, "order shows Telegram linked");
  tg.length = 0;
  r = await own("POST", `/events/${ev._id}/updates`, { text: "Doors open at 18:00" });
  ok(r.s === 201 && r.j.sent === 1 && tg.some((x) => x.method === "sendMessage" && /Doors open/.test(x.body.text)), "live update reaches the guest", r.j.sent);
  r = await call("GET", `/api/public/ev/e/${ev.slug}`);
  ok(r.j.data.updates[0].text === "Doors open at 18:00", "update shows on the event page");
  tg.length = 0;
  const tick = req("src/biz/event/event.telegram").tick;
  const show1 = new Date(ev.shows[0].starts_at).getTime();
  let t = await tick(new Date(show1 - 20 * 3600000));
  ok(t.reminders === 1 && tg.some((x) => /Tomorrow/.test(x.body.text || "")), "reminder the day before", t);
  t = await tick(new Date(show1 - 19 * 3600000));
  ok(t.reminders === 0, "…only once");
  t = await tick(new Date(show1 - 1.5 * 3600000));
  ok(t.reminders === 1 && tg.some((x) => /Starting soon/.test(x.body.text || "")), "reminder 2 hours before", t);

  console.log("Door phone + showtimes");
  await own("POST", "/team", { name: "Mony", role: "manager", pin: "1234" });
  r = await own("POST", "/pair-code");
  r = await call("POST", "/api/evdoor/pair", { code: r.j.data.code });
  const dev = r.j.data.token;
  r = await call("POST", "/api/evdoor/login", { pin: "1234" }, { "x-ev-device": dev });
  const DH = { "x-ev-device": dev, "x-ev-session": r.j.data.session };
  r = await call("POST", "/api/evdoor/scan", { event_id: ev._id, code: tA[0].code, show: S2 }, DH);
  ok(r.j.data.result === "other_show", "ticket for show 1 scanned at show 2 → other show", r.j.data);
  r = await call("POST", "/api/evdoor/scan", { event_id: ev._id, code: tA[0].code, show: S1 }, DH);
  ok(r.j.data.result === "ok" && r.j.data.ticket.seat_label === "Floor · A1", "right show → OK, seat shown", r.j.data);

  console.log("Releasing: expired order, cancelled ticket");
  await M.EvOrder.updateOne({ token: B }, { $set: { hold_until: new Date(Date.now() - 1000) } });
  await own("GET", "/orders");
  r = await call("GET", `/api/public/ev/e/${ev.slug}/seats?show=${S2}`);
  ok(r.j.data.taken.length === 0, "expired order frees its seat", r.j.data);
  r = await call("GET", `/api/public/ev/e/${ev.slug}`);
  ok(r.j.data.shows[1].left[SEAT] === 4, "…and its stock on show 2");
  r = await own("POST", `/tickets/${tA[1]._id}/cancel`);
  r = await call("GET", `/api/public/ev/e/${ev.slug}/seats?show=${S1}`);
  ok(r.j.data.taken.join() === "fl:A1", "cancelled ticket frees seat A3", r.j.data);
  r = await call("GET", `/api/public/ev/e/${ev.slug}`);
  ok(r.j.data.shows[0].left[SEAT] === 3, "…and 1 stock on show 1");

  console.log("Report + editing guards");
  r = await own("GET", `/events/${ev._id}/report`);
  ok(r.j.data.totals.discount === 4 && r.j.data.promos[0].code === "SAVE10" && r.j.data.shows.length === 2 && r.j.data.shows[0].sold === 1, "report: promo discount, per show", { t: r.j.data.totals, s: r.j.data.shows });
  r = await own("PUT", `/events/${ev._id}`, { shows: [ev.shows[1]] });
  ok(r.s === 400 && r.j.code === "show_sold", "a show with tickets can't be removed");
  r = await own("PUT", `/events/${ev._id}`, { seating: { on: true, sections: [{ key: "fl", name: "Floor", type_key: SEAT, rows: 1, cols: 3 }] } });
  ok(r.s === 200, "shrinking the map is fine while sold seats stay (A1)");
  r = await own("PUT", `/events/${ev._id}`, { seating: { on: true, sections: [{ key: "fl", name: "Floor", type_key: SEAT, rows: 1, cols: 3, blocked: ["A1"] }] } });
  ok(r.s === 400 && r.j.code === "seats_sold", "a sold seat can't be blocked");
  r = await own("DELETE", `/promos/${promoId}`);
  ok(r.s === 200 && r.j.data.length === 0, "promo deleted");

  console.log("Several payment methods");
  r = await own("GET", "");
  ok(r.j.data.pay_methods.length === 1 && r.j.data.pay_methods[0].key === "m_main", "the old single payment became method #1", r.j.data.pay_methods);
  r = await own("POST", "/pay-methods", { bank: "ACLEDA", account_name: "FEST CO", account_no: "0001", link: "Pay: https://acleda.test/pay/x." });
  ok(r.s === 201 && r.j.data.pay_methods.length === 2 && r.j.data.pay_methods[1].link === "https://acleda.test/pay/x", "add ACLEDA (link cleaned)", r.j.data?.pay_methods);
  const AC = r.j.key;
  r = await own("POST", "/pay-methods", { bank: "Wing" });
  const WING = r.j.key;
  r = await own("POST", "/events", { title: "Only ACLEDA", starts_at: new Date(Date.now() + 5 * day), status: "published", types: [{ name: "GA", price: 8, qty: 20 }], pay_methods: [AC, "nope"] });
  ok(r.s === 201 && r.j.data.pay_methods.join() === AC, "event accepts only ACLEDA (unknown key dropped)", r.j.data?.pay_methods);
  const ev2 = r.j.data;
  r = await own("POST", "/events", { title: "Only Wing", starts_at: new Date(Date.now() + 5 * day), status: "published", types: [{ name: "GA", price: 8, qty: 20 }], pay_methods: [WING] });
  ok(r.s === 400 && r.j.code === "need_pay", "Wing has no QR / link yet → can't publish with only Wing");
  r = await call("POST", `/api/public/ev/e/${ev2.slug}/order`, { name: "Vy", phone: "012888999", lines: [{ key: ev2.types[0].key, qty: 2 }] });
  const C = r.j.data.token;
  r = await call("GET", `/api/public/ev/o/${C}`);
  ok(r.j.data.pays.length === 1 && r.j.data.pays[0].bank === "ACLEDA" && r.j.data.pay.bank === "ACLEDA", "buyer sees only ACLEDA", r.j.data.pays);
  const fd2 = new FormData();
  fd2.append("file", new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "p.jpg");
  fd2.append("pay_key", AC);
  tg.length = 0;
  await fetch(`${base}/api/public/ev/o/${C}/proof`, { method: "POST", body: fd2 });
  const oC = await M.EvOrder.findOne({ token: C }).lean();
  ok(oC.pay_key === AC && oC.pay_label === "ACLEDA", "the order remembers it was paid with ACLEDA");
  ok(tg.some((x) => x.method === "sendPhoto" && /💳 ACLEDA/.test(x.body.caption)), "…and Telegram shows 💳 ACLEDA");
  r = await own("GET", `/orders?pay=${AC}`);
  ok(r.j.data.length === 1 && r.j.summary.review.n === 1 && r.j.summary.review.money === 16, "filter orders by payment method + summary numbers", r.j.summary);
  r = await own("GET", `/orders?event=${ev._id}&show=${S1}`);
  ok(r.j.data.length >= 1 && r.j.data.every((o) => o.show === S1), "filter orders by showtime", r.j.data.map((o) => o.show));
  r = await own("GET", `/events/${ev._id}/telegram-guests`);
  ok(r.j.data.linked === 1, "Telegram guests of this event: 1", r.j.data);
  r = await own("GET", `/events/${ev2._id}/telegram-guests`);
  ok(r.j.data.linked === 0, "…and of the other event: 0 (updates go only to the chosen event)", r.j.data);
  r = await own("DELETE", `/pay-methods/${AC}`);
  ok(r.s === 200 && r.j.data.pay_methods.length === 2 && !(await M.EvEvent.findById(ev2._id).lean()).pay_methods.length, "deleting a method removes it from events too");

  console.log("Picture in 'My businesses'");
  const up = async (path) => {
    const f = new FormData();
    f.append("file", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "a.png");
    return (await fetch(`${base}/api/user/businesses/${biz._id}/events${path}`, { method: "POST", headers: { "x-api-key": "k", authorization: `Bearer ${tok}` }, body: f })).status;
  };
  await up(`/events/${ev._id}/poster`);
  ok((await Business.findById(biz._id).lean()).logo_url.startsWith("https://"), "no logo yet → the event poster shows");
  await up("/logo");
  ok((await Business.findById(biz._id).lean()).logo_url.startsWith("https://"), "organiser logo shows");
  await Business.updateOne({ _id: biz._id }, { $set: { logo_url: "" } });
  await own("GET", "");
  ok((await Business.findById(biz._id).lean()).logo_url.startsWith("https://"), "older businesses get their picture when the dashboard opens");

  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  await mem.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
