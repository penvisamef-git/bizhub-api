const ActivityLog = require("../v1/admin/activity_log/activity_log.model");
const ActivityLogCategory = require("../v1/admin/activity_log_category/activity_log_category.model");
const helper = require("./helper");
const { activityLogType } = require("./activity_log_type");

const categoryCache = new Map(); // title → category (they never change)

// Find or create the log category (unknown titles fall back to "other")
async function getCategory(categoryTitle) {
  const list = activityLogType();
  const category =
    list.find((cat) => cat.title.toLowerCase() === String(categoryTitle || "").toLowerCase()) ||
    list.find((cat) => cat.id === 0);

  if (categoryCache.has(category.title)) return categoryCache.get(category.title);
  let categoryDoc = await ActivityLogCategory.findOne({ title: category.title });
  if (!categoryDoc) {
    categoryDoc = await ActivityLogCategory.create({
      name: category.title,
      title: category.title,
      status: true,
    });
  }
  categoryCache.set(category.title, categoryDoc);
  return categoryDoc;
}

// (awaited on purpose: on serverless hosting like Vercel, work after the response can be lost)
async function logActivity({ title, description, categoryTitle, createdBy, req }) {
  const device = helper.extractDeviceInfo(req);
  try {
    const categoryDoc = await getCategory(categoryTitle);

    await ActivityLog.create({
      title,
      description,
      activity_log_category_id: categoryDoc._id,
      create_by_id: createdBy,
      device,
      time: helper.cambodiaDate(),
    });
  } catch (err) {
    console.error("Failed to log activity:", err.message);
    // Don't throw here to avoid crashing the main request flow
  }
}

module.exports = { logActivity };
