// Team access (v1.5): add other BizHub accounts to one business as Admin or View only.
//
// Everyone:
//   GET  /api/user/team/my-id                         my BizHub ID (made the first time)            → { bizhub_id }
//   GET  /api/user/team/shared                        businesses shared with me + invites waiting   → { businesses, invites }
//   POST /api/user/team/invites/:memberId/accept      accept an invite (by ID)
//   POST /api/user/team/invites/:memberId/decline
//   POST /api/user/team/shared/:businessId/leave      leave a team
//   GET  /api/user/team/join/:code                    what an invite link is for (business, owner, role)
//   POST /api/user/team/join/:code                    join with the link → { business_id, role }
// Owner of the business:
//   GET    /api/user/businesses/:id/team              Team add-on status, price, members, open links
//   POST   /api/user/businesses/:id/team/members      { bizhub_id, role }  → invite by BizHub ID
//   PATCH  /api/user/businesses/:id/team/members/:mid { role }
//   DELETE /api/user/businesses/:id/team/members/:mid remove (access stops at once)
//   POST   /api/user/businesses/:id/team/links        { role }  → { code, expires_at } (one person, 7 days)
//   DELETE /api/user/businesses/:id/team/links/:lid   cancel a link
// The add-on itself is bought like any other: POST /api/user/businesses/:id/licenses/team (5 coins / year).
const crypto = require("crypto");
const mongoose = require("mongoose");
const Business = require("../business.model");
const Customer = require("../../user/customer.model");
const License = require("../../license/license.model");
const { statusOf } = require("../../license/license.service");
const { priceOf } = require("../../homepage/prices");
const { customer_auth } = require("../../user/customer_auth");
const { TeamMember, TeamLink, ROLES } = require("./team.model");
const { teamOn, forget } = require("./team.access");

const LINK_DAYS = 7;
const MAX_OPEN_LINKS = 20;
const MSG = {
  server: "ម៉ាសុីនមេមានបញ្ហា សូមព្យាយាមម្តងទៀតពេលក្រោយ!",
  badId: "មិនមាន ID ត្រឹមត្រូវ!",
  notFound: "រកមិនឃើញអាជីវកម្ម!",
  suspended: "អាជីវកម្មនេះត្រូវបានផ្អាក! សូមទាក់ទងក្រុមការងារ BizHub។",
  locked: "សូមបើកមុខងារក្រុមការងារជាមុនសិន (5 កាក់ / ឆ្នាំ)។ / Unlock Team first (5 coins / year).",
  badRole: "តួនាទីមិនត្រឹមត្រូវ! / Choose Admin or View only.",
  noUser: "រកមិនឃើញ BizHub ID នេះទេ។ / No account with this BizHub ID.",
  self: "នេះជា ID របស់អ្នកផ្ទាល់។ / That's your own ID.",
  already: "អ្នកនេះនៅក្នុងក្រុមរួចហើយ។ / This person is already in the team.",
  memberNotFound: "រកមិនឃើញសមាជិកនេះទេ។ / Team member not found.",
  linkGone: "តំណអញ្ជើញនេះមិនអាចប្រើបានទៀតទេ។ / This invite link has expired or was already used.",
  owner: "អ្នកជាម្ចាស់អាជីវកម្មនេះរួចហើយ។ / You already own this business.",
  tooMany: "មានតំណអញ្ជើញច្រើនពេក។ សូមលុបខ្លះជាមុនសិន។ / Too many open links. Cancel some first.",
  saved: "បានរក្សាទុក! / Saved.",
  invited: "បានផ្ញើការអញ្ជើញ! / Invite sent.",
  removed: "បានដកចេញ! / Removed.",
  joined: "បានចូលក្រុមការងារ! / You joined the team.",
};

const validId = (id) => mongoose.Types.ObjectId.isValid(String(id || "")) && String(new mongoose.Types.ObjectId(String(id))) === String(id);
const cleanId = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^BH/, "");
const asBizhubId = (digits) => `BH-${digits}`;

class Bad extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// BH-482917: 6 digits, unique; made the first time someone needs it
async function ensureBizhubId(customer) {
  if (customer.bizhub_id) return customer.bizhub_id;
  for (let i = 0; i < 8; i++) {
    const id = asBizhubId(String(crypto.randomInt(100000, 1000000)));
    try {
      const r = await Customer.findOneAndUpdate({ _id: customer._id, bizhub_id: { $exists: false } }, { $set: { bizhub_id: id } }, { returnDocument: "after" }).select("bizhub_id").lean();
      if (r) return r.bizhub_id;
      const again = await Customer.findById(customer._id).select("bizhub_id").lean();
      if (again?.bizhub_id) return again.bizhub_id;
    } catch (err) {
      if (err.code !== 11000) throw err; // taken → try another number
    }
  }
  throw new Error("could not make a BizHub ID");
}

// a short code people can type: 6 letters/digits without look-alikes (0/O, 1/I)
function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(0, A.length)];
  return s;
}

const person = (c) => (c ? { _id: c._id, name: c.name, bizhub_id: c.bizhub_id || "", photo: c.photo?.url || "", phone_hint: c.phone ? `${String(c.phone).slice(0, 4)} ••• ${String(c.phone).slice(-3)}` : "" } : null);

module.exports = (prop) => {
  const guard = [prop.api_auth, customer_auth];
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
      if (err?.code === 11000) return res.status(409).json({ success: false, message: MSG.already, code: "already" });
      console.error("[team]", err);
      res.status(500).json({ success: false, message: MSG.server });
    }
  };

  // the owner's business (team settings are for the owner only)
  async function ownBiz(req) {
    if (!validId(req.params.id)) throw new Bad(MSG.badId);
    const business = await Business.findOne({ _id: req.params.id, owner_id: req.customer._id, deleted: false });
    if (!business) throw new Bad(MSG.notFound, 404);
    return business;
  }
  const needOn = async (business) => {
    if (!business.status) throw new Bad(MSG.suspended, 403);
    if (!(await teamOn(business._id))) throw new Bad(MSG.locked, 402, { code: "team_locked", product: "team" });
  };
  const roleOf = (r) => {
    if (!ROLES.includes(r)) throw new Bad(MSG.badRole);
    return r;
  };

  async function teamView(business) {
    const [lic, price, members, links] = await Promise.all([
      License.findOne({ business_id: business._id, product: "team", item: "" }).lean(),
      priceOf("team_year"),
      TeamMember.find({ business_id: business._id }).sort({ created_date: 1 }).lean(),
      TeamLink.find({ business_id: business._id, used_by: null, revoked: false, expires_at: { $gt: new Date() } })
        .sort({ created_date: -1 })
        .lean(),
    ]);
    const people = await Customer.find({ _id: { $in: members.map((m) => m.customer_id) }, deleted: false })
      .select("name bizhub_id photo phone")
      .lean();
    const byId = new Map(people.map((p) => [String(p._id), p]));
    return {
      business: { _id: business._id, name: business.name, category: business.category },
      license: statusOf(lic),
      price,
      members: members
        .filter((m) => byId.has(String(m.customer_id)))
        .map((m) => ({ _id: m._id, role: m.role, status: m.status, via: m.via, joined_at: m.joined_at, created_date: m.created_date, person: person(byId.get(String(m.customer_id))) })),
      links: links.map((l) => ({ _id: l._id, code: l.code, role: l.role, expires_at: l.expires_at })),
    };
  }

  // ===================================== OWNER =====================================
  prop.app.get(
    "/api/user/businesses/:id/team",
    ...guard,
    handle(async (req, res) => {
      const business = await ownBiz(req);
      res.json({ success: true, data: await teamView(business) });
    }),
  );

  prop.app.post(
    "/api/user/businesses/:id/team/members",
    ...guard,
    handle(async (req, res) => {
      const business = await ownBiz(req);
      await needOn(business);
      const role = roleOf(req.body?.role);
      const digits = cleanId(req.body?.bizhub_id);
      if (!/^\d{6}$/.test(digits)) throw new Bad(MSG.noUser, 404, { code: "no_user" });
      const who = await Customer.findOne({ bizhub_id: asBizhubId(digits), deleted: false, status: true }).select("_id").lean();
      if (!who) throw new Bad(MSG.noUser, 404, { code: "no_user" });
      if (String(who._id) === String(req.customer._id)) throw new Bad(MSG.self, 400, { code: "self" });
      const had = await TeamMember.findOne({ business_id: business._id, customer_id: who._id }).lean();
      if (had) throw new Bad(MSG.already, 409, { code: "already" });
      await TeamMember.create({ business_id: business._id, customer_id: who._id, role, status: "invited", via: "id", invited_by: req.customer._id });
      forget(String(business._id));
      res.json({ success: true, data: await teamView(business), message: MSG.invited });
    }),
  );

  prop.app.patch(
    "/api/user/businesses/:id/team/members/:mid",
    ...guard,
    handle(async (req, res) => {
      const business = await ownBiz(req);
      if (!validId(req.params.mid)) throw new Bad(MSG.badId);
      const role = roleOf(req.body?.role);
      const r = await TeamMember.updateOne({ _id: req.params.mid, business_id: business._id }, { $set: { role } });
      if (!r.matchedCount) throw new Bad(MSG.memberNotFound, 404);
      forget(String(business._id));
      res.json({ success: true, data: await teamView(business), message: MSG.saved });
    }),
  );

  prop.app.delete(
    "/api/user/businesses/:id/team/members/:mid",
    ...guard,
    handle(async (req, res) => {
      const business = await ownBiz(req);
      if (!validId(req.params.mid)) throw new Bad(MSG.badId);
      const r = await TeamMember.deleteOne({ _id: req.params.mid, business_id: business._id });
      if (!r.deletedCount) throw new Bad(MSG.memberNotFound, 404);
      forget(String(business._id));
      res.json({ success: true, data: await teamView(business), message: MSG.removed });
    }),
  );

  prop.app.post(
    "/api/user/businesses/:id/team/links",
    ...guard,
    handle(async (req, res) => {
      const business = await ownBiz(req);
      await needOn(business);
      const role = roleOf(req.body?.role);
      const open = await TeamLink.countDocuments({ business_id: business._id, used_by: null, revoked: false, expires_at: { $gt: new Date() } });
      if (open >= MAX_OPEN_LINKS) throw new Bad(MSG.tooMany, 400, { code: "too_many" });
      let link;
      for (let i = 0; i < 6 && !link; i++) {
        try {
          link = await TeamLink.create({ business_id: business._id, code: newCode(), role, expires_at: new Date(Date.now() + LINK_DAYS * 86400000), created_by: req.customer._id });
        } catch (err) {
          if (err.code !== 11000) throw err;
        }
      }
      if (!link) throw new Error("no free code");
      res.json({ success: true, data: { _id: link._id, code: link.code, role: link.role, expires_at: link.expires_at }, team: await teamView(business) });
    }),
  );

  prop.app.delete(
    "/api/user/businesses/:id/team/links/:lid",
    ...guard,
    handle(async (req, res) => {
      const business = await ownBiz(req);
      if (!validId(req.params.lid)) throw new Bad(MSG.badId);
      await TeamLink.updateOne({ _id: req.params.lid, business_id: business._id }, { $set: { revoked: true } });
      res.json({ success: true, data: await teamView(business), message: MSG.removed });
    }),
  );

  // ===================================== ME =====================================
  prop.app.get(
    "/api/user/team/my-id",
    ...guard,
    handle(async (req, res) => {
      res.json({ success: true, data: { bizhub_id: await ensureBizhubId(req.customer) } });
    }),
  );

  // businesses shared with me (only while the owner's Team add-on is on) + invites waiting for me
  prop.app.get(
    "/api/user/team/shared",
    ...guard,
    handle(async (req, res) => {
      const rows = await TeamMember.find({ customer_id: req.customer._id }).lean();
      const bizIds = rows.map((r) => r.business_id);
      const [businesses, licenses] = await Promise.all([
        Business.find({ _id: { $in: bizIds }, deleted: false }).select("name category logo_url status owner_id created_date").lean(),
        License.find({ business_id: { $in: bizIds }, product: "team", item: "" }).select("business_id expires_at").lean(),
      ]);
      const on = new Set(licenses.filter((l) => l.expires_at === null || new Date(l.expires_at) > new Date()).map((l) => String(l.business_id)));
      const owners = await Customer.find({ _id: { $in: businesses.map((b) => b.owner_id) } })
        .select("name")
        .lean();
      const ownerName = new Map(owners.map((o) => [String(o._id), o.name]));
      const byBiz = new Map(businesses.map((b) => [String(b._id), b]));
      const shape = (r) => {
        const b = byBiz.get(String(r.business_id));
        return b && { _id: b._id, name: b.name, category: b.category, logo_url: b.logo_url, status: b.status, owner_name: ownerName.get(String(b.owner_id)) || "", role: r.role, member_id: r._id, team_on: on.has(String(b._id)) };
      };
      res.json({
        success: true,
        data: {
          businesses: rows.filter((r) => r.status === "active").map(shape).filter(Boolean),
          invites: rows.filter((r) => r.status === "invited").map(shape).filter(Boolean),
        },
      });
    }),
  );

  prop.app.post(
    "/api/user/team/invites/:mid/:answer",
    ...guard,
    handle(async (req, res) => {
      if (!validId(req.params.mid) || !["accept", "decline"].includes(req.params.answer)) throw new Bad(MSG.badId);
      const m = await TeamMember.findOne({ _id: req.params.mid, customer_id: req.customer._id, status: "invited" });
      if (!m) throw new Bad(MSG.memberNotFound, 404);
      if (req.params.answer === "decline") await m.deleteOne();
      else {
        m.status = "active";
        m.joined_at = new Date();
        await m.save();
      }
      forget(String(m.business_id));
      res.json({ success: true, data: { business_id: m.business_id, role: m.role, accepted: req.params.answer === "accept" }, message: req.params.answer === "accept" ? MSG.joined : MSG.removed });
    }),
  );

  prop.app.post(
    "/api/user/team/shared/:bid/leave",
    ...guard,
    handle(async (req, res) => {
      if (!validId(req.params.bid)) throw new Bad(MSG.badId);
      await TeamMember.deleteOne({ business_id: req.params.bid, customer_id: req.customer._id });
      forget(String(req.params.bid));
      res.json({ success: true, message: MSG.removed });
    }),
  );

  // ----- invite links -----
  async function liveLink(code) {
    const c = String(code || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 12);
    const link = c && (await TeamLink.findOne({ code: c }));
    if (!link || link.revoked || link.used_by || link.expires_at <= new Date()) throw new Bad(MSG.linkGone, 410, { code: "link_gone" });
    const business = await Business.findOne({ _id: link.business_id, deleted: false }).select("name category logo_url owner_id status");
    if (!business) throw new Bad(MSG.linkGone, 410, { code: "link_gone" });
    return { link, business };
  }

  prop.app.get(
    "/api/user/team/join/:code",
    ...guard,
    handle(async (req, res) => {
      const { link, business } = await liveLink(req.params.code);
      const owner = await Customer.findById(business.owner_id).select("name").lean();
      const mine = String(business.owner_id) === String(req.customer._id);
      const had = await TeamMember.findOne({ business_id: business._id, customer_id: req.customer._id }).select("role status").lean();
      res.json({
        success: true,
        data: { business: { _id: business._id, name: business.name, category: business.category, logo_url: business.logo_url }, owner_name: owner?.name || "", role: link.role, expires_at: link.expires_at, is_owner: mine, already: had ? had.status : null },
      });
    }),
  );

  prop.app.post(
    "/api/user/team/join/:code",
    ...guard,
    handle(async (req, res) => {
      const { link, business } = await liveLink(req.params.code);
      if (String(business.owner_id) === String(req.customer._id)) throw new Bad(MSG.owner, 400, { code: "owner" });
      if (!(await teamOn(business._id))) throw new Bad(MSG.linkGone, 410, { code: "link_gone" });
      // the link is one person's: take it first, so two people opening it at once can't both join
      const took = await TeamLink.findOneAndUpdate({ _id: link._id, used_by: null, revoked: false }, { $set: { used_by: req.customer._id, used_at: new Date() } });
      if (!took) throw new Bad(MSG.linkGone, 410, { code: "link_gone" });
      await TeamMember.updateOne(
        { business_id: business._id, customer_id: req.customer._id },
        { $set: { role: link.role, status: "active", via: "link", joined_at: new Date() }, $setOnInsert: { invited_by: link.created_by } },
        { upsert: true },
      );
      forget(String(business._id));
      await ensureBizhubId(req.customer).catch(() => {}); // so the owner's list shows who joined
      res.json({ success: true, data: { business_id: business._id, role: link.role }, message: MSG.joined });
    }),
  );
};

module.exports.ensureBizhubId = ensureBizhubId;
