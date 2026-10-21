// The blocks a page can have, and what each one holds. The web app has the same list (src/wsite/blocks.js).
// Field kinds:  t = short text in both languages {km, en}   tl = long text in both languages
//               s = plain short text   img = picture URL   to = a link (page:<slug>, https://, tel:, mailto:, #section)
//               date = YYYY-MM-DD[THH:mm]   bool   [..] = one of these   { list: {fields}, max } = a list of rows
const LIMIT = { t: 200, tl: 3000, s: 300, img: 800, to: 800 };

const BLOCKS = {
  hero: { title: "t", sub: "tl", image: "img", btn: "t", btn_to: "to", btn2: "t", btn2_to: "to", align: ["center", "left"], size: ["md", "lg", "sm"], overlay: ["dark", "light", "color"] },
  text: { title: "t", body: "tl", align: ["left", "center"] },
  split: { title: "t", body: "tl", image: "img", side: ["left", "right"], btn: "t", btn_to: "to" },
  image: { image: "img", caption: "t", wide: "bool" },
  gallery: { title: "t", images: { list: { image: "img", caption: "t" }, max: 24 }, cols: ["3", "2", "4"] },
  video: { title: "t", url: "s" },
  services: { title: "t", sub: "tl", items: { list: { icon: "s", title: "t", text: "tl", image: "img" }, max: 12 } },
  prices: { title: "t", sub: "tl", items: { list: { name: "t", price: "s", desc: "t" }, max: 40 }, note: "t" },
  team: { title: "t", people: { list: { name: "t", role: "t", photo: "img" }, max: 16 } },
  quotes: { title: "t", items: { list: { text: "tl", name: "t", role: "t", photo: "img" }, max: 12 } },
  faq: { title: "t", items: { list: { q: "t", a: "tl" }, max: 24 } },
  hours: { title: "t", rows: { list: { day: "t", time: "t" }, max: 10 }, note: "t" },
  map: { title: "t", address: "t", map_url: "s" },
  contact: { title: "t", sub: "tl", phone_field: "bool", email_field: "bool", button: "t" },
  buttons: { title: "t", items: { list: { label: "t", to: "to", style: ["solid", "outline"] }, max: 6 }, align: ["center", "left"] },
  social: { title: "t" },
  countdown: { title: "t", date: "date", sub: "t" },
  numbers: { title: "t", items: { list: { value: "s", label: "t" }, max: 6 } },
  logos: { title: "t", images: { list: { image: "img", name: "t", to: "to" }, max: 20 } },
  cta: { title: "t", sub: "tl", btn: "t", btn_to: "to" },
  spacer: { size: ["md", "sm", "lg"], line: "bool" },
  posts: { title: "t", count: ["3", "6"] }, // latest blog posts (web_blog)
};
const TYPES = Object.keys(BLOCKS);
const MAX_BLOCKS = 40;

const str = (v, max) => String(v ?? "").slice(0, max);
const trText = (v, max) => (v && typeof v === "object" ? { km: str(v.km, max), en: str(v.en, max) } : { km: "", en: str(v, max) });
const url = (v) => {
  const s = str(v, LIMIT.img).trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
};
// a link visitors can follow: never javascript: or data:
const link = (v) => {
  const s = str(v, LIMIT.to).trim();
  if (!s) return "";
  if (/^page:[a-z0-9-]{1,40}$/.test(s) || /^post:[a-z0-9-]{1,60}$/.test(s) || /^#[a-z0-9-]{1,40}$/i.test(s)) return s;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s) || /^tel:\+?[0-9 ()-]{3,20}$/.test(s) || /^mailto:[^\s"'<>]+@[^\s"'<>]+$/.test(s)) return s;
  return "";
};
const date = (v) => {
  const s = str(v, 16);
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s) ? s : "";
};

function cleanFields(fields, data) {
  const d = data && typeof data === "object" ? data : {};
  const out = {};
  for (const [key, kind] of Object.entries(fields)) {
    const v = d[key];
    if (Array.isArray(kind)) out[key] = kind.includes(v) ? v : kind[0];
    else if (kind && typeof kind === "object") out[key] = (Array.isArray(v) ? v : []).slice(0, kind.max).map((row) => cleanFields(kind.list, row));
    else if (kind === "t" || kind === "tl") out[key] = trText(v, LIMIT[kind]);
    else if (kind === "s") out[key] = str(v, LIMIT.s);
    else if (kind === "img") out[key] = url(v);
    else if (kind === "to") out[key] = link(v);
    else if (kind === "date") out[key] = date(v);
    else if (kind === "bool") out[key] = v === true;
  }
  return out;
}

// the blocks of a page as sent by the editor → checked + cleaned (unknown types dropped)
function cleanBlocks(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((b) => b && TYPES.includes(b.type))
    .slice(0, MAX_BLOCKS)
    .map((b) => {
      let id = /^[a-z0-9]{1,20}$/i.test(String(b.id || "")) ? String(b.id) : Math.random().toString(36).slice(2, 10);
      while (seen.has(id)) id = Math.random().toString(36).slice(2, 10);
      seen.add(id);
      return { id, type: b.type, hidden: b.hidden === true, data: cleanFields(BLOCKS[b.type], b.data) };
    });
}

module.exports = { BLOCKS, TYPES, MAX_BLOCKS, cleanBlocks, cleanFields, link, url };
