// Tests for coin packs bought in the iPhone app (src/coin/apple.route.js + apple_store.js).
// In-memory database only; Apple's signed data is faked with our own root → intermediate → leaf chain (openssl),
// trusted only inside this test. Run: node scripts/test-apple-iap.js
//   needs mongodb-memory-server (NODE_PATH=…/node_modules) and the openssl command
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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

// ---------------------------------------------------------------- a fake "Apple" certificate chain
function makeChain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appletest-"));
  const run = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const conf = path.join(dir, "ext.cnf");
  fs.writeFileSync(
    conf,
    [
      "[root]",
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "[mid]",
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "1.2.840.113635.100.6.2.1=ASN1:NULL",
      "[leaf]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "1.2.840.113635.100.6.11.1=ASN1:NULL",
      "[plain]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "",
    ].join("\n"),
  );
  const key = (n) => run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${n}.key`);
  const csr = (n, cn) => run("req", "-new", "-key", `${n}.key`, "-subj", `/CN=${cn}`, "-out", `${n}.csr`);
  const sign = (n, ca, ext) => run("x509", "-req", "-in", `${n}.csr`, "-CA", `${ca}.pem`, "-CAkey", `${ca}.key`, "-CAcreateserial", "-days", "30", "-extfile", conf, "-extensions", ext, "-out", `${n}.pem`);
  key("root");
  run("req", "-x509", "-new", "-key", "root.key", "-subj", "/CN=Test Root", "-days", "30", "-config", conf, "-extensions", "root", "-out", "root.pem");
  for (const [n, cn] of [["mid", "Test WWDR"], ["leaf", "Test Signing"], ["plain", "No marker"]]) {
    key(n);
    csr(n, cn);
  }
  sign("mid", "root", "mid");
  sign("leaf", "mid", "leaf");
  sign("plain", "mid", "plain");
  // a second, untrusted root with the same shape
  key("evil");
  run("req", "-x509", "-new", "-key", "evil.key", "-subj", "/CN=Evil Root", "-days", "30", "-config", conf, "-extensions", "root", "-out", "evil.pem");
  key("emid");
  csr("emid", "Evil WWDR");
  sign("emid", "evil", "mid");
  key("eleaf");
  csr("eleaf", "Evil Signing");
  sign("eleaf", "emid", "leaf");
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  const der = (f) => new crypto.X509Certificate(read(f)).raw.toString("base64");
  const out = {
    rootFp: new crypto.X509Certificate(read("root.pem")).fingerprint256,
    good: { key: read("leaf.key"), x5c: [der("leaf.pem"), der("mid.pem"), der("root.pem")] },
    noMarker: { key: read("plain.key"), x5c: [der("plain.pem"), der("mid.pem"), der("root.pem")] },
    evil: { key: read("eleaf.key"), x5c: [der("eleaf.pem"), der("emid.pem"), der("evil.pem")] },
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function jws(payload, signer) {
  const head = b64u(JSON.stringify({ alg: "ES256", x5c: signer.x5c }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: signer.key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mem = await MongoMemoryServer.create();
  Object.assign(process.env, { NODE_ENV: "test", API_AUTH_KEY: "k", JWT_SECRET: "s", MONGO_URI: mem.getUri("test"), BIZHUB_ENV: "" });
  delete process.env.APPLE_IAP;
  delete process.env.APPLE_ALLOW_SANDBOX;
  delete process.env.APPLE_BUNDLE_ID;

  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  const app = require("../index");
  await new Promise((r) => (mongoose.connection.readyState === 1 ? r() : mongoose.connection.once("connected", r)));
  const Customer = require("../src/user/customer.model");
  const Sess = require("../src/user/customer_session.model");
  const AuthKey = require("../src/v1/admin/auth/auth_api_key.model");
  const Wallet = require("../src/coin/wallet.model");
  const { ApplePurchase } = require("../src/coin/apple_purchase.model");
  const apple = require("../src/coin/apple_store");

  console.log("Apple root certificate");
  const realRoot = new crypto.X509Certificate(apple.APPLE_ROOT_G3);
  ok(realRoot.fingerprint256 === apple.APPLE_ROOT_G3_SHA256, "the pinned PEM is Apple Root CA - G3 (fingerprint)");
  ok(realRoot.subject.includes("Apple Root CA - G3") && realRoot.verify(realRoot.publicKey), "self-signed Apple root, subject right");
  ok(apple.trust.roots.length === 1 && apple.trust.roots[0] === apple.APPLE_ROOT_G3_SHA256, "only Apple's root is trusted by default");

  const chain = makeChain();
  apple.trust.roots = [chain.rootFp]; // this test's root only

  await AuthKey.create({ api_auth_key: "k" });
  const mkUser = async (email) => {
    const c = await Customer.create({ name: email, email, password: "x", status: true, deleted: false, email_verified: true });
    const tok = jwt.sign({ type: "customer", id: String(c._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    await Sess.create({ customer_id: c._id, access_token: tok, expires_at: new Date(Date.now() + 3600e3) });
    return { c, tok };
  };
  const A = await mkUser("a@test.com");
  const B = await mkUser("b@test.com");

  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, body, tok) => {
    const r = await fetch(base + p, { method: m, headers: { "x-api-key": "k", "Content-Type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const balance = async (u) => (await Wallet.findOne({ key: `customer:${u.c._id}` }).lean())?.balance ?? 0;
  let n = 1000;
  const txn = (u, extra = {}) => ({
    transactionId: String(++n),
    originalTransactionId: String(n),
    bundleId: "com.bizhubcambodia.app",
    productId: "coins_250",
    purchaseDate: Date.now() - 1000,
    signedDate: Date.now() - 500,
    quantity: 1,
    type: "Consumable",
    appAccountToken: apple.accountUuid(u.c._id),
    environment: "Production",
    storefront: "KHM",
    price: 24990,
    currency: "USD",
    ...extra,
  });
  const verify = (u, payload, signer = chain.good, productId) => call("POST", "/api/user/coins/apple/verify", { productId: productId ?? payload.productId, jws: jws(payload, signer) }, u.tok);

  try {
    console.log("Packs");
    let r = await call("GET", "/api/user/coins/apple-packs", null, A.tok);
    ok(r.s === 200 && r.j.data.ready === true && r.j.data.packs.some((p) => p.product_id === "coins_250" && p.total_coins === 275), "packs: same ids + coins as Google Play", r.j);
    ok(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.j.data.account_ref) && r.j.data.account_ref === apple.accountUuid(A.c._id), "account_ref is a UUID for appAccountToken", r.j.data.account_ref);
    ok(apple.accountUuid(A.c._id) !== apple.accountUuid(B.c._id), "different accounts → different UUIDs");
    r = await call("GET", "/api/user/coins/apple-packs");
    ok(r.s === 401 || r.s === 403, "packs need login", r.s);

    console.log("Buy");
    const t1 = txn(A);
    r = await verify(A, t1);
    ok(r.s === 200 && r.j.data.coins_added === 275 && r.j.data.balance === 275, "valid purchase adds 250 + 25 free", r.j);
    ok((await balance(A)) === 275, "wallet has 275");
    const row = await ApplePurchase.findOne({ transaction_id: t1.transactionId }).lean();
    ok(row?.status === "credited" && row.environment === "Production" && row.usd === 25 && row.price === 24990 && row.storefront === "KHM", "purchase saved (credited, $25, storefront)", row);
    r = await verify(A, t1);
    ok(r.s === 200 && (await balance(A)) === 275, "same transaction again → coins only once", { s: r.s, b: await balance(A) });

    // two at the same time
    const t2 = txn(A, { productId: "coins_100" });
    const both = await Promise.all([verify(A, t2), verify(A, t2), verify(A, t2)]);
    await new Promise((x) => setTimeout(x, 300));
    ok((await balance(A)) === 375, "3 verifies at once → added once (+100)", { b: await balance(A), s: both.map((x) => x.s) });
    ok(both.some((x) => x.s === 200), "at least one answered 200");

    console.log("Refused");
    r = await verify(B, t1);
    ok(r.s === 409 && r.j.code === "other_user", "another account sends someone else's transaction → refused", r.j);
    r = await verify(B, txn(A));
    ok(r.s === 409 && r.j.code === "other_user", "appAccountToken of another account → refused", r.j);
    ok((await balance(B)) === 0, "B got nothing");
    r = await verify(A, txn(A, { bundleId: "com.someone.else" }));
    ok(r.s === 400 && r.j.code === "bad_token", "other app's bundle id → refused", r.j);
    r = await verify(A, txn(A), chain.evil);
    ok(r.s === 400 && r.j.code === "bad_token", "chain from an untrusted root → refused", r.j);
    r = await verify(A, txn(A), chain.noMarker);
    ok(r.s === 400 && r.j.code === "bad_token", "leaf without Apple's marker → refused", r.j);
    {
      const good = jws(txn(A, { productId: "coins_100" }), chain.good).split(".");
      const forged = b64u(JSON.stringify(txn(A, { productId: "coins_2500" })));
      r = await call("POST", "/api/user/coins/apple/verify", { productId: "coins_2500", jws: `${good[0]}.${forged}.${good[2]}` }, A.tok);
      ok(r.s === 400 && r.j.code === "bad_token", "payload changed after signing → refused", r.j);
    }
    r = await verify(A, txn(A), chain.good, "coins_2500");
    ok(r.s === 400 && r.j.code === "bad_token", "productId in the body ≠ signed productId → refused", r.j);
    r = await verify(A, txn(A, { productId: "coins_999" }));
    ok(r.s === 400 && r.j.code === "bad_product", "unknown pack → refused", r.j);
    r = await verify(A, txn(A, { type: "Non-Consumable" }));
    ok(r.s === 400 && r.j.code === "bad_product", "not a consumable → refused", r.j);
    r = await verify(A, txn(A, { revocationDate: Date.now(), revocationReason: 0 }));
    ok(r.s === 400 && r.j.code === "refunded", "already refunded transaction → refused", r.j);
    r = await call("POST", "/api/user/coins/apple/verify", { productId: "coins_100", jws: "abc.def.ghi" }, A.tok);
    ok(r.s === 400 && r.j.code === "bad_token", "garbage → refused", r.j);
    r = await verify(A, txn(A, { signedDate: Date.now() + 3600e3 }));
    ok(r.s === 400, "signed in the future → refused", r.j);
    ok((await balance(A)) === 375, "no refused try changed the wallet", await balance(A));

    console.log("Sandbox (App Review / TestFlight)");
    const ts = txn(A, { environment: "Sandbox", productId: "coins_100" });
    r = await verify(A, ts);
    const srow = await ApplePurchase.findOne({ transaction_id: ts.transactionId }).lean();
    ok(r.s === 200 && srow.environment === "Sandbox" && srow.usd === null, "sandbox allowed by default, saved as unpaid ($ null)", srow);
    process.env.APPLE_ALLOW_SANDBOX = "false";
    r = await verify(A, txn(A, { environment: "Sandbox" }));
    ok(r.s === 400 && r.j.code === "bad_token", "APPLE_ALLOW_SANDBOX=false → sandbox refused", r.j);
    delete process.env.APPLE_ALLOW_SANDBOX;
    process.env.APPLE_IAP = "off";
    r = await verify(A, txn(A));
    ok(r.s === 503 && r.j.code === "not_setup", "APPLE_IAP=off → closed", r.j);
    r = await call("GET", "/api/user/coins/apple-packs", null, A.tok);
    ok(r.j.data?.ready === false, "packs say not ready", r.j);
    delete process.env.APPLE_IAP;
    const before = await balance(A); // 475

    console.log("Refund notifications");
    const note = (type, t, signer = chain.good) => call("POST", "/api/public/apple/notifications", { signedPayload: jws({ notificationType: type, notificationUUID: crypto.randomUUID(), signedDate: Date.now() - 100, data: { bundleId: "com.bizhubcambodia.app", environment: "Production", signedTransactionInfo: jws(t, signer) } }, signer) });
    r = await note("REFUND", { ...t1, revocationDate: Date.now() - 50, revocationReason: 0, signedDate: Date.now() - 60 });
    ok(r.s === 200 && r.j.handled && r.j.reversed, "REFUND takes the 275 coins back", r.j);
    ok((await balance(A)) === before - 275, "wallet −275", await balance(A));
    const rrow = await ApplePurchase.findOne({ transaction_id: t1.transactionId }).lean();
    ok(rrow.status === "reversed" && rrow.reversed_coins === 275 && rrow.debt_coins === 0, "purchase marked reversed", rrow);
    r = await note("REFUND", { ...t1, revocationDate: Date.now() - 50, signedDate: Date.now() - 60 });
    ok(r.s === 200 && !r.j.reversed && (await balance(A)) === before - 275, "same refund again → taken once", r.j);
    r = await verify(A, t1);
    ok(r.s === 400 && r.j.code === "refunded", "refunded transaction can't be verified again", r.j);
    r = await note("REFUND", { ...t2, signedDate: Date.now() - 60 }, chain.evil);
    ok(r.s === 400, "notification signed by someone else → refused", r.j);
    r = await call("POST", "/api/public/apple/notifications", { signedPayload: jws({ notificationType: "TEST", signedDate: Date.now() - 100, data: { bundleId: "com.bizhubcambodia.app" } }, chain.good) });
    ok(r.s === 200 && r.j.handled === false, "TEST notification → 200, nothing done", r.j);
    // refund after the coins were spent: take what is there, the rest is debt
    const spender = await mkUser("c@test.com");
    const tc = txn(spender, { productId: "coins_500" });
    await verify(spender, tc);
    const coin = require("../src/coin/coin.service");
    await coin.transfer({ from: await coin.getCustomerWallet(spender.c._id), to: await coin.getTreasury(), amount: 500, note: "spent", customerId: spender.c._id });
    r = await note("REFUND", { ...tc, revocationDate: Date.now() - 50, signedDate: Date.now() - 60 });
    const crow = await ApplePurchase.findOne({ transaction_id: tc.transactionId }).lean();
    ok(r.s === 200 && crow.reversed_coins === 75 && crow.debt_coins === 500 && (await balance(spender)) === 0, "refund after spending: takes 75, records 500 debt", crow);
  } catch (err) {
    fail++;
    console.error(err);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  await mem.stop();
  process.exit(fail ? 1 : 0);
})();
