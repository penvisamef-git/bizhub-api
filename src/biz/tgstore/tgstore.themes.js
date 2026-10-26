// Telegram Store designs (v2.0): 8 layouts × 15 colour sets = 120. Three are free, the others are bought one by one (ts_theme, forever).
// The web (src/tgstore/themes.js) draws them from the same keys.
const LAYOUTS = ["grid", "list", "big", "compact", "menu", "magazine", "bubble", "shelf"];
const PALETTES = ["cream", "snow", "paper", "mint", "sky", "lilac", "peach", "sand", "forest", "ocean", "night", "coffee", "rose", "lime", "charcoal"];
const KEYS = LAYOUTS.flatMap((l) => PALETTES.map((p) => `${l}-${p}`));
const FREE = ["grid-cream", "list-snow", "menu-paper"];
const DEFAULT = "grid-cream";
module.exports = { LAYOUTS, PALETTES, KEYS, FREE, DEFAULT };
