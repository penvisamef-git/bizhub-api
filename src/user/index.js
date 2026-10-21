// Customer (business owner) accounts
//   /api/user/*             sign-up, login, profile (the customer)
//   /api/admin/customers/*  list, detail, suspend, reset password (super admin)
module.exports = (prop) => {
  require("./user.route")(prop);
  require("./customer.admin.route")(prop);
};
