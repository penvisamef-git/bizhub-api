// Coins: treasury, customer wallets, coin history and top-up cards
module.exports = (prop) => {
  require("./coin.route")(prop);
  require("./topup_card.route")(prop);
  require("./google.route")(prop); // coin packs bought in the Android app (Google Play Billing)
  require("./apple.route")(prop); // coin packs bought in the iPhone app (App Store in-app purchase)
};
