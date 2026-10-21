const ActivityLog = require("./activity_log.model");
const ActivityLogCategory = require("../activity_log_category/activity_log_category.model");
const getFilteredMongoDB = require("../../../util/mongo_db/mongoDB_Queries");
const { can_manage_users } = require("../../../util/permission");
const baseRoute = "activity_log";

const route = (prop) => {
  // **************** Declaration ****************
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_users];

  // ===================================== GET LIST (with filter + pagination) ================================================
  // Extra filter: ?category=homepage  (title from activity_log_type.js)
  prop.app.get(`${urlAPI}`, ...guard, async (req, res) => {
    try {
      const extra = [];
      if (req.query.category) {
        const cat = await ActivityLogCategory.findOne({ title: String(req.query.category) });
        extra.push({ activity_log_category_id: cat ? cat._id : null });
      }

      const result = await getFilteredMongoDB(
        req.query,
        ActivityLog,
        [
          { path: "activity_log_category_id", select: "title" },
          { path: "create_by_id", select: "firstname lastname email" },
        ],
        extra,
      );

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  });

  // ===================================== CATEGORIES (dropdown) ================================================
  prop.app.get(`${urlAPI}/category-all`, ...guard, async (req, res) => {
    try {
      const data = await ActivityLogCategory.find({ deleted: false }).sort({ title: 1 });
      res.status(200).json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  });
};

module.exports = route;
