// Sample data for "Try demo" in the BizHub POS app (see src/biz/pos_demo.js).
//
//   node scripts/demo-pos.js            → shows what it would add (nothing is written)
//   node scripts/demo-pos.js --yes      → adds it to PRODUCTION (.env.prod)
//   NODE_PATH=~/evtest/node_modules node scripts/demo-pos.js --test
//                                       → the whole thing on a throwaway in-memory database, then tests "Try demo"
//   … --test --capture=/tmp/pos-fixtures.json   also saves the POS answers for the app's store screenshots
//
// Fills the demo account's shops (scripts/demo-reviewer.js makes the account and the shops first):
//   Mekong Kitchen (restaurant): money, 2 zones + 12 tables, 4 categories, 16 dishes / drinks, an extras group, staff
//   Lucky Mini Mart (mart): 24 products with barcodes in 4 categories, staff (Cash, ABA, KHQR are the defaults)
//   Lotus Guest House (guest_house): 2 room types, 5 rooms, staff
//   Lucky Team (attendance, made here if missing): a branch with the door kiosk, 4 staff (demo staff +85512000123)
//   Mekong Coffee Stamps (stamp_card, made here if missing): the staff desk on (PIN 1234), 4 customers with stamps
//   Khmer New Year Party (event): a free event 30 days ahead with an Entry ticket, a door team member, 5 guests
//   Mekong Coffee Shop (tg_store, made here if missing): 2 categories, 8 products, pickup + delivery, cash,
//     the staff screen "Demo Manager" (manager, PIN 1234); "Try demo" adds a few orders to accept
// The staff on every shop is "Demo Manager" with PIN 1234 (the PIN the app shows on "Try demo").
// It goes through the owner API (the same checks as the website), and only adds what is missing, so it is
// safe to run again.
const path = require("path");
const test = process.argv.includes("--test");
const yes = process.argv.includes("--yes");
if (!test) require("dotenv").config({ path: path.join(__dirname, "..", ".env.prod"), override: true });

const EMAIL = (process.env.POS_DEMO_EMAIL || "playreview@bizhubcambodia.com").toLowerCase();
const PIN = "1234";
const STAFF = "Demo Manager";

const RESTAURANT = {
  settings: {
    name_en: "Mekong Kitchen",
    name_km: "ផ្ទះបាយមេគង្គ",
    type: "restaurant",
    phone: "012 345 679",
    address: "Sisowath Quay, Phnom Penh",
    hours: "7:00 – 22:00",
    currency: "USD",
    khr_rate: 4100,
    khr_rounding: 100,
    pay_mode: "after",
    receipt_footer: "Thank you! សូមអរគុណ!",
    payment_methods: [
      { name: "Cash", kind: "cash" },
      { name: "KHQR", kind: "qr" },
    ],
    mark_money_saved: true,
  },
  zones: [
    { name: "Inside", prefix: "T", from: 1, to: 8 },
    { name: "Terrace", prefix: "R", from: 1, to: 4 },
  ],
  extras: { name: "Extras", required: false, min: 0, max: 2, options: [ { name: "Fried egg", price: 0.5 }, { name: "Extra rice", price: 0.5 } ] }, // prettier-ignore
  categories: [
    {
      name_en: "Rice & Noodles", name_km: "បាយ និងមី", color: "#E0581A", extras: true, // prettier-ignore
      items: [
        ["Lok lak beef", "ឡុកឡាក់សាច់គោ", 5.5],
        ["Chicken fried rice", "បាយឆាសាច់មាន់", 3.5],
        ["Pork and rice", "បាយសាច់ជ្រូក", 2.5],
        ["Phnom Penh noodle soup", "គុយទាវភ្នំពេញ", 3],
        ["Khmer noodles", "នំបញ្ចុក", 2.5],
        ["Stir-fried morning glory", "ត្រកួនឆា", 2.5],
      ],
    },
    {
      name_en: "Soups & Curries", name_km: "សម្ល និងការី", color: "#2E7D32", // prettier-ignore
      items: [
        ["Fish amok", "អាម៉ុកត្រី", 6],
        ["Samlor korko", "សម្លកកូរ", 4.5],
        ["Sour fish soup", "សម្លម្ជូរត្រី", 5],
        ["Chicken curry", "ការីសាច់មាន់", 4.5],
      ],
    },
    {
      name_en: "Drinks", name_km: "ភេសជ្ជៈ", color: "#1A73E8", // prettier-ignore
      items: [
        ["Iced coffee with milk", "កាហ្វេទឹកដោះគោទឹកកក", 1.5, [ { name: "Regular", price: 1.5 }, { name: "Large", price: 2 } ]], // prettier-ignore
        ["Fresh coconut", "ដូងក្រអូប", 1.5],
        ["Lemon iced tea", "តែក្រូចឆ្មាទឹកកក", 1.25],
        ["Sugarcane juice", "ទឹកអំពៅ", 1],
        ["Water", "ទឹកសុទ្ធ", 0.5],
      ],
    },
    {
      name_en: "Desserts", name_km: "បង្អែម", color: "#C2185B", // prettier-ignore
      items: [
        ["Mango sticky rice", "បាយដំណើបស្វាយ", 2.5],
        ["Pumpkin custard", "សង់ខ្យាល្ពៅ", 2],
      ],
    },
  ],
};

// in-store EAN-13 barcodes (start with 2, never a real product's code)
const ean = (n) => {
  const d = `20${String(n).padStart(10, "0")}`;
  const sum = [...d].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return d + ((10 - (sum % 10)) % 10);
};
const MART_PRODUCTS = [
  ["Drinks", "Drinking water 500 ml", 0.3, 0.18],
  ["Drinks", "Drinking water 1.5 L", 0.6, 0.4],
  ["Drinks", "Iced coffee can", 0.8, 0.55],
  ["Drinks", "Orange juice 1 L", 2.2, 1.6],
  ["Drinks", "Green tea bottle", 0.7, 0.45],
  ["Drinks", "Soy milk 250 ml", 0.5, 0.32],
  ["Snacks", "Potato chips", 1.2, 0.8],
  ["Snacks", "Chocolate bar", 1, 0.65],
  ["Snacks", "Butter cookies", 2.5, 1.7],
  ["Snacks", "Instant noodles", 0.4, 0.25],
  ["Snacks", "Roasted peanuts", 0.9, 0.55],
  ["Snacks", "Rice crackers", 1.1, 0.7],
  ["Household", "Dish soap 500 ml", 1.8, 1.2],
  ["Household", "Laundry powder 1 kg", 3.5, 2.6],
  ["Household", "Tissue box", 1.3, 0.85],
  ["Household", "Garbage bags", 1.5, 0.95],
  ["Household", "AA batteries (4)", 2.8, 1.9],
  ["Household", "Candles (6)", 1.2, 0.7],
  ["Personal care", "Toothpaste", 1.6, 1.05],
  ["Personal care", "Shampoo 340 ml", 3.9, 2.8],
  ["Personal care", "Bath soap", 0.8, 0.5],
  ["Personal care", "Toothbrush", 1, 0.6],
  ["Personal care", "Hand cream", 2.9, 1.9],
  ["Personal care", "Sunscreen", 6.5, 4.6],
].map(([category, name, price, cost], i) => ({ category, name, price, cost, barcode: ean(1001 + i) }));

const GH = {
  types: [
    { name: "Standard Fan", price: 15, capacity: 2, beds: "1 double bed", amenities: ["fan", "wifi", "hot_water"], color: "#2563EB", rooms: [["101", "1"], ["102", "1"]] }, // prettier-ignore
    { name: "Deluxe AC", price: 25, capacity: 2, beds: "1 queen bed", amenities: ["ac", "wifi", "tv", "hot_water", "fridge"], color: "#7C3AED", rooms: [["201", "2"], ["202", "2"], ["203", "2"]] }, // prettier-ignore
  ],
};

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
  let mem;
  if (test) {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mem = await MongoMemoryServer.create();
    Object.assign(process.env, { NODE_ENV: "test", API_AUTH_KEY: "k", JWT_SECRET: "s", MONGO_URI: mem.getUri("prod"), BIZHUB_ENV: "" });
  } else {
    const dbName = process.env.MONGO_URI ? process.env.MONGO_URI.split("?")[0].split("/").pop() : process.env.MONGO_DB;
    if (process.env.BIZHUB_ENV !== "prod" || dbName !== "prod") {
      console.error(`Refusing: .env.prod must have BIZHUB_ENV=prod and the prod database (found ${process.env.BIZHUB_ENV} / ${dbName}).`);
      process.exit(1);
    }
  }

  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  const app = require("../index");
  await new Promise((r) => (mongoose.connection.readyState === 1 ? r() : mongoose.connection.once("connected", r)));
  const Customer = require("../src/user/customer.model");
  const Sess = require("../src/user/customer_session.model");
  const Business = require("../src/biz/business.model");
  const License = require("../src/license/license.model");
  const AuthKey = require("../src/v1/admin/auth/auth_api_key.model");

  if (test) {
    // what demo-reviewer.js makes: the account, the 3 shops, a year of license each
    await AuthKey.create({ api_auth_key: "k" });
    const c = await Customer.create({ name: "Google Play review", email: EMAIL, password: "x", status: true, deleted: false, email_verified: true });
    for (const [category, name] of [["restaurant", "Mekong Kitchen"], ["mart", "Lucky Mini Mart"], ["guest_house", "Lotus Guest House"], ["event", "Khmer New Year Party"]]) {
      const b = await Business.create({ owner_id: c._id, name, category, status: true, deleted: false });
      await License.create({ customer_id: c._id, business_id: b._id, product: category, started_at: new Date(), expires_at: new Date(Date.now() + 365 * 864e5) });
    }
  }

  const owner = await Customer.findOne({ email: EMAIL, deleted: false });
  if (!owner) {
    console.error(`No account ${EMAIL}. Run scripts/demo-reviewer.js first.`);
    process.exit(1);
  }
  const KINDS = ["restaurant", "mart", "guest_house", "attendance", "stamp_card", "event", "tg_store"];
  const findShops = async () => Object.fromEntries((await Business.find({ owner_id: owner._id, deleted: false, category: { $in: KINDS } }).sort({ created_date: 1 }).lean()).reverse().map((b) => [b.category, b]));
  let shops = await findShops();

  // a short owner login for this script (removed at the end)
  const tok = jwt.sign({ type: "customer", id: String(owner._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const sess = await Sess.create({ customer_id: owner._id, access_token: tok, expires_at: new Date(Date.now() + 3600e3) });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const H = { "x-api-key": process.env.API_AUTH_KEY, "Content-Type": "application/json" };
  const call = async (m, p, body, h = {}) => {
    const r = await fetch(base + p, { method: m, headers: { ...H, ...h }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { s: r.status, j };
  };
  const own = async (m, p, body) => {
    const r = await call(m, p, body, { authorization: `Bearer ${tok}` });
    if (r.s >= 400) throw new Error(`${m} ${p} → ${r.s} ${r.j.message || ""} ${JSON.stringify(r.j).slice(0, 200)}`);
    return r.j;
  };
  const plan = [];
  const write = test || yes;
  const doIt = async (what, fn) => {
    plan.push(what);
    if (write) await fn();
  };

  try {
    // ---------------- the businesses the reviewer account does not have yet (paid with its coins, like an owner) ----------------
    const MAKE = { attendance: { name: "Lucky Team", phone: "012 345 683", address: "Toul Kork, Phnom Penh" }, stamp_card: { name: "Mekong Coffee Stamps", phone: "012 345 684", address: "Riverside, Phnom Penh" }, tg_store: { name: "Mekong Coffee Shop", phone: "012 345 685", address: "Riverside, Phnom Penh" } };
    const coin = require("../src/coin/coin.service");
    const { priceOf } = require("../src/homepage/prices");
    const missingKinds = Object.keys(MAKE).filter((k) => !shops[k]);
    if (missingKinds.length) {
      const need = (await Promise.all([...missingKinds.map((k) => priceOf(k)), priceOf("att_kiosk")])).reduce((a, b) => a + (b || 0), 0);
      const wallet = await coin.getCustomerWallet(owner._id);
      const topUp = Math.max(0, need + 200 - wallet.balance);
      if (topUp > 0)
        await doIt(`coins: +${topUp} for the new demo businesses`, async () => {
          await coin.generate({ amount: topUp, note: `Demo coins for ${EMAIL} (POS store review)` });
          await coin.transfer({ from: await coin.getTreasury(), to: await coin.getCustomerWallet(owner._id), amount: topUp, note: "Demo coins (POS store review)", customerId: owner._id });
        });
      for (const k of missingKinds) await doIt(`new business: ${k} (${MAKE[k].name})`, () => own("POST", "/api/user/businesses", { ...MAKE[k], category: k }));
      if (write) shops = await findShops();
    }
    for (const k of KINDS) if (!shops[k]) console.log(`! no ${k} on ${EMAIL} (skipped)`);

    // ---------------- restaurant ----------------
    if (shops.restaurant) {
      const R = `/api/user/businesses/${shops.restaurant._id}/restaurant`;
      const ov = await own("GET", R);
      if (!ov.data.money_saved) await doIt("restaurant: name, money, Cash + KHQR", () => own("PUT", `${R}/settings`, RESTAURANT.settings));
      const zones = (await own("GET", `${R}/zones`)).data;
      for (const z of RESTAURANT.zones) {
        let zone = zones.find((x) => x.name === z.name);
        if (!zone) await doIt(`restaurant: zone ${z.name} + tables ${z.prefix}${z.from}–${z.prefix}${z.to}`, async () => (zone = (await own("POST", `${R}/zones`, { name: z.name })).data));
        if (zone) {
          const tables = (await own("GET", `${R}/tables`)).data;
          if (!tables.some((t) => String(t.zone_id) === String(zone._id))) await doIt(`restaurant: tables ${z.prefix}${z.from}–${z.prefix}${z.to}`, () => own("POST", `${R}/tables/bulk`, { prefix: z.prefix, from: z.from, to: z.to, seats: 4, zone_id: zone._id }));
        }
      }
      const groups = (await own("GET", `${R}/addon-groups`)).data;
      let extras = groups.find((g) => g.name === RESTAURANT.extras.name);
      if (!extras) await doIt("restaurant: extras group", async () => (extras = (await own("POST", `${R}/addon-groups`, RESTAURANT.extras)).data));
      const cats = (await own("GET", `${R}/categories`)).data;
      const items = (await own("GET", `${R}/items`)).data;
      for (const c of RESTAURANT.categories) {
        let cat = cats.find((x) => x.name_en === c.name_en);
        if (!cat) await doIt(`restaurant: category ${c.name_en}`, async () => (cat = (await own("POST", `${R}/categories`, { name_en: c.name_en, name_km: c.name_km, color: c.color })).data));
        for (const [name_en, name_km, price, sizes] of c.items) {
          if (items.some((x) => x.name_en === name_en)) continue;
          await doIt(`restaurant: ${name_en} $${price}`, () =>
            own("POST", `${R}/items`, { name_en, name_km, price, category_id: cat._id, ...(sizes ? { sizes } : {}), ...(c.extras && extras ? { addon_group_ids: [extras._id] } : {}) }),
          );
        }
      }
      const staff = (await own("GET", `${R}/staff`)).data;
      if (!staff.some((s) => s.name === STAFF)) await doIt(`restaurant: staff ${STAFF} (PIN ${PIN})`, () => own("POST", `${R}/staff`, { name: STAFF, role: "manager", pin: PIN }));
    }

    // ---------------- mini mart ----------------
    if (shops.mart) {
      const M = `/api/user/businesses/${shops.mart._id}/mart`;
      const have = new Set((await own("GET", `${M}/products`)).data.map((p) => p.barcode));
      const missing = MART_PRODUCTS.filter((p) => !have.has(p.barcode));
      if (missing.length) await doIt(`mart: ${missing.length} products`, () => own("POST", `${M}/products/import`, { rows: missing }));
      const staff = (await own("GET", `${M}/staff`)).data;
      if (!staff.some((s) => s.name === STAFF)) await doIt(`mart: staff ${STAFF} (PIN ${PIN})`, () => own("POST", `${M}/staff`, { name: STAFF, role: "manager", pin: PIN }));
    }

    // ---------------- guest house ----------------
    if (shops.guest_house) {
      const G = `/api/user/businesses/${shops.guest_house._id}/guesthouse`;
      const types = (await own("GET", `${G}/room-types`)).data;
      const rooms = (await own("GET", `${G}/rooms`)).data;
      for (const t of GH.types) {
        let type = types.find((x) => x.name === t.name);
        const { rooms: list, ...body } = t;
        if (!type) await doIt(`guest house: room type ${t.name} $${t.price}`, async () => (type = (await own("POST", `${G}/room-types`, body)).data));
        for (const [name, floor] of list) {
          if (rooms.some((r) => r.name === name)) continue;
          await doIt(`guest house: room ${name}`, () => own("POST", `${G}/rooms`, { name, floor, type_id: type._id }));
        }
      }
      const staff = (await own("GET", `${G}/staff`)).data;
      if (!staff.some((s) => s.name === STAFF)) await doIt(`guest house: staff ${STAFF} (PIN ${PIN})`, () => own("POST", `${G}/staff`, { name: STAFF, role: "manager", pin: PIN }));
    }

    // ---------------- attendance ----------------
    if (shops.attendance) {
      const A = `/api/user/businesses/${shops.attendance._id}/attendance`;
      let branches = (await own("GET", `${A}/branches`)).data;
      if (!branches.length) await doIt("attendance: branch Main office (door kiosk)", async () => (branches = [(await own("POST", `${A}/branches`, { name: "Main office", address: "Toul Kork, Phnom Penh", lat: 11.5786, lng: 104.8935, radius_m: 200 })).data]));
      const staff = (await own("GET", `${A}/staff`)).data;
      const people = [
        ["Demo Staff", "+85512000123", "1234", "Cashier"],
        ["Sok Dara", "+85512000124", "2468", "Waiter"],
        ["Chan Vanna", "+85512000125", "1357", "Cook"],
        ["Kim Lina", "+85512000126", "8642", "Manager"],
      ];
      for (const [name, phone, pin, position] of people) {
        if (staff.some((x) => x.phone === phone)) continue;
        await doIt(`attendance: staff ${name}${phone === "+85512000123" ? " (demo login, PIN 1234)" : ""}`, () => own("POST", `${A}/staff`, { name, phone, pin, position, role: "staff", branch_ids: branches.map((b) => b._id) }));
      }
      const kiosk = (await own("GET", `${A}/kiosk`)).data;
      if (!kiosk.active) await doIt("attendance: door kiosk add-on (att_kiosk)", () => own("POST", `/api/user/businesses/${shops.attendance._id}/licenses/att_kiosk`, { expect: null }));
      if (write) await own("GET", `${A}/kiosk`); // makes the kiosk link of each branch
    }

    // ---------------- stamp card ----------------
    if (shops.stamp_card) {
      const SC = `/api/user/businesses/${shops.stamp_card._id}/stamps`;
      const ov = (await own("GET", SC)).data;
      const program = ov.program || ov;
      if (!program.desk?.has_pin || program.desk?.on === false) await doIt("stamp card: staff desk on, PIN 1234", () => own("PUT", `${SC}/desk`, { on: true, pin: PIN }));
      const members = (await own("GET", `${SC}/members`)).data || [];
      if (!members.length)
        for (const [name, phone, stamps] of [["Sok Dara", "012 555 201", 7], ["Emma Wilson", "012 555 202", 3], ["Chan Vanna", "012 555 203", 9], ["Kim Lina", "012 555 204", 1]])
          await doIt(`stamp card: customer ${name} (${stamps} stamps)`, () => own("POST", `${SC}/members`, { name, phone, stamps }));
    }

    // ---------------- event ----------------
    if (shops.event) {
      const EV = `/api/user/businesses/${shops.event._id}/events`;
      const team = (await own("GET", `${EV}/team`)).data;
      if (!team.members.some((m) => m.name === "Demo Door")) await doIt("event: team member Demo Door (manager, PIN 1234)", () => own("POST", `${EV}/team`, { name: "Demo Door", role: "manager", pin: PIN }));
      const events = (await own("GET", `${EV}/events`)).data || [];
      const soon = events.find((e) => e.status === "published" && new Date(e.starts_at) > new Date(Date.now() + 3 * 864e5));
      if (!soon) {
        const start = new Date(Date.now() + 30 * 864e5);
        start.setUTCHours(11, 0, 0, 0); // 18:00 in Cambodia
        await doIt(`event: Riverside Night Market on ${start.toISOString().slice(0, 10)} + 5 guests`, async () => {
          const ev = (await own("POST", `${EV}/events`, { title: "Riverside Night Market", starts_at: start, ends_at: new Date(start.getTime() + 4 * 3600e3), venue: "Sisowath Quay, Phnom Penh", about: "Food, music and crafts by the river. Free entry: show your ticket QR at the gate.", kind: "free", status: "published", types: [{ name: "Entry", price: 0, qty: 300 }] })).data;
          const key = ev.types[0].key;
          for (const [name, phone, qty] of [["Sok Dara", "012 555 301", 2], ["Emma Wilson", "012 555 302", 1], ["Chan Vanna", "012 555 303", 3], ["Kim Lina", "012 555 304", 2], ["Kenji Sato", "012 555 305", 1]]) {
            const r = await call("POST", `/api/public/ev/e/${ev.slug}/order`, { lines: [{ key, qty }], name, phone });
            if (r.s >= 400) throw new Error(`guest order → ${r.s} ${r.j.message}`);
          }
        });
      }
    }

    // ---------------- telegram store ----------------
    if (shops.tg_store) {
      const TSB = `/api/user/businesses/${shops.tg_store._id}/tgstore`;
      const ov = (await own("GET", TSB)).data;
      if (!ov.store.about) await doIt("telegram store: shop details, pickup + delivery, cash", () => own("PUT", `${TSB}/settings`, { shop_name: "Mekong Coffee Shop", about: "Coffee, tea & cakes · 7:00–21:00", delivery: { on: true, fee: 1, free_from: 15, min_order: 0 }, pickup: { on: true }, pay: { cash: { on: true } } }));
      const cats = (await own("GET", `${TSB}/categories`)).data;
      if (!cats.length)
        await doIt("telegram store: 2 categories + 8 products", async () => {
          const coffee = (await own("POST", `${TSB}/categories`, { name: "Coffee & tea", name_km: "កាហ្វេ និងតែ" })).data;
          const cake = (await own("POST", `${TSB}/categories`, { name: "Cakes", name_km: "នំ" })).data;
          for (const [name, name_km, price, cat] of [
            ["Iced latte", "ឡាតេទឹកកក", 2.5, coffee], ["Iced Americano", "អាមេរិកាណូទឹកកក", 1.75, coffee], ["Khmer iced coffee", "កាហ្វេទឹកដោះគោ", 1.5, coffee], ["Green tea latte", "តែបៃតង", 2.25, coffee], ["Passion fruit soda", "សូដាផាសិន", 2, coffee],
            ["Butter croissant", "នំក្រូសង់", 1.8, cake], ["Chocolate cake", "នំសូកូឡា", 2.5, cake], ["Banana bread", "នំចេក", 1.5, cake],
          ]) // prettier-ignore
            await own("POST", `${TSB}/products`, { name, name_km, price, category_id: cat._id });
        });
      const pos = (await own("GET", `${TSB}/pos`)).data;
      if (!pos.staff.some((s) => s.name === STAFF)) await doIt(`telegram store: staff screen ${STAFF} (manager, PIN ${PIN})`, () => own("POST", `${TSB}/pos/staff`, { name: STAFF, role: "manager", pin: PIN }));
    }

    console.log(`\n${write ? "Added" : "Would add"} (${plan.length}):`);
    for (const p of plan) console.log("  •", p);
    if (!write) console.log("\nDry run. Run again with --yes to write this to production.");

    // ---------------- test "Try demo" (only on the in-memory database) ----------------
    if (test) {
      console.log("\nTry demo");
      let r = await call("POST", "/api/public/pos-demo", { kind: "nope" });
      ok(r.s === 400, "unknown kind → 400");
      r = await call("POST", "/api/public/pos-demo", { kind: "restaurant", name: "Phone" });
      ok(r.s === 200 && /^[a-f0-9]{64}$/.test(r.j.data?.token) && r.j.data.pin === PIN && r.j.data.demo === true && r.j.data.device?.prefix, "restaurant: token + device + PIN", r.j);
      const rt = r.j.data.token;
      r = await call("POST", "/api/public/pos-demo", { kind: "restaurant" });
      ok(r.j.data?.token === rt, "restaurant: tapping again gives the same shared device");
      const R = require("../src/biz/restaurant/restaurant.models");
      ok((await R.RestDevice.countDocuments({ business_id: shops.restaurant._id })) === 1, "restaurant: still one device");
      r = await call("GET", "/api/pos/bootstrap", null, { "x-device-token": rt });
      const boot = r.j.data || {};
      ok(r.s === 200 && boot.items?.length === 17 && boot.tables?.length === 12 && boot.staff?.length === 1 && boot.categories?.length === 4, "restaurant: bootstrap has the menu, tables, staff", { s: r.s, items: boot.items?.length, tables: boot.tables?.length, m: r.j.message });
      r = await call("POST", "/api/pos/staff-pin", { pin: PIN }, { "x-device-token": rt });
      ok(r.s === 200, "restaurant: PIN 1234 logs in", r.j);
      // someone unlinks the demo device → "Try demo" links it again
      await R.RestDevice.updateOne({ business_id: shops.restaurant._id }, { $set: { revoked: true } });
      r = await call("POST", "/api/public/pos-demo", { kind: "restaurant" });
      r = await call("GET", "/api/pos/bootstrap", null, { "x-device-token": rt });
      ok(r.s === 200, "restaurant: an unlinked demo device works again after Try demo");

      r = await call("POST", "/api/public/pos-demo", { kind: "mart" });
      ok(r.s === 200 && r.j.data?.business?.name === "Lucky Mini Mart" && r.j.data.pin === PIN, "mart: token + shop", r.j);
      const mt = r.j.data.token;
      r = await call("POST", "/api/martpos/login", { pin: PIN }, { "x-mart-device": mt });
      ok(r.s === 200 && r.j.data?.session, "mart: PIN 1234 logs in", r.j);
      const msess = r.j.data?.session;
      r = await call("GET", "/api/martpos/boot", null, { "x-mart-device": mt, "x-mart-session": msess });
      ok(r.s === 200 && (r.j.data?.products || []).length === 24 && (r.j.data?.categories || []).length === 4, "mart: boot has 24 products in 4 categories", { s: r.s, m: r.j.message, n: (r.j.data?.products || []).length });
      r = await call("GET", "/api/martpos/sync", null, { "x-mart-device": mt, "x-mart-session": msess });
      ok(r.s === 200, "mart: sync");

      r = await call("POST", "/api/public/pos-demo", { kind: "guest_house" });
      ok(r.s === 200 && r.j.data?.business?.name === "Lotus Guest House", "guest house: token + shop", r.j);
      const gt = r.j.data.token;
      r = await call("POST", "/api/ghpos/login", { pin: PIN }, { "x-gh-device": gt });
      ok(r.s === 200 && r.j.data?.session, "guest house: PIN 1234 logs in", r.j);
      const gsess = r.j.data?.session;
      r = await call("GET", "/api/ghpos/boot", null, { "x-gh-device": gt, "x-gh-session": gsess });
      ok(r.s === 200 && (r.j.data?.rooms || []).length === 5, "guest house: boot has 5 rooms", { s: r.s, m: r.j.message, keys: Object.keys(r.j.data || {}) });

      // attendance: the door tablet, and the staff phone (the demo staff moves to the newest phone)
      r = await call("POST", "/api/public/pos-demo", { kind: "attendance", mode: "kiosk" });
      ok(r.s === 200 && r.j.data?.mode === "kiosk" && r.j.data?.token, "attendance kiosk: token", r.j);
      r = await call("GET", `/api/att/kiosk/${r.j.data?.token}`);
      ok(r.s === 200, "attendance kiosk: the door page opens", { s: r.s, m: r.j.message });
      r = await call("POST", "/api/public/pos-demo", { kind: "attendance", mode: "staff", device_id: "a".repeat(32) });
      ok(r.s === 200 && r.j.data?.mode === "staff" && r.j.data?.code && r.j.data?.token, "attendance staff: logged in", r.j);
      const at1 = r.j.data?.token;
      r = await call("GET", "/api/att/me", null, { "x-att-token": at1 });
      ok(r.s === 200, "attendance staff: /me works", { s: r.s, m: r.j.message });
      r = await call("POST", "/api/att/punch", { kind: "in", lat: 11.5786, lng: 104.8935, accuracy: 10 }, { "x-att-token": at1 });
      ok(r.s === 201 || r.s === 200, "attendance staff: clock in", { s: r.s, m: r.j.message });
      r = await call("POST", "/api/public/pos-demo", { kind: "attendance", mode: "staff", device_id: "b".repeat(32) });
      ok(r.s === 200, "attendance staff: another phone takes the demo staff");
      r = await call("GET", "/api/att/me", null, { "x-att-token": at1 });
      ok(r.s === 401, "attendance staff: the first phone is logged out");
      r = await call("POST", "/api/public/pos-demo", { kind: "attendance", mode: "staff", device_id: "bad id!" });
      ok(r.s === 400, "attendance staff: a bad device id → 400");

      // stamp card desk
      r = await call("POST", "/api/public/pos-demo", { kind: "stamp_card" });
      ok(r.s === 200 && r.j.data?.slug && r.j.data.pin === PIN, "stamp card: desk slug + PIN", r.j);
      const slug = r.j.data?.slug;
      r = await call("POST", `/api/public/stamp/desk/${slug}/login`, { pin: PIN });
      ok(r.s === 200 && r.j.data?.token, "stamp card: desk PIN 1234 logs in", r.j);
      r = await call("GET", `/api/public/stamp/desk/${slug}/members`, null, { "x-desk-token": r.j.data?.token });
      ok(r.s === 200 && (r.j.data || []).length === 4, "stamp card: 4 sample customers", { s: r.s, n: (r.j.data || []).length, m: r.j.message });

      // event door phone
      r = await call("POST", "/api/public/pos-demo", { kind: "event" });
      ok(r.s === 200 && /^[a-f0-9]{64}$/.test(r.j.data?.token) && r.j.data.pin === PIN, "event: door token + PIN", r.j);
      const et = r.j.data?.token;
      r = await call("POST", "/api/evdoor/login", { pin: PIN }, { "x-ev-device": et });
      ok(r.s === 200 && r.j.data?.session, "event: team PIN 1234 logs in", r.j);
      r = await call("GET", "/api/evdoor/boot", null, { "x-ev-device": et, "x-ev-session": r.j.data?.session });
      const evs = r.j.data?.events || [];
      ok(r.s === 200 && evs.length === 1 && evs[0].tickets === 9, "event: boot has the event with 9 tickets", { s: r.s, n: evs.length, t: evs[0]?.tickets, m: r.j.message });

      // telegram store staff screen
      r = await call("POST", "/api/public/pos-demo", { kind: "tg_store" });
      const tst = r.j.data?.token;
      ok(r.s === 200 && /^[a-f0-9]{64}$/.test(tst) && r.j.data.shop?.name === "Mekong Coffee Shop" && r.j.data.pin === PIN, "tg_store: screen token + shop + PIN", r.j);
      r = await call("POST", "/api/tspos/login", { pin: PIN }, { "x-ts-device": tst });
      ok(r.s === 200 && r.j.data?.session && r.j.data.staff.role === "manager", "tg_store: staff PIN 1234 logs in (manager)", r.j);
      const tsh = { "x-ts-device": tst, "x-ts-session": r.j.data?.session };
      r = await call("GET", "/api/tspos/orders", null, tsh);
      ok(r.s === 200 && r.j.data.length === 3 && r.j.data.every((o) => o.status === "new"), "tg_store: 3 sample orders waiting", { n: r.j.data?.length });
      r = await call("POST", "/api/public/pos-demo", { kind: "tg_store" });
      ok(r.j.data?.token === tst, "tg_store: the same demo screen again (no new device)");
      r = await call("GET", "/api/tspos/orders", null, tsh);
      ok(r.j.data.length === 3, "tg_store: no extra orders while 3 are open");

      // old demo data is tidied, new data stays
      const MM = require("../src/biz/mart/mart.models");
      const raw = mongoose.connection.collection(MM.MartShift.collection.name);
      await raw.insertOne({ business_id: shops.mart._id, created_date: new Date(Date.now() - 5 * 864e5), status: "closed" });
      await raw.insertOne({ business_id: shops.mart._id, created_date: new Date(), status: "closed" });
      await require("../src/biz/pos_demo").tidy("mart", shops.mart._id, true); // (normally at most once an hour)
      ok((await raw.countDocuments({ business_id: shops.mart._id })) === 1, "old demo shifts are removed, today's stay");

      // --capture=<file>: real answers of the POS endpoints, for the app's store screenshots (test/store)
      const capArg = process.argv.find((a) => a.startsWith("--capture="));
      if (capArg) {
        const out = {};
        const rec = async (key, m, p, body, h) => {
          const r = await call(m, p, body, h);
          out[key || `${m} ${p}`] = r.j;
          return r;
        };
        const day = (n) => new Date(Date.now() + 7 * 3600e3 + n * 864e5).toISOString().slice(0, 10); // Cambodia date
        // a few sales today at the mini mart
        const mh = { "x-mart-device": mt, "x-mart-session": msess };
        const prods = (await call("GET", "/api/martpos/boot", null, mh)).j.data.products;
        const pick = (name) => prods.find((p) => p.name === name);
        const baskets = [
          [["Drinking water 500 ml", 2], ["Potato chips", 1]],
          [["Iced coffee can", 3]],
          [["Shampoo 340 ml", 1], ["Toothpaste", 1], ["Bath soap", 2]],
          [["Instant noodles", 6], ["Green tea bottle", 2]],
          [["Laundry powder 1 kg", 1], ["Dish soap 500 ml", 1]],
        ];
        for (const [i, b] of baskets.entries()) {
          const items = b.map(([n, q]) => ({ product_id: pick(n)._id, name: n, barcode: pick(n).barcode, price: pick(n).price, qty: q }));
          await rec(i ? `POST /api/martpos/sales#${i}` : "POST /api/martpos/sales", "POST", "/api/martpos/sales", { items, method: i % 2 ? "khqr" : "cash", paid_usd: 20 }, mh);
        }
        // guests at the guest house: 2 in the house, 1 arriving today, 1 tomorrow
        const G = `/api/user/businesses/${shops.guest_house._id}/guesthouse`;
        const rooms = (await own("GET", `${G}/rooms`)).data;
        const room = (n) => rooms.find((r) => r.name === n)._id;
        await own("POST", `${G}/stays`, { room_id: room("101"), from: day(0), to: day(2), check_in_now: true, guest: { name: "Sok Dara", phone: "012 555 101" }, adults: 2, deposit: 15 });
        await own("POST", `${G}/stays`, { room_id: room("201"), from: day(0), to: day(3), check_in_now: true, guest: { name: "Emma Wilson", phone: "+44 7700 900123", nationality: "British" }, adults: 2, source: "booking_com", deposit: 25 });
        await own("POST", `${G}/stays`, { room_id: room("202"), from: day(0), to: day(1), guest: { name: "Chan Vanna", phone: "097 444 202" }, adults: 1 });
        await own("POST", `${G}/stays`, { room_id: room("203"), from: day(1), to: day(4), guest: { name: "Kenji Sato", phone: "+81 90 1234 5678" }, adults: 2, source: "telegram" });
        // what the app asks for
        const rh = { "x-device-token": rt };
        await rec(null, "POST", "/api/pos/staff-pin", { pin: PIN }, rh);
        await rec(null, "GET", "/api/pos/bootstrap", null, rh);
        await rec(null, "POST", "/api/pos/sync", { since: 0, orders: [], shifts: [], bookings: [], pending: 0 }, rh);
        await rec(null, "POST", "/api/pos/guest-orders", { acks: [], open_tables: [] }, rh);
        await rec(null, "GET", `/api/pos/report?from=${day(0)}&to=${day(0)}`, null, rh);
        await rec(null, "POST", "/api/martpos/login", { pin: PIN }, { "x-mart-device": mt });
        for (const p of ["/boot", "/sync", "/sales", `/sales?day=${day(0)}`, "/shifts", "/orders/count", "/debtors"]) await rec(null, "GET", `/api/martpos${p}`, null, mh);
        const gh = { "x-gh-device": gt, "x-gh-session": gsess };
        await rec(null, "POST", "/api/ghpos/login", { pin: PIN }, { "x-gh-device": gt });
        for (const p of ["/boot", "/sync", "/today", "/stays", "/cust-requests/count", "/guests?q="]) await rec(null, "GET", `/api/ghpos${p}`, null, gh);
        const stays = out["GET /api/ghpos/stays"].data || [];
        for (const st of stays) await rec(null, "GET", `/api/ghpos/stays/${st._id}`, null, gh);
        out._meta = { day: day(0), made: new Date().toISOString() };
        require("fs").writeFileSync(capArg.split("=")[1], JSON.stringify(out, null, 1));
        console.log(`\nCaptured ${Object.keys(out).length - 1} answers → ${capArg.split("=")[1]}`);
        for (const [k, v] of Object.entries(out)) if (k !== "_meta" && v.success === false) console.log("  ! failed:", k, v.message);
      }
      console.log(`\n${pass} passed, ${fail} failed`);
    }
  } catch (err) {
    console.error("\n✗", err.message);
    fail++;
  } finally {
    await Sess.deleteOne({ _id: sess._id }).catch(() => {});
    srv.close();
    await mongoose.disconnect();
    if (mem) await mem.stop();
    process.exit(fail ? 1 : 0);
  }
})();
