// Tests for Team access (v1.5): src/biz/team/*. In-memory database only.
// Run: node scripts/test-team.js   (needs mongodb-memory-server: NODE_PATH=…/node_modules)
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
  const Wallet = require("../src/coin/wallet.model");
  const coin = require("../src/coin/coin.service");
  const { TeamMember, TeamLink } = require("../src/biz/team/team.model");

  await AuthKey.create({ api_auth_key: "k" });
  const mkUser = async (email) => {
    const c = await Customer.create({ name: email.split("@")[0], email, phone: "+85512345678", password: "x", status: true, deleted: false });
    const tok = jwt.sign({ type: "customer", customer_id: String(c._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    await Sess.create({ customer_id: c._id, access_token: tok, expires_at: new Date(Date.now() + 3600e3) });
    return { c, tok };
  };
  const O = await mkUser("owner@test.com"); // the owner
  const A = await mkUser("admin@test.com"); // becomes Admin
  const V = await mkUser("viewer@test.com"); // becomes View only
  const X = await mkUser("stranger@test.com"); // nobody

  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, body, u) => {
    const r = await fetch(base + p, { method: m, headers: { "x-api-key": "k", "Content-Type": "application/json", ...(u ? { authorization: `Bearer ${u.tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const fund = async (u, n) => {
    const w = await coin.getCustomerWallet(u.c._id);
    await Wallet.updateOne({ _id: w._id }, { $set: { balance: n } });
  };
  const balance = async (u) => (await coin.getCustomerWallet(u.c._id)).balance;
  await coin.getTreasury();

  // a Mini Mart with its year paid
  const mart = await Business.create({ owner_id: O.c._id, name: "Lucky Mini Mart", category: "mart" });
  await License.create({ customer_id: O.c._id, business_id: mart._id, product: "mart", started_at: new Date(), expires_at: new Date(Date.now() + 300 * 86400e3) });
  const M = `/api/user/businesses/${mart._id}`;

  console.log("BizHub ID");
  const id1 = await call("GET", "/api/user/team/my-id", null, A);
  const id2 = await call("GET", "/api/user/team/my-id", null, A);
  ok(id1.s === 200 && /^BH-\d{6}$/.test(id1.j.data?.bizhub_id), "my-id makes a BH-123456 ID", id1);
  ok(id2.j.data?.bizhub_id === id1.j.data?.bizhub_id, "the same ID every time");
  const aId = id1.j.data.bizhub_id;
  const vId = (await call("GET", "/api/user/team/my-id", null, V)).j.data.bizhub_id;
  ok(aId !== vId, "two people, two IDs");

  console.log("Team add-on (5 coins / year)");
  let t = await call("GET", `${M}/team`, null, O);
  ok(t.s === 200 && t.j.data.license.active === false && t.j.data.price === 5, "owner sees Team locked, price 5", t.j);
  ok((await call("GET", `${M}/team`, null, X)).s === 404, "someone else can't open the team page");
  t = await call("POST", `${M}/team/members`, { bizhub_id: aId, role: "admin" }, O);
  ok(t.s === 402 && t.j.code === "team_locked", "can't invite before unlocking", t);
  await fund(O, 20);
  t = await call("POST", `${M}/licenses/team`, { expect: null }, O);
  ok(t.s === 200 && t.j.charged === 5 && t.j.data.active && t.j.data.days_left >= 364, "owner buys Team: 5 coins, a year", t.j);
  ok((await balance(O)) === 15, "owner's wallet 20 → 15");

  console.log("Invite by BizHub ID");
  t = await call("POST", `${M}/team/members`, { bizhub_id: "BH-000000", role: "view" }, O);
  ok(t.s === 404 && t.j.code === "no_user", "unknown ID → not found");
  t = await call("POST", `${M}/team/members`, { bizhub_id: (await call("GET", "/api/user/team/my-id", null, O)).j.data.bizhub_id, role: "view" }, O);
  ok(t.s === 400 && t.j.code === "self", "own ID refused");
  t = await call("POST", `${M}/team/members`, { bizhub_id: aId.toLowerCase().replace("-", " "), role: "admin" }, O);
  ok(t.s === 200 && t.j.data.members.length === 1 && t.j.data.members[0].status === "invited", "invite Admin (ID typed in any case / spacing)", t.j);
  ok((await call("POST", `${M}/team/members`, { bizhub_id: aId, role: "view" }, O)).j.code === "already", "the same person twice → already");
  ok((await call("POST", `${M}/team/members`, { bizhub_id: vId, role: "boss" }, O)).s === 400, "a made-up role is refused");

  ok((await call("GET", `${M}/mart`, null, A)).s === 404, "invited (not yet accepted) can't open it");
  let sh = await call("GET", "/api/user/team/shared", null, A);
  ok(sh.j.data.invites.length === 1 && sh.j.data.invites[0].name === "Lucky Mini Mart" && sh.j.data.invites[0].owner_name === "owner", "the invite shows in Shared with me", sh.j);
  const mid = sh.j.data.invites[0].member_id;
  ok((await call("POST", `/api/user/team/invites/${mid}/accept`, null, X)).s === 404, "someone else can't accept my invite");
  t = await call("POST", `/api/user/team/invites/${mid}/accept`, null, A);
  ok(t.s === 200 && t.j.data.accepted, "Admin accepts");
  sh = await call("GET", "/api/user/team/shared", null, A);
  ok(sh.j.data.businesses.length === 1 && sh.j.data.businesses[0].role === "admin" && sh.j.data.businesses[0].team_on, "now a shared business, role admin");

  console.log("Admin inside the business");
  t = await call("GET", `${M}/mart`, null, A);
  ok(t.s === 200, "Admin opens the Mini Mart", t.s);
  t = await call("PUT", `${M}/mart/settings`, { receipt_note: "Thank you" }, A);
  ok(t.s !== 403 && t.s !== 404, "Admin can change settings", t);
  t = await call("POST", `${M}/licenses/mart_staff`, { expect: null }, A);
  ok(t.s === 403 && t.j.code === "owner_only", "Admin can't buy add-ons", t.j);
  ok((await call("GET", `${M}/team`, null, A)).s === 404, "Admin can't manage the team");
  ok((await call("PUT", M, { name: "Hacked" }, A)).s === 404 && (await Business.findById(mart._id)).name === "Lucky Mini Mart", "Admin can't rename the business");
  ok((await call("DELETE", M, null, A)).s === 404 && !(await Business.findById(mart._id)).deleted, "Admin can't delete the business");
  ok((await balance(O)) === 15, "owner's coins untouched");

  console.log("Invite link (View only)");
  t = await call("POST", `${M}/team/links`, { role: "view" }, O);
  ok(t.s === 200 && /^[A-Z2-9]{6}$/.test(t.j.data.code), "owner makes a link", t.j);
  const code = t.j.data.code;
  t = await call("GET", `/api/user/team/join/${code.toLowerCase()}`, null, V);
  ok(t.s === 200 && t.j.data.business.name === "Lucky Mini Mart" && t.j.data.role === "view" && t.j.data.owner_name === "owner", "the link shows what it's for", t.j);
  ok((await call("POST", `/api/user/team/join/${code}`, null, O)).j.code === "owner", "the owner can't join their own business");
  t = await call("POST", `/api/user/team/join/${code}`, null, V);
  ok(t.s === 200 && t.j.data.role === "view", "viewer joins with the link", t.j);
  t = await call("POST", `/api/user/team/join/${code}`, null, X);
  ok(t.s === 410 && t.j.code === "link_gone", "the link works once", t);

  console.log("View only inside the business");
  ok((await call("GET", `${M}/mart`, null, V)).s === 200, "viewer opens the Mini Mart");
  t = await call("PUT", `${M}/mart/settings`, { receipt_note: "x" }, V);
  ok(t.s === 403 && t.j.code === "view_only", "viewer can't edit", t.j);
  t = await call("POST", `${M}/mart/products/import`, { rows: [{ name: "x", price: 1 }] }, V);
  ok(t.s === 403 && t.j.code === "view_only", "viewer can't create");
  ok((await call("POST", `${M}/licenses/mart_staff`, { expect: null }, V)).j.code === "owner_only", "viewer can't buy");
  ok((await call("GET", `${M}/mart`, null, X)).s === 404, "a stranger still can't open it");

  console.log("Owner manages");
  t = await call("GET", `${M}/team`, null, O);
  const vRow = t.j.data.members.find((m) => m.person.bizhub_id === vId);
  ok(t.j.data.members.length === 2 && vRow?.status === "active" && vRow.via === "link", "owner sees both members");
  t = await call("PATCH", `${M}/team/members/${vRow._id}`, { role: "admin" }, O);
  ok(t.s === 200, "owner makes the viewer an Admin");
  ok((await call("PUT", `${M}/mart/settings`, { receipt_note: "now ok" }, V)).s !== 403, "…and they can edit at once");
  await call("PATCH", `${M}/team/members/${vRow._id}`, { role: "view" }, O);
  t = await call("POST", `${M}/team/links`, { role: "admin" }, O);
  const lid = t.j.data._id;
  t = await call("DELETE", `${M}/team/links/${lid}`, null, O);
  ok(t.s === 200 && !t.j.data.links.some((l) => String(l._id) === String(lid)), "owner cancels a link");
  ok((await call("POST", `/api/user/team/join/${t.j.data.links[0]?.code || "NOPE00"}`, null, X)).s === 410, "a cancelled link doesn't work");
  t = await call("DELETE", `${M}/team/members/${vRow._id}`, null, O);
  ok(t.s === 200 && t.j.data.members.length === 1, "owner removes the viewer");
  ok((await call("GET", `${M}/mart`, null, V)).s === 404, "…their access stops at once");

  console.log("When the year ends");
  await License.updateOne({ business_id: mart._id, product: "team" }, { $set: { expires_at: new Date(Date.now() - 1000) } });
  require("../src/biz/team/team.access").forget();
  ok((await call("GET", `${M}/mart`, null, A)).s === 404, "Team expired → members can't open it");
  sh = await call("GET", "/api/user/team/shared", null, A);
  ok(sh.j.data.businesses[0]?.team_on === false, "Shared with me shows it as paused");
  ok((await TeamMember.countDocuments({ business_id: mart._id })) === 1, "the team list is kept for renewal");
  t = await call("POST", `${M}/licenses/team`, { expect: (await License.findOne({ business_id: mart._id, product: "team" })).expires_at }, O);
  require("../src/biz/team/team.access").forget();
  ok(t.s === 200 && (await call("GET", `${M}/mart`, null, A)).s === 200, "owner renews → Admin is back, no new invite");

  console.log("Leave + coins");
  t = await call("POST", `/api/user/team/shared/${mart._id}/leave`, null, A);
  ok(t.s === 200 && (await call("GET", `${M}/mart`, null, A)).s === 404, "a member can leave");
  await fund(A, 100);
  let threw = null;
  try {
    await coin.transfer({ from: await coin.getCustomerWallet(A.c._id), to: await coin.getTreasury(), amount: 5, customerId: A.c._id, type: "spend", businessId: mart._id });
  } catch (e) {
    threw = e;
  }
  ok(threw && threw.status === 403 && (await balance(A)) === 100, "coins can't be spent on someone else's business (central check)");
  ok((await TeamLink.countDocuments({ business_id: mart._id })) >= 2, "links are kept as records");

  srv.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
