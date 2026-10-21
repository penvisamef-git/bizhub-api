// Homepage module: website content.
//   GET /api/public/homepage   public (the website reads it)
//   GET /api/admin/homepage    super admin
//   PUT /api/admin/homepage    super admin
module.exports = (prop) => {
  require("./homepage.route")(prop);
};
