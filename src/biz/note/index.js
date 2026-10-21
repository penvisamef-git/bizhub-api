// Digital Note: notes shared by link / QR — view, add below, edit together, collect one row per person; files, seen by, history
module.exports = (prop) => {
  require("./note.route")(prop);
  require("./note.public")(prop);
};
