// Website looks: 353 in 15 style categories. 4 are free; the others are bought one at a time ("web_theme", 35 coins, forever).
// The colours / fonts / shapes of each live in the web app (src/wsite/themeList.js) — here only the keys + font pairs.
const LIST = require("./website.themelist");

const FREE_THEMES = LIST.free;
const THEMES = LIST.keys;
const PAID_THEMES = THEMES.filter((k) => !FREE_THEMES.includes(k));
// removed looks (too close to another one) → the look that replaced them; a bought one carries over
const THEME_ALIAS = LIST.alias || {};
const themeKey = (k) => (THEMES.includes(k) ? k : THEME_ALIAS[k] || k);

// font pairs: 4 for everyone; all 25 with "Brand style" (web_brand). A theme's own pair always works with that theme.
const FREE_FONTS = ["modern", "friendly", "classic", "bold"];
const ALL_FONTS = [
  ...FREE_FONTS,
  "elegant",
  "tech",
  "magazine",
  "playful",
  "corporate",
  "soft",
  "heritage",
  "clean",
  "geometric",
  "grotesk",
  "display",
  "condensed",
  "slab",
  "mono",
  "rounded",
  "editorial",
  "script",
  "typewriter",
  "fashion",
  "handmade",
  "temple",
];
const THEME_FONT = LIST.font;

// the 12 main colours anyone can pick (any colour with Brand style)
const PRESET_COLORS = ["#E0581A", "#DC2626", "#DB2777", "#9333EA", "#4F46E5", "#2563EB", "#0891B2", "#0D9488", "#16A34A", "#CA8A04", "#78350F", "#111827"];

module.exports = { FREE_THEMES, PAID_THEMES, THEMES, THEME_ALIAS, themeKey, FREE_FONTS, ALL_FONTS, THEME_FONT, PRESET_COLORS };
