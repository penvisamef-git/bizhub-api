// Portfolio (CV) fields and their limits — used by the model and to check what the customer sends
const LISTS = {
  experience: { max: 20, required: "title", fields: { title: 80, company: 80, location: 80, start: 20, end: 20, description: 1000 }, bools: ["current"] },
  education: { max: 20, required: "school", fields: { school: 120, degree: 120, field: 120, start: 20, end: 20, description: 600 } },
  projects: { max: 20, required: "title", fields: { title: 100, link: 200, description: 600 }, urls: ["link"] },
  certifications: { max: 20, required: "name", fields: { name: 120, issuer: 120, year: 20, link: 200 }, urls: ["link"] },
  languages: { max: 10, required: "name", fields: { name: 40, level: 40 } },
};
const TEXTS = { headline: 120, about: 2000 };
const SKILLS = { max: 40, length: 40 };

// Looks of the public page. Premium ones are unlocked per portfolio (price: Homepage.prices.portfolio_theme)
const FREE_THEMES = ["classic", "minimal", "sidebar"];
// ("bento" is shown as "Mosaic")
// + the 100 recipe themes (themeRecipes.json, shared with the web and the app)
const PREMIUM_THEMES = ["midnight", "magazine", "glass", "terminal", "bento", "executive", "corporate", "professional", "enterprise", ...require("./themeRecipes.json").portfolio.themes.map((t) => t.key)];
const THEMES = [...FREE_THEMES, ...PREMIUM_THEMES];

// Uploaded documents (certificates, work samples): images or PDF
const FILES = { max: 12, titleLength: 80, maxMB: 4, types: ["application/pdf", "image/jpeg", "image/png", "image/webp"] };

module.exports = { LISTS, TEXTS, SKILLS, FREE_THEMES, PREMIUM_THEMES, THEMES, FILES };
