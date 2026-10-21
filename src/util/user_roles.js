// Fixed user roles
const USER_ROLES = [
  "អ្នកគ្រប់គ្រងប្រព័ន្ធ", // system administrator (users + everything)
  "បុគ្គលិក", // staff (view only)
];

// Roles from the old menu system. Not selectable any more, but still accepted
// by the user model so old user records can be saved until an admin changes them.
const LEGACY_ROLES = ["អ្នកគ្រប់គ្រងម៉ឺនុយ"];

module.exports = { USER_ROLES, LEGACY_ROLES };
