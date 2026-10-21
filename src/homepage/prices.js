// Current coin price of a service (super admin edits them in Website settings → prices)
// The prices are read once and kept for 30 s (cleared at once when the homepage is saved),
// so a page that shows many prices costs one database read, not one per price.
const Homepage = require("./homepage.model");
const { DEFAULT_HOMEPAGE } = require("./homepage.defaults");

const TTL = 30 * 1000;
let cached = null; // { at, prices, pending }
Homepage.onChange(() => (cached = null));

async function pricesNow() {
  if (cached && Date.now() - cached.at < TTL) return cached.prices ?? cached.pending;
  const pending = Homepage.findOne({ key: "main" })
    .select("prices")
    .lean()
    .then((doc) => doc?.prices || {});
  const entry = { at: Date.now(), prices: null, pending };
  cached = entry;
  try {
    entry.prices = await pending;
    return entry.prices;
  } catch (err) {
    if (cached === entry) cached = null;
    throw err;
  }
}

async function priceOf(key) {
  const value = (await pricesNow())[key];
  return Number.isInteger(value) ? value : (DEFAULT_HOMEPAGE.prices[key] ?? 0);
}

module.exports = { priceOf };
