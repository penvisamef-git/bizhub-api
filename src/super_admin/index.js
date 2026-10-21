// Super admin dashboard (overview numbers). The pages it links to use:
// src/user (customers), src/biz (businesses), src/coin (coins), src/homepage (website)
module.exports = (prop) => {
  require("./overview.route")(prop);
};
