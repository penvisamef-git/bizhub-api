// "Try demo" in the BizHub POS app: link a device to a sample business, without a code or QR from an owner.
//   POST /api/public/pos-demo { kind, name?, mode?, device_id? }   → what that POS's own link gives, plus { demo: true, pin }
//     restaurant              { token, device }                         (same as /api/pos/pair)
//     mart | guest_house      { token, business }                       (same as /api/martpos|ghpos/pair)
//     event                   { token, org }                            (same as /api/evdoor/pair; then team PIN login)
//     tg_store                { token, shop }                           (same as /api/tspos/pair; then staff PIN login)
//     stamp_card              { slug, shop }                            (the staff desk link; then desk PIN login)
//     attendance mode=kiosk   { mode, token, business }                 (the door tablet link /k/<token>)
//     attendance mode=staff   { mode, code, token, business, phone }    (already logged in as the demo staff on device_id)
//
// The sample businesses belong to the demo account (POS_DEMO_EMAIL, default the store-review login made by
// scripts/demo-reviewer.js; their menu / products / rooms / staff / event come from scripts/demo-pos.js).
// Everybody who taps "Try demo" shares ONE demo device per business (its token is made from JWT_SECRET), so the
// demo never adds devices. The demo attendance staff moves to the phone that asked last (the one before is logged out).
// Bills, sales, shifts, stays and clock-ins older than 2 days are removed now and then, so the samples stay tidy.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { rate_limit } = require("../util/rate_limit");
const Customer = require("../user/customer.model");
const Business = require("./business.model");
const R = require("./restaurant/restaurant.models");
const MM = require("./mart/mart.models");
const G = require("./guesthouse/guesthouse.models");
const A = require("./attendance/attendance.models");
const S = require("./stamp/stamp.models");
const E = require("./event/event.models");
const TS = require("./tgstore/tgstore.models");

const KINDS = ["restaurant", "mart", "guest_house", "attendance", "stamp_card", "event", "tg_store"];
const DEMO_PIN = "1234"; // the demo staff PIN (shown in the app, so it is not a secret)
const DEMO_ATT_PHONE = "+85512000123"; // the demo attendance staff (log in with this phone + DEMO_PIN)
const KEEP_DAYS = 2;
const NOT_READY = "សាកល្បងមិនទាន់រួចរាល់ទេ សូមព្យាយាមម្តងទៀតពេលក្រោយ។ Demo is not available right now.";

const demoEmail = () => (process.env.POS_DEMO_EMAIL || "playreview@bizhubcambodia.com").toLowerCase();
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const tokenOf = (kind, bid) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET || "bizhub")
    .update(`pos-demo:${kind}:${bid}`)
    .digest("hex"); // 64 hex, the same shape as a real device token
// restaurant bill-number letter: A, B, … (the same as restaurant.pos.js)
const prefixOf = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
const ID_RE = /^[A-Za-z0-9-]{8,64}$/; // a phone's own id (the same rule as the attendance login)

// the demo business of one kind (null when the demo account or that business is missing)
async function demoShop(kind) {
  const owner = await Customer.findOne({ email: demoEmail(), deleted: false, status: true }).select("_id").lean();
  if (!owner) return null;
  return Business.findOne({ owner_id: owner._id, category: kind, deleted: false, status: true }).sort({ created_date: 1 }).lean();
}

// find the shared demo device (or make it); a demo device that someone unlinked is linked again
async function demoDevice(Model, kind, business, extra) {
  const token = tokenOf(kind, business._id);
  const token_hash = sha(token);
  let device = await Model.findOne({ token_hash });
  if (!device) device = await Model.create({ business_id: business._id, token_hash, last_seen: new Date(), ...(await extra()) });
  else if (device.revoked) {
    device.revoked = false;
    await device.save();
  }
  return { token, device };
}

class Off extends Error {}

// remove old demo bills / sales / shifts / stays / clock-ins (at most once an hour per server)
let lastClean = 0;
async function tidy(kind, bid, now = false) {
  if (!now && Date.now() - lastClean < 60 * 60 * 1000) return;
  lastClean = Date.now();
  const before = new Date(Date.now() - KEEP_DAYS * 864e5);
  const jobs = {
    restaurant: [R.RestOrder, R.RestShift, R.RestBooking, R.RestGuestOrder],
    mart: [MM.MartSale, MM.MartShift, MM.MartOrder],
    guest_house: [G.GhStay, G.GhExpense],
    attendance: [A.AttPunch],
    stamp_card: [],
    event: [],
    tg_store: [TS.TgOrder],
  };
  // tidy every demo business, not only the one opened now
  for (const k of KINDS) {
    const shop = k === kind ? { _id: bid } : await demoShop(k);
    if (!shop) continue;
    for (const Model of jobs[k]) await Model.deleteMany({ business_id: shop._id, created_date: { $lt: before } }).catch(() => {});
  }
}

// sample Telegram Store orders for the demo (as if customers ordered)
const SAMPLE = [
  { name: "Sok Dara", phone: "012555401", mode: "pickup", note: "Less sugar please" },
  { name: "Emma Wilson", phone: "012555402", mode: "delivery", address: "Street 240, house 12" },
  { name: "Chan Vanna", phone: "012555403", mode: "pickup", note: "" },
];
async function demoOrders(s, n) {
  const products = await TS.TgProduct.find({ business_id: s.business_id, deleted: false, hidden: false, sold_out: false }).sort({ sort: 1 }).limit(6).lean();
  if (!products.length) return;
  for (let i = 0; i < n; i += 1) {
    const who = SAMPLE[(Date.now() / 1000 + i) % SAMPLE.length | 0];
    const picks = [products[i % products.length], products[(i + 2) % products.length]].filter((p, k, a) => a.findIndex((x) => String(x._id) === String(p._id)) === k);
    const items = picks.map((p, k) => ({ product_id: p._id, name: p.name, price: p.price, qty: k + 1, options: [], note: "", total: Math.round(p.price * (k + 1) * 100) / 100 }));
    const subtotal = Math.round(items.reduce((a, l) => a + l.total, 0) * 100) / 100;
    const fee = who.mode === "delivery" ? 1 : 0;
    const seq = await TS.TgStore.findOneAndUpdate({ _id: s._id }, { $inc: { seq: 1 } }, { returnDocument: "after" }).select("seq").lean();
    await TS.TgOrder.create({
      business_id: s.business_id,
      no: seq.seq,
      token: crypto.randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 24),
      mode: who.mode,
      address: who.address || "",
      note: who.note,
      customer: { tg_id: "", username: "", name: who.name, phone: who.phone },
      items,
      subtotal,
      fee,
      total: Math.round((subtotal + fee) * 100) / 100,
      currency: s.currency || "USD",
      pay: { method: "cash", status: "unpaid" },
      timeline: [{ status: "new", at: new Date(), by: who.name }],
      via: "web",
    });
  }
}

// one answer per kind
const LINK = {
  async restaurant(business, b) {
    const { token, device } = await demoDevice(R.RestDevice, "restaurant", business, async () => ({
      name: b.name,
      kind: "app",
      prefix: prefixOf(await R.RestDevice.countDocuments({ business_id: business._id })),
    }));
    return { token, device: { _id: device._id, name: device.name, prefix: device.prefix, business_id: business._id } };
  },
  async mart(business, b) {
    const { token } = await demoDevice(MM.MartDevice, "mart", business, async () => ({ name: b.name }));
    return { token, business: { name: business.name, logo_url: business.logo_url || "" } };
  },
  async guest_house(business, b) {
    const { token } = await demoDevice(G.GhDevice, "guest_house", business, async () => ({ name: b.name }));
    return { token, business: { name: business.name, logo_url: business.logo_url || "" } };
  },
  async event(business, b) {
    const { token } = await demoDevice(E.EvDevice, "event", business, async () => ({ name: b.name }));
    const s = await E.EvSettings.findOne({ business_id: business._id }).lean();
    return { token, org: { name: s?.org_name || business.name, logo: s?.logo?.url || "" } };
  },
  // Telegram Store staff screen: the shared demo screen; a couple of orders waiting, so there is something to accept
  async tg_store(business, b) {
    const s = await TS.TgStore.findOne({ business_id: business._id });
    if (!s) throw new Off();
    const { token } = await demoDevice(TS.TgPosDevice, "tg_store", business, async () => ({ name: b.name }));
    const open = await TS.TgOrder.countDocuments({ business_id: business._id, status: { $in: ["new", "accepted", "ready", "on_way"] } });
    if (open < 2) await demoOrders(s, 3 - open);
    return { token, shop: { name: s.shop_name || business.name, logo: s.logo?.url || "", color: s.color || "", theme: s.theme || "" } };
  },
  async stamp_card(business) {
    const p = await S.StampProgram.findOne({ business_id: business._id }).lean();
    if (!p?.slug || !p.desk?.pin_hash || p.desk?.on === false) throw new Off();
    return { slug: p.slug, shop: { name: p.shop_name || business.name, logo: p.logo || "" } };
  },
  async attendance(business, b) {
    const shop = { name: business.name, logo_url: business.logo_url || "" };
    if (b.mode === "kiosk") {
      const branch = await A.AttBranch.findOne({ business_id: business._id, active: true, kiosk_token: { $gt: "" } }).sort({ sort: 1, created_date: 1 }).lean();
      if (!branch) throw new Off();
      return { mode: "kiosk", token: branch.kiosk_token, business: shop };
    }
    // staff phone: the demo staff moves to this phone (the phone before it is logged out)
    const deviceId = String(b.device_id || "");
    if (!ID_RE.test(deviceId)) throw Object.assign(new Error("device_id"), { status: 400 });
    const [settings, staff] = await Promise.all([A.AttSettings.findOne({ business_id: business._id }).lean(), A.AttStaff.findOne({ business_id: business._id, phone: DEMO_ATT_PHONE, active: true })]);
    if (!settings?.code || !staff) throw new Off();
    if (staff.device_id !== deviceId) {
      staff.set({ device_id: deviceId, device_label: "BizHub POS demo", device_at: new Date(), token_v: (staff.token_v || 0) + 1 });
      await staff.save();
    }
    const token = jwt.sign({ type: "att_staff", sid: String(staff._id), bid: String(business._id), d: deviceId, v: staff.token_v || 0 }, process.env.JWT_SECRET, { expiresIn: "30d" });
    return { mode: "staff", code: settings.code, token, business: shop, phone: DEMO_ATT_PHONE };
  },
};

module.exports = (prop) => {
  const limit = rate_limit({ windowMs: 10 * 60 * 1000, max: 30 });

  prop.app.post("/api/public/pos-demo", prop.api_auth, limit, async (req, res) => {
    try {
      const b = req.body || {};
      const kind = String(b.kind || "");
      if (!KINDS.includes(kind)) return res.status(400).json({ success: false, message: "kind" });
      const business = await demoShop(kind);
      if (!business) return res.status(503).json({ success: false, message: NOT_READY, code: "demo_off" });
      const name = String(b.name || "").trim().slice(0, 40) || "Demo";
      const data = await LINK[kind](business, { name, mode: b.mode === "kiosk" ? "kiosk" : "staff", device_id: b.device_id });
      tidy(kind, business._id).catch(() => {});
      res.json({ success: true, data: { ...data, demo: true, pin: DEMO_PIN } });
    } catch (err) {
      if (err instanceof Off) return res.status(503).json({ success: false, message: NOT_READY, code: "demo_off" });
      if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
      console.error("[pos-demo]", err);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  });
};

module.exports.DEMO_PIN = DEMO_PIN;
module.exports.DEMO_ATT_PHONE = DEMO_ATT_PHONE;
module.exports.demoShop = demoShop;
module.exports.tidy = tidy;
