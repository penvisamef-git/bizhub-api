// Tests for Bizi for the BizHub team (v3.0.0): src/super_admin/bizi.route.js. In-memory database only.
// Run: NODE_PATH=…/node_modules node scripts/test-admin-bizi.js   (needs mongodb-memory-server)
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
  const AuthKey = require("../src/v1/admin/auth/auth_api_key.model");
  const User = require("../src/v1/admin/user/user.model");
  const Session = require("../src/v1/admin/session/session.model");
  const Customer = require("../src/user/customer.model");
  const Business = require("../src/biz/business.model");
  const P = require("../src/platform/platform.model");
  const AppError = require("../src/app_error/app_error.model");
  await AuthKey.create({ api_auth_key: "k" });

  const team = async (email, superAdmin) => {
    const id = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: id, firstname: "Team", lastname: email.split("@")[0], email, password: "x", is_super_admin: superAdmin, ...(superAdmin ? {} : { role: "staff" }), status: true, deleted: false });
    const tok = jwt.sign({ user_id: String(id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    await Session.collection.insertOne({ user_id: id, access_token: tok });
    return tok;
  };
  const SA = await team("boss@bizhub.test", true);
  const STAFF = await team("staff@bizhub.test", false);
  const sokha = await Customer.create({ name: "Sokha Chan", email: "sokha@test.com", phone: "+85512555401", password: "x", bizhub_id: "BH-437835" });
  const dara = await Customer.create({ name: "Dara Kim", email: "dara@test.com", phone: "+85512555402", password: "x", status: false });
  const old = await Customer.create({ name: "Old Customer", email: "old@test.com", password: "x" });
  await Customer.collection.updateOne({ _id: old._id }, { $set: { created_date: new Date(Date.now() - 5 * 864e5), delete_at: new Date(Date.now() + 3 * 864e5) } });
  const cafe = await Business.create({ owner_id: sokha._id, name: "Mekong Coffee Shop", category: "tg_store" });
  await Business.create({ owner_id: dara._id, name: "Lucky Mini Mart", category: "mart" });
  const o1 = await P.CoinOrder.create({ customer_id: sokha._id, coins: 100, total_coins: 110, usd: 10, reference: "ABA-778899", status: "pending" });
  await P.CoinOrder.create({ customer_id: dara._id, coins: 50, total_coins: 50, usd: 5, reference: "WING-1234", status: "approved", done_at: new Date() });
  const t1 = await P.SupportThread.create({ customer_id: dara._id, last_text: "How do I pair the POS?", unread_admin: 2 });
  await P.SupportThread.create({ customer_id: sokha._id, last_text: "Thanks!", unread_admin: 0 });
  await AppError.create({ fingerprint: "f1", message: "Null check operator used on a null value", route: "/biz/tgstore/123", version: "2.0.0+2", count: 3 });

  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (path, tok = SA) => {
    const r = await fetch(`${base}${path}`, { headers: { "x-api-key": "k", authorization: `Bearer ${tok}` } });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const find = (q, tok) => get(`/api/admin/bizi/search?q=${encodeURIComponent(q)}`, tok);
  const titles = (r) => (r.j.data?.results || []).map((x) => `${x.group}:${x.title}`);

  console.log("who can ask");
  ok((await find("sokha", STAFF)).s === 403, "a team member who is not the super admin → 403");
  ok((await get("/api/admin/bizi/search?q=x", "nope")).s === 401, "no login → 401");

  console.log("\nsearch");
  let r = await find("sokha");
  ok(r.s === 200 && titles(r).includes("people:Sokha Chan") && titles(r).includes("businesses:Mekong Coffee Shop"), "a name → the customer + their business", titles(r));
  const person = r.j.data.results.find((x) => x.kind === "person");
  ok(person.href === `/app/super-admin/customers?open=${sokha._id}` && person.sub.includes("BH-437835"), "the customer opens in Customers (with the BizHub ID)", person);
  ok(titles(r).some((t) => t.startsWith("orders:#")) && titles(r).includes("other:Sokha Chan"), "…and their coin orders + their chat", titles(r));
  r = await find("BH-437835");
  ok(titles(r)[0] === "people:Sokha Chan", "a BizHub ID", titles(r));
  r = await find("012555402");
  ok(titles(r).includes("people:Dara Kim"), "a phone typed 012… finds +85512…", titles(r));
  r = await find("+85512555402");
  ok(titles(r).includes("people:Dara Kim") && r.j.data.results.find((x) => x.title === "Dara Kim").flag === "locked", "a phone → the customer, marked locked", titles(r));
  r = await find("ABA-778899");
  ok(titles(r).length === 1 && r.j.data.results[0].kind === "coin_order" && r.j.data.results[0].status === "pending", "a transfer reference → that coin order", r.j.data.results);
  r = await find(`#${String(o1._id).slice(-6)}`);
  ok(r.j.data.results.some((x) => x.id === String(o1._id)), "#<end of the order id> → that order", titles(r));
  r = await find("mini mart");
  ok(titles(r).includes("businesses:Lucky Mini Mart") && r.j.data.results.find((x) => x.kind === "business").href.includes("businesses?open="), "a business name", titles(r));
  r = await find("null check");
  ok(titles(r).some((t) => t.startsWith("other:Null check")), "a crash report by its message", titles(r));

  console.log("\nsmart words");
  r = await find("pending");
  ok(r.j.data.smart.includes("pending") && r.j.data.results.length === 1 && r.j.data.results[0].href === "/app/super-admin/coin-orders?status=pending", "“pending” → the coin orders to check", r.j.data);
  r = await find("រង់ចាំ");
  ok(r.j.data.results.length === 1 && r.j.data.results[0].kind === "coin_order", "Khmer: រង់ចាំ", titles(r));
  r = await find("unread");
  ok(r.j.data.results.length === 1 && r.j.data.results[0].href === `/app/super-admin/inbox?t=${t1._id}` && r.j.data.results[0].flag === "unread_chat", "“unread” → the chat waiting for an answer", r.j.data.results);
  r = await find("new");
  ok(titles(r).includes("people:Sokha Chan") && !titles(r).includes("people:Old Customer"), "“new” → today's customers only", titles(r));

  console.log("\nbrief");
  const b = (await get("/api/admin/bizi/brief")).j.data;
  const keys = b.alerts.map((a) => `${a.key}:${a.n}`);
  ok(keys.includes("coin_orders:1") && keys.includes("chats:1") && keys.includes("app_errors:1") && keys.includes("delete_requests:1"), "alerts: orders to check, chats, crash reports, accounts to erase", keys);
  ok(b.mood === "worried" && b.alerts[0].level === "warn", "warnings first, Bizi worried", b.alerts);
  ok(b.summary.new_customers === 2 && b.summary.new_businesses === 2 && b.summary.sold_usd === 5 && b.summary.waiting === 1, "today: new customers / businesses, coins sold", b.summary);
  ok((await get("/api/admin/bizi/brief", STAFF)).s === 403, "brief: super admin only");

  srv.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
