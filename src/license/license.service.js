// Buy / renew a license with coins, and read license status.
const License = require("./license.model");
const { PRODUCTS, EXPIRING_DAYS } = require("./license.products");
const coin = require("../coin/coin.service");
const { priceOf } = require("../homepage/prices");

const DAY = 24 * 3600 * 1000;

class LicenseError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const isActive = (lic, now = Date.now()) => !!lic && (lic.expires_at === null || new Date(lic.expires_at).getTime() > now);

// { active, forever, expires_at, days_left, status: none | forever | active | expiring | expired }
function statusOf(lic, now = Date.now()) {
  if (!lic) return { active: false, forever: false, expires_at: null, days_left: 0, status: "none" };
  if (lic.expires_at === null) return { active: true, forever: true, expires_at: null, days_left: null, status: "forever", started_at: lic.started_at };
  const left = new Date(lic.expires_at).getTime() - now;
  const days = Math.max(0, Math.ceil(left / DAY));
  return {
    active: left > 0,
    forever: false,
    expires_at: lic.expires_at,
    started_at: lic.started_at,
    days_left: days,
    status: left <= 0 ? "expired" : days <= EXPIRING_DAYS ? "expiring" : "active",
  };
}

// all licenses of one business: { no_branding: {...status}, portfolio: {...status} }
async function licensesOf(businessId) {
  const rows = await License.find({ business_id: businessId, item: "" }).lean();
  const out = {};
  for (const key of Object.keys(PRODUCTS)) out[key] = statusOf(rows.find((r) => r.product === key));
  return out;
}

async function hasLicense(businessId, product) {
  return isActive(await License.findOne({ business_id: businessId, product, item: "" }).lean());
}

// Pay coins for a product. Forever products: once. Timed products: adds `days` to the end date
// (from today if already expired). Two clicks at once can't pay twice.
// expect: the end date the customer saw (ISO string or null). If it changed meanwhile (e.g. a double click
// already renewed), we stop with 409 instead of charging again.
async function buy({ customer, business, product, item = "", expect }) {
  const def = PRODUCTS[product];
  if (!def || def.retired) throw new LicenseError("Unknown product", 400);
  if (def.soon) throw new LicenseError("soon", 400);
  if (def.category !== "*" && def.category !== business.category) throw new LicenseError("Not for this business type", 400);
  // only the owner pays for a business (a team Admin can't spend their own or the owner's coins on it)
  if (business.owner_id && String(business.owner_id) !== String(customer._id)) throw new LicenseError("មានតែម្ចាស់អាជីវកម្មទេដែលអាចទិញបាន។ / Only the business owner can buy this.", 403, { code: "owner_only" });
  // some add-ons sit on top of another one (customer accounts need the website)
  if (def.needs) {
    const base = await License.findOne({ business_id: business._id, product: def.needs, item: "" });
    // …or a bundle that includes it (Guest House Pro includes the website and customer accounts)
    const bundles = Object.entries(PRODUCTS)
      .filter(([, d]) => (d.includes || []).includes(def.needs))
      .map(([k]) => k);
    const bundle = !base || !isActive(base) ? bundles.length && (await License.find({ business_id: business._id, product: { $in: bundles }, item: "" })).find(isActive) : null;
    if ((!base || !isActive(base)) && !bundle) throw new LicenseError("needs", 402, { needs: def.needs });
  }
  const price = await priceOf(def.price_key);
  const now = new Date();
  const existing = await License.findOne({ business_id: business._id, product, item });
  if (existing && !def.days && isActive(existing)) throw new LicenseError("already", 409);
  if (expect !== undefined) {
    const seen = expect ? new Date(expect).getTime() : null;
    const current = existing?.expires_at ? existing.expires_at.getTime() : null;
    const same = existing ? (existing.expires_at === null ? seen === null && !def.days : seen === current) : seen === null;
    if (!same) throw new LicenseError("changed", 409);
  }

  // 1. reserve: move the end date only if nobody changed it meanwhile
  const from = existing && isActive(existing) && existing.expires_at ? existing.expires_at : now;
  const newEnd = def.days ? new Date(new Date(from).getTime() + def.days * DAY) : null;
  let lic;
  if (existing) {
    lic = await License.findOneAndUpdate(
      { _id: existing._id, expires_at: existing.expires_at },
      { $set: { expires_at: newEnd, ...(isActive(existing) ? {} : { started_at: now }) }, $inc: { renewals: isActive(existing) ? 1 : 0 } },
      { returnDocument: "after" },
    );
    if (!lic) throw new LicenseError("busy", 409);
  } else {
    try {
      lic = await License.create({ customer_id: customer._id, business_id: business._id, product, item, started_at: now, expires_at: newEnd });
    } catch (err) {
      if (err.code === 11000) throw new LicenseError("busy", 409);
      throw err;
    }
  }

  // 2. pay; if that fails, undo the reservation
  let tx = null;
  if (price > 0) {
    try {
      tx = await coin.transfer({
        from: await coin.getCustomerWallet(customer._id),
        to: await coin.getTreasury(),
        amount: price,
        note: `${product}${item ? `: ${item}` : ""}${def.days ? ` · ${def.days} days` : ""} · ${business.name}`,
        customerId: customer._id,
        type: "spend",
        businessId: business._id,
        service: def.service,
        max: 100000,
      });
    } catch (err) {
      if (existing) await License.updateOne({ _id: lic._id }, { $set: { expires_at: existing.expires_at, started_at: existing.started_at, renewals: existing.renewals } });
      else await License.deleteOne({ _id: lic._id });
      if (err instanceof coin.CoinError) {
        const wallet = await coin.getCustomerWallet(customer._id);
        throw new LicenseError("noCoins", 402, { price, balance: wallet.balance });
      }
      throw err;
    }
  }
  lic = await License.findByIdAndUpdate(lic._id, { $inc: { total_paid: price }, $set: { last_paid_at: now } }, { returnDocument: "after" }).lean();
  return { license: lic, status: statusOf(lic), charged: price, balance: tx ? tx.from_balance_after : undefined };
}

module.exports = { buy, statusOf, isActive, licensesOf, hasLicense, LicenseError, DAY };
