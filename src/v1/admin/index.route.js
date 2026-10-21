const index = (prop) => {
  // Declaration
  prop.main_route = "api/admin";

  // ================= Core =================
  const authRoute = require("./auth/auth.route");
  authRoute(prop);
  const sessionRoute = require("./session/session.route");
  sessionRoute(prop);
  const userRoute = require("./user/user.route");
  userRoute(prop);
  const activityLogRoute = require("./activity_log/activity_log.route");
  activityLogRoute(prop);
  const uploadRoute = require("./upload/upload.route");
  uploadRoute(prop);
};

module.exports = index;
