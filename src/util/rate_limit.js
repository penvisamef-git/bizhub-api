// Small in-memory rate limit for public forms (login, sign-up).
// Good enough for one server. With several servers, move this to Redis/MongoDB.
function rate_limit({ windowMs = 15 * 60 * 1000, max = 20, message = "សូមព្យាយាមម្តងទៀតក្រោយមួយភ្លែត!" } = {}) {
  const hits = new Map(); // ip → { count, reset }

  setInterval(() => {
    const now = Date.now();
    for (const [ip, hit] of hits) if (hit.reset <= now) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    if (process.env.NODE_ENV === "test") return next();
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const hit = hits.get(ip);
    if (!hit || hit.reset <= now) {
      hits.set(ip, { count: 1, reset: now + windowMs });
      return next();
    }
    hit.count += 1;
    if (hit.count > max) {
      res.set("Retry-After", String(Math.ceil((hit.reset - now) / 1000)));
      return res.status(429).json({ success: false, message });
    }
    next();
  };
}

module.exports = { rate_limit };
