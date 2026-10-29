const { SERVICE_KEYS, PRICE_KEYS } = require("./homepage.defaults");

// Turns a PUT body into a MongoDB $set. Only the sections you send are changed.
// Returns { set } or { error } (error = message for the admin, in Khmer).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEXT_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : v);

function isUrlOrEmpty(v) {
  if (v === "") return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function validateHomepage(body) {
  if (!isObj(body)) return { error: "ទិន្នន័យមិនត្រឹមត្រូវ!" };
  const set = {};

  // ---------- contact ----------
  if (body.contact !== undefined) {
    if (!isObj(body.contact)) return { error: "contact ត្រូវតែជា object" };
    const c = body.contact;
    if (c.phones !== undefined) {
      if (!Array.isArray(c.phones) || c.phones.length > 5) return { error: "លេខទូរស័ព្ទ ត្រូវតែជាបញ្ជី (អតិបរមា ៥)" };
      const phones = c.phones.map(str).filter(Boolean);
      if (phones.some((p) => typeof p !== "string" || p.length > 30)) return { error: "លេខទូរស័ព្ទមិនត្រឹមត្រូវ!" };
      set["contact.phones"] = phones;
    }
    const textFields = { telegram: 50, address: 300 };
    for (const [k, max] of Object.entries(textFields)) {
      if (c[k] === undefined) continue;
      if (typeof c[k] !== "string" || c[k].length > max) return { error: `${k} មិនត្រឹមត្រូវ (អតិបរមា ${max} តួ)` };
      set[`contact.${k}`] = c[k].trim();
    }
    if (c.email !== undefined) {
      const email = str(c.email);
      if (typeof email !== "string" || (email && !EMAIL_RE.test(email))) return { error: "អ៊ីមែលមិនត្រឹមត្រូវ!" };
      set["contact.email"] = email;
    }
    for (const k of ["telegram_url", "facebook_url", "map_url", "tiktok_url", "youtube_url", "coolapp_url", "tg_channel_url"]) {
      if (c[k] === undefined) continue;
      const v = str(c[k]);
      if (typeof v !== "string" || !isUrlOrEmpty(v)) return { error: `${k} ត្រូវតែជាតំណ https://...` };
      set[`contact.${k}`] = v;
    }
  }

  // ---------- coin ----------
  if (body.coin !== undefined) {
    if (!isObj(body.coin)) return { error: "coin ត្រូវតែជា object" };
    const rules = {
      pack_coins: { min: 1, max: 1000000, int: true },
      pack_price_usd: { min: 0, max: 100000, int: false },
      signup_bonus: { min: 0, max: 1000000, int: true },
    };
    for (const [k, r] of Object.entries(rules)) {
      if (body.coin[k] === undefined) continue;
      const n = Number(body.coin[k]);
      if (!Number.isFinite(n) || n < r.min || n > r.max || (r.int && !Number.isInteger(n))) {
        return { error: `${k} មិនត្រឹមត្រូវ (${r.min} – ${r.max})` };
      }
      set[`coin.${k}`] = n;
    }
  }

  // ---------- prices (coins per new business, by type) ----------
  if (body.prices !== undefined) {
    if (!isObj(body.prices)) return { error: "prices ត្រូវតែជា object" };
    for (const k of PRICE_KEYS) {
      if (body.prices[k] === undefined) continue;
      const n = Number(body.prices[k]);
      if (!Number.isInteger(n) || n < 0 || n > 100000) return { error: `prices.${k} មិនត្រឹមត្រូវ (0 – 100000)` };
      set[`prices.${k}`] = n;
    }
  }

  // ---------- payment methods ----------
  if (body.payment_methods !== undefined) {
    const list = body.payment_methods;
    if (!Array.isArray(list) || list.length > 10) return { error: "វិធីបង់ប្រាក់ ត្រូវតែជាបញ្ជី (អតិបរមា ១០)" };
    const clean = list.map(str).filter(Boolean);
    if (clean.some((m) => typeof m !== "string" || m.length > 30)) return { error: "ឈ្មោះវិធីបង់ប្រាក់មិនត្រឹមត្រូវ!" };
    set.payment_methods = [...new Set(clean)];
  }

  // ---------- app ----------
  if (body.app !== undefined) {
    if (!isObj(body.app)) return { error: "app ត្រូវតែជា object" };
    if (body.app.status !== undefined) {
      if (!["coming_soon", "live"].includes(body.app.status)) return { error: "app.status = coming_soon | live" };
      set["app.status"] = body.app.status;
    }
    for (const k of ["android_url", "ios_url"]) {
      if (body.app[k] === undefined) continue;
      const v = str(body.app[k]);
      if (typeof v !== "string" || !isUrlOrEmpty(v)) return { error: `${k} ត្រូវតែជាតំណ https://...` };
      set[`app.${k}`] = v;
    }
  }

  // ---------- services ----------
  if (body.services !== undefined) {
    if (!Array.isArray(body.services)) return { error: "services ត្រូវតែជាបញ្ជី" };
    const seen = new Set();
    const services = [];
    for (const [i, s] of body.services.entries()) {
      if (!isObj(s) || !SERVICE_KEYS.includes(s.key) || seen.has(s.key)) {
        return { error: `សេវាកម្មមិនត្រឹមត្រូវ (${SERVICE_KEYS.join(" | ")})` };
      }
      seen.add(s.key);
      services.push({
        key: s.key,
        enabled: s.enabled !== false,
        coming_soon: s.coming_soon === true,
        sort_order: Number.isInteger(s.sort_order) ? s.sort_order : i,
      });
    }
    set.services = services.sort((a, b) => a.sort_order - b.sort_order);
  }

  // ---------- groups (services by group, in order) ----------
  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups) || body.groups.length > 12) return { error: "ក្រុម ត្រូវតែជាបញ្ជី (អតិបរមា ១២)" };
    const keys = new Set();
    const used = new Set();
    const groups = [];
    for (const g of body.groups) {
      if (!isObj(g)) return { error: "ក្រុមមិនត្រឹមត្រូវ!" };
      const key = String(g.key || "").trim();
      if (!/^[a-z0-9_]{1,30}$/.test(key) || keys.has(key)) return { error: `លេខកូដក្រុមមិនត្រឹមត្រូវ ឬស្ទួន: ${key || "—"}` };
      keys.add(key);
      const en = str(g.en);
      const km = str(g.km);
      if (typeof en !== "string" || typeof km !== "string" || !en || !km || en.length > 40 || km.length > 40) return { error: `ឈ្មោះក្រុម (EN + ខ្មែរ) ត្រូវការ អតិបរមា ៤០ តួ: ${key}` };
      if (!Array.isArray(g.types)) return { error: `សេវាកម្មក្នុងក្រុម ${key} ត្រូវតែជាបញ្ជី` };
      const types = [];
      for (const t of g.types) {
        if (!SERVICE_KEYS.includes(t)) return { error: `សេវាកម្មមិនត្រឹមត្រូវ: ${t}` };
        if (used.has(t)) return { error: `សេវាកម្ម ${t} នៅក្នុងក្រុមពីរ` };
        used.add(t);
        types.push(t);
      }
      groups.push({ key, en, km, types });
    }
    set.groups = groups;
  }

  // ---------- texts (replaces the overrides of each language you send) ----------
  if (body.texts !== undefined) {
    if (!isObj(body.texts)) return { error: "texts ត្រូវតែជា object { en, km }" };
    for (const lang of ["en", "km"]) {
      const map = body.texts[lang];
      if (map === undefined) continue;
      if (!isObj(map)) return { error: `texts.${lang} ត្រូវតែជា object` };
      const entries = Object.entries(map);
      if (entries.length > 300) return { error: "អត្ថបទច្រើនពេក!" };
      const clean = {};
      for (const [k, v] of entries) {
        if (!TEXT_KEY_RE.test(k)) return { error: `ឈ្មោះអត្ថបទមិនត្រឹមត្រូវ: ${k}` };
        if (typeof v !== "string" || v.length > 1000) return { error: `អត្ថបទ ${k} វែងពេក (អតិបរមា ១០០០ តួ)` };
        if (v.trim()) clean[k] = v;
      }
      set[`texts.${lang}`] = clean;
    }
  }

  if (Object.keys(set).length === 0) return { error: "មិនមានទិន្នន័យដើម្បីកែប្រែ!" };
  return { set };
}

module.exports = { validateHomepage };
