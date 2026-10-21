// Helpers shared by the name card and portfolio routes

// "facebook.com/sokha" → "https://facebook.com/sokha"; "" stays ""; null if it doesn't look like a link
function cleanUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(withProtocol);
    return /\./.test(u.hostname) ? u.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

// What the public page (and the live preview) needs.
function publicView(card, business, { portfolio = false } = {}) {
  return {
    slug: card.slug,
    name: card.name,
    job_title: card.job_title,
    company: card.company,
    bio: card.bio,
    photo: card.photo?.url || "",
    cover: card.cover?.url || "",
    theme: card.theme,
    color: card.color,
    phone1: card.phone1 || "",
    phone2: card.phone2 || "",
    email: card.email || "",
    website: card.website || "",
    address: card.address || "",
    telegram: card.telegram || "",
    facebook: card.facebook || "",
    extras: (card.extras || []).map((x) => ({ label: x.label, value: x.value })),
    business_name: business?.name || "",
    portfolio, // true → card shows a "View portfolio" button
  };
}

module.exports = { cleanUrl, publicView };
