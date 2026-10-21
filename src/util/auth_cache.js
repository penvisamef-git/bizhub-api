// Short memory cache for login checks, so each request does not wait for
// 2–3 MongoDB round trips before it even starts (Atlas is far away = slow).
//
// Safe because: entries live only 30 s, and ANY write to users, customers or
// sessions (logout, suspend, password reset, role change…) clears the whole cache
// right away on this server. With several servers, another server may keep an old
// entry for up to 30 s.
const TTL_MS = 30 * 1000;
const MAX_ENTRIES = 5000;

const store = new Map(); // key → { value, expires }

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttl = TTL_MS) {
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value); // drop the oldest
  store.set(key, { value, expires: Date.now() + ttl });
}

function clear() {
  store.clear();
}

// Clear the cache after any write on these models
const WRITE_OPS = ["save", "deleteOne", "deleteMany", "updateOne", "updateMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "replaceOne", "insertMany"];
function clearOnWrite(schema) {
  WRITE_OPS.forEach((op) => schema.post(op, clear));
}

module.exports = { get, set, clear, clearOnWrite, TTL_MS };
