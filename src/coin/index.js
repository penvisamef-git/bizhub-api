// Coins: treasury, customer wallets, coin history and top-up cards
module.exports = (prop) => {
  require("./coin.route")(prop);
  require("./topup_card.route")(prop);
};
