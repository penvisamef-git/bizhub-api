// Public routes (no login, no API key) — /api/public/...
// (the public homepage route lives in src/homepage)
const index = (prop) => {
  prop.public_route = "api/public";
};

module.exports = index;
