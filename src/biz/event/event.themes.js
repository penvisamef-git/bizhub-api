// Event ticket designs: "classic" is free, the other 120 (12 styles × 10 colours) are bought once per business
// (ev_theme, item = key, forever) and can then be used on any of its events.
// Keep LAYOUTS / PALETTES in sync with bizhub/src/evpub/themes.js (the look lives there).
const LAYOUTS = ["gradient", "stub", "pass", "neon", "retro", "vip", "glass", "festival", "minimal", "badge", "khmer", "pop"];
const PALETTES = ["ruby", "ocean", "jungle", "sunset", "royal", "rose", "gold", "teal", "indigo", "mono"];
const THEMES = { classic: "free" };
for (const l of LAYOUTS) for (const p of PALETTES) THEMES[`${l}-${p}`] = "premium";
const FREE_THEMES = Object.keys(THEMES).filter((k) => THEMES[k] === "free");

// Event page themes (the page buyers order from: event page + order page + ticket page): "standard" is free, the other
// 60 (6 styles × 10 colours) are bought once per business (ev_page_theme, item = key, forever). Look: bizhub/src/evpub/pageThemes.js
// 6 still styles + 6 live (animated) styles = 12 × 10 colours = 120
const PAGE_LAYOUTS = ["aurora", "editorial", "bold", "midnight", "pastel", "cinema", "live-glow", "live-confetti", "live-stars", "live-waves", "live-flow", "live-stage"];
const PAGE_PALETTES = ["coral", "lagoon", "forest", "amber", "violet", "blush", "crimson", "sky", "olive", "graphite"];
const PAGE_THEMES = { standard: "free" };
for (const l of PAGE_LAYOUTS) for (const p of PAGE_PALETTES) PAGE_THEMES[`${l}-${p}`] = "premium";
const FREE_PAGE_THEMES = Object.keys(PAGE_THEMES).filter((k) => PAGE_THEMES[k] === "free");

// Certificate designs (ev_certs): classic / modern / royal are free, the other 100 (10 styles × 10 colours) are bought
// once per business (ev_cert_theme, item = key, forever). Look: bizhub/src/evpub/certThemes.js + cert.css
const CERT_LAYOUTS = ["frame", "band", "ornate", "ribbon", "wave", "geo", "minimal", "kbach", "medal", "night"];
const CERT_PALETTES = ["navy", "emerald", "crimson", "violet", "teal", "sunset", "rose", "slate", "olive", "sky"];
const CERT_THEMES = { classic: "free", modern: "free", royal: "free" };
for (const l of CERT_LAYOUTS) for (const p of CERT_PALETTES) CERT_THEMES[`${l}-${p}`] = "premium";
const FREE_CERT_THEMES = Object.keys(CERT_THEMES).filter((k) => CERT_THEMES[k] === "free");
module.exports = { CERT_THEMES, FREE_CERT_THEMES, CERT_LAYOUTS, CERT_PALETTES, THEMES, FREE_THEMES, LAYOUTS, PALETTES, PAGE_THEMES, FREE_PAGE_THEMES, PAGE_LAYOUTS, PAGE_PALETTES };
