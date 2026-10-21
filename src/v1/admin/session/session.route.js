const mongoose = require("mongoose");
const SessionModel = require("./session.model");
const { logActivity } = require("../../../util/log");
const { can_manage_users } = require("../../../util/permission");
const baseRoute = "session";

const route = (prop) => {
  const urlAPI = `/${prop.main_route}/${baseRoute}`;
  const guard = [prop.api_auth, prop.jwt_auth, prop.request_user, can_manage_users];

  // ===================================== GET LIST ================================================
  // Who is logged in right now (token is never returned)
  prop.app.get(`${urlAPI}`, ...guard, async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 200);

      const [data, total] = await Promise.all([
        SessionModel.find({})
          .select("-access_token -user_data.password")
          .populate("user_id", "firstname lastname email role status")
          .sort({ updated_date: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        SessionModel.countDocuments({}),
      ]);

      res.status(200).json({
        success: true,
        data,
        pagination: {
          total,
          totalPages: Math.ceil(total / limit),
          currentPage: page,
          pageSize: limit,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===================================== DELETE (force logout) ================================================
  prop.app.delete(`${urlAPI}/:id`, ...guard, async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "មិនមាន ID ត្រឹមត្រូវ!" });
      }

      const deleted = await SessionModel.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: "មិនមានទិន្នន័យក្នុងប្រព័ន្ធ!" });
      }

      await logActivity({
        title: `Session របស់ ${deleted.user_data?.email || deleted.user_id} ត្រូវបានបិទ`,
        description: `គណនី: ${req.user.email} បានបង្ខំឱ្យចាកចេញ។`,
        categoryTitle: "auth",
        createdBy: req.user._id,
        req,
      });

      res.status(200).json({ success: true, message: "Session ត្រូវបានលុប!" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
};

module.exports = route;
