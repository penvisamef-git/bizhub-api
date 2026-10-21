// Point the BizHub Telegram bot at this API by hand (normally the API does it by itself on start,
// when API_PUBLIC_URL is set or it runs on Vercel). Super admins can also do it: Website settings → Telegram bot.
//   npm run telegram:webhook https://api.your-domain.com
require("dotenv").config();
const { secret } = require("../src/telegram");
const base = (process.argv[2] || process.env.API_PUBLIC_URL || "").replace(/\/+$/, "");
const token = process.env.TELEGRAM_BOT_TOKEN;
(async () => {
  if (!token) return console.log("Set TELEGRAM_BOT_TOKEN in .env first.");
  if (!/^https:\/\//.test(base)) return console.log("Usage: npm run telegram:webhook https://api.your-domain.com");
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${base}/api/public/telegram/${secret()}`, secret_token: secret(), allowed_updates: ["message"] }),
  });
  console.log(await res.json());
})();
