// Fake-GPS check (att_gps_guard, yearly): clock-ins / outs from a phone whose location looks made up go to review.
//   gps_zero — the phone says its accuracy is 0 m (real GPS never is; location-faking apps often send it)
//   gps_jump — from the last record with a location, the phone would have had to travel faster than 250 km/h
//   gps_same — exactly the same coordinates (to ~1 cm) as an earlier record on another day: a pinned fake spot
const M = require("./attendance.models");
const C = require("./attendance.calc");

const MAX_KMH = 250;
async function gpsFlags({ bid, staffId, lat, lng, accuracy, now = Date.now(), day }) {
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const flags = [];
  if (accuracy !== null && accuracy !== undefined && Number(accuracy) <= 0) flags.push("gps_zero");
  const prev = await M.AttPunch.findOne({ business_id: bid, staff_id: staffId, lat: { $ne: null }, lng: { $ne: null }, at: { $gte: new Date(now - 24 * C.HOUR) } })
    .sort({ at: -1 })
    .lean();
  if (prev) {
    const km = C.distanceM(lat, lng, prev.lat, prev.lng) / 1000;
    const hours = Math.max((now - new Date(prev.at).getTime()) / C.HOUR, 1 / 60);
    if (km > 2 && km / hours > MAX_KMH) flags.push("gps_jump");
  }
  const near = (v) => ({ $gte: v - 1e-7, $lte: v + 1e-7 });
  const same = await M.AttPunch.exists({ business_id: bid, staff_id: staffId, lat: near(lat), lng: near(lng), ...(day ? { day: { $ne: day } } : {}) });
  if (same) flags.push("gps_same");
  return flags;
}
module.exports = { gpsFlags, MAX_KMH };
