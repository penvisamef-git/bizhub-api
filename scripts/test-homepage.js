// Tests for the homepage settings (v3.2.0: the "Follow us" channel links). In-memory database only.
// Run: NODE_PATH=…/node_modules node scripts/test-homepage.js   (needs mongodb-memory-server)
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
  const Homepage = require("../src/homepage/homepage.model");
  await AuthKey.create({ api_auth_key: "k" });
  const id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: id, firstname: "Black", lastname: "BizHub", email: "boss@bizhub.test", password: "x", is_super_admin: true, status: true, deleted: false });
  const tok = jwt.sign({ user_id: String(id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  await Session.collection.insertOne({ user_id: id, access_token: tok });

  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, auth = true) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "x-api-key": "k", "content-type": "application/json", ...(auth ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const LINKS = {
    tiktok_url: "https://www.tiktok.com/@bizhubcambodia",
    youtube_url: "https://www.youtube.com/@bizhubcambodia",
    coolapp_url: "https://channel.coolapp.com.kh/@bizhub_cambodia",
    tg_channel_url: "https://t.me/bizhub_cambodia",
  };

  try {
    console.log("the channels");
    let r = await call("GET", "/api/public/homepage", null, false);
    let c = r.j.data?.contact || {};
    ok(r.s === 200 && Object.entries(LINKS).every(([k, v]) => c[k] === v), "a new homepage has the 4 channel links", c);

    // a homepage saved before v3.2.0 (no channel fields): the public page still gets them
    await Homepage.collection.updateOne({ key: "main" }, { $unset: { "contact.tiktok_url": "", "contact.youtube_url": "", "contact.coolapp_url": "", "contact.tg_channel_url": "" }, $set: { "contact.facebook_url": "https://www.facebook.com/share/19qSkCvnPp/" } });
    r = await call("GET", "/api/public/homepage", null, false);
    c = r.j.data?.contact || {};
    ok(Object.entries(LINKS).every(([k, v]) => c[k] === v), "an older saved homepage gets the channel links too", c);
    ok(c.facebook_url === "https://www.facebook.com/share/19qSkCvnPp/" && c.telegram_url === "https://t.me/bizhubcambodia", "what was saved stays (Facebook, Telegram contact)");
    r = await call("GET", "/api/admin/homepage");
    ok(r.s === 200 && r.j.data?.contact?.coolapp_url === LINKS.coolapp_url, "Super admin sees them to edit");

    console.log("Super admin changes them");
    r = await call("PUT", "/api/admin/homepage", { contact: { youtube_url: "https://www.youtube.com/@bizhub-new", tiktok_url: "" } });
    ok(r.s === 200, "save: a new YouTube link, TikTok emptied", r.j.message);
    r = await call("GET", "/api/public/homepage", null, false);
    c = r.j.data.contact;
    ok(c.youtube_url === "https://www.youtube.com/@bizhub-new" && c.tiktok_url === "", "the public page has them (empty = the button is hidden)", c);
    ok(c.coolapp_url === LINKS.coolapp_url && c.facebook_url.includes("facebook.com"), "the others did not change");
    r = await call("PUT", "/api/admin/homepage", { contact: { coolapp_url: "coolapp bizhub" } });
    ok(r.s === 400 && /coolapp_url/.test(r.j.message), "not a link → refused", r.j.message);
    r = await call("PUT", "/api/admin/homepage", { contact: { tg_channel_url: "javascript:alert(1)" } });
    ok(r.s === 400, "javascript: is not a link → refused", r.j.message);
    r = await call("PUT", "/api/admin/homepage", { contact: { tiktok_url: LINKS.tiktok_url } }, false);
    ok(r.s === 401 || r.s === 403, "only the super admin can change them", r.s);
    console.log("Powered by (v3.3.0)");
    r = await call("GET", "/api/public/homepage", null, false);
    let pb = r.j.data?.powered_by || {};
    ok(pb.name === "Cyber Tech System" && pb.url === "https://ctscambodia.com/" && pb.on === true, "Powered by Cyber Tech System, ctscambodia.com", pb);
    await Homepage.collection.updateOne({ key: "main" }, { $unset: { powered_by: "" } });
    r = await call("GET", "/api/public/homepage", null, false);
    ok(r.j.data?.powered_by?.name === "Cyber Tech System", "an older saved homepage gets it too", r.j.data?.powered_by);
    r = await call("PUT", "/api/admin/homepage", { powered_by: { name: "CTS Cambodia", url: "https://ctscambodia.com/about" } });
    ok(r.s === 200, "Super admin changes the name and link", r.j.message);
    pb = (await call("GET", "/api/public/homepage", null, false)).j.data.powered_by;
    ok(pb.name === "CTS Cambodia" && pb.url === "https://ctscambodia.com/about" && pb.on === true, "the public page has them", pb);
    r = await call("PUT", "/api/admin/homepage", { powered_by: { on: false } });
    ok(r.s === 200 && (await call("GET", "/api/public/homepage", null, false)).j.data.powered_by.on === false, "it can be turned off");
    r = await call("PUT", "/api/admin/homepage", { powered_by: { url: "ctscambodia" } });
    ok(r.s === 400, "not a link → refused", r.j.message);
    r = await call("PUT", "/api/admin/homepage", { powered_by: { name: "x".repeat(61) } });
    ok(r.s === 400, "a name over 60 letters → refused", r.j.message);
  } catch (e) {
    console.error(e);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close();
  await mongoose.disconnect();
  await mem.stop();
  process.exit(fail ? 1 : 0);
})();
