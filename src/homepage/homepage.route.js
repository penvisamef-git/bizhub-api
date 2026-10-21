const HomepageModel = require("./homepage.model");
const { validateHomepage } = require("./homepage.validate");
const { logActivity } = require("../util/log");
const { only_super_admin } = require("../util/permission");

const serverError = "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!";
const PUBLIC_FIELDS = "-_id contact coin prices payment_methods app services groups texts updated_date";

// Service types added after the homepage was saved (e.g. digital_note): show them anyway — a service card
// after the others, and in the group the defaults put them in (until the super admin saves the page again).
// Only the types listed here are filled in, so a type the super admin took out of a group stays out.
const NEW_TYPES = ["digital_note"];
function fillNew(data) {
  const { DEFAULT_HOMEPAGE } = require("./homepage.defaults");
  if (!data) return data;
  if (Array.isArray(data.services)) {
    const have = new Set(data.services.map((s) => s.key));
    let n = data.services.length;
    for (const s of DEFAULT_HOMEPAGE.services) if (NEW_TYPES.includes(s.key) && !have.has(s.key)) data.services.push({ ...s, sort_order: n++ });
  }
  if (Array.isArray(data.groups) && data.groups.length) {
    const grouped = new Set(data.groups.flatMap((g) => g.types || []));
    for (const g of DEFAULT_HOMEPAGE.groups)
      for (const t of g.types) {
        if (!NEW_TYPES.includes(t) || grouped.has(t)) continue;
        const target = data.groups.find((x) => x.key === g.key) || data.groups[data.groups.length - 1];
        target.types = [...(target.types || []), t];
        grouped.add(t);
      }
  }
  return data;
}

// The one homepage document (created with defaults the first time)
async function getOrCreate() {
  let doc = await HomepageModel.findOne({ key: "main" });
  if (!doc) doc = await HomepageModel.create({ key: "main" });
  return doc;
}

const route = (prop) => {
  const adminUrl = `/${prop.main_route}/homepage`; // /api/admin/homepage
  const publicUrl = `/${prop.public_route}/homepage`; // /api/public/homepage
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, only_super_admin];

  // ===================================== PUBLIC: website reads this ================================================
  // GET /api/public/homepage → { contact, coin, payment_methods, app, services, texts }
  prop.app.get(publicUrl, async (req, res) => {
    try {
      await getOrCreate();
      const data = fillNew(await HomepageModel.findOne({ key: "main" }).select(PUBLIC_FIELDS).lean());
      // business types paid every year (the others are paid once) — for the prices on the website
      data.yearly = require("../license/license.products").YEARLY_TYPES;
      res.set("Cache-Control", "public, max-age=60"); // browsers may reuse it for 1 minute
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError });
    }
  });

  // ===================================== ADMIN: GET ================================================
  prop.app.get(adminUrl, ...guard, async (req, res) => {
    try {
      const data = fillNew((await getOrCreate()).toObject());
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });

  // ===================================== ADMIN: UPDATE ================================================
  // PUT /api/admin/homepage  body: any of { contact, coin, payment_methods, app, services, texts }
  // Only the parts you send change. texts.en / texts.km replace that language's overrides.
  prop.app.put(adminUrl, ...guard, async (req, res) => {
    try {
      const { set, error } = validateHomepage(req.body);
      if (error) return res.status(400).json({ success: false, message: error });

      await getOrCreate();
      const data = await HomepageModel.findOneAndUpdate({ key: "main" }, { $set: { ...set, updated_by: req.session.user_id } }, { returnDocument: "after", runValidators: true });

      await logActivity({
        title: "គេហទំព័រត្រូវបានកែប្រែ!",
        description: `គណនី: ${req.user.email} បានកែប្រែ: ${Object.keys(set).join(", ")}`,
        categoryTitle: "homepage",
        createdBy: req.session.user_id,
        req,
      });

      res.status(200).json({ success: true, data, message: "គេហទំព័របានរក្សាទុក!" });
    } catch (err) {
      res.status(500).json({ success: false, message: serverError, error: err.message });
    }
  });
};

module.exports = route;
