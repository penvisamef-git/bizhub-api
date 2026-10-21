// Telegram add-on (rest_telegram, yearly): the owner links a Telegram chat to the BizHub bot,
// which sends the daily sales report there (the report itself starts with the POS).
// Base: /api/user/businesses/:id/restaurant/telegram
//   GET    /          status { configured, connected, chat_name, daily_report, report_time }
//   POST   /link      → { url, group_url, expires_at }  open it, press Start → linked (poll GET until connected)
//   PUT    /          { daily_report, report_time: "21:00", shift_open, shift_close, stock_alerts }
//   POST   /test      send a test message
//   DELETE /          disconnect
const M = require("./restaurant.models");
const telegram = require("../../telegram");

const LINK_MINUTES = 15;
const T = {
  needAddon: "សូមដោះសោ “Telegram” ជាមុនសិន!",
  notConfigured: "ក្រុមការងារ BizHub មិនទាន់រៀបចំ Telegram bot ទេ។ សូមព្យាយាមពេលក្រោយ។",
  notConnected: "មិនទាន់ភ្ជាប់ Telegram ទេ!",
  blocked: "Telegram នេះបានបិទ bot ហើយ។ សូមភ្ជាប់ម្តងទៀត។",
  unreachable: "មិនអាចទាក់ទង Telegram បានទេ សូមព្យាយាមម្តងទៀត។",
  sent: "បានផ្ញើសារសាកល្បង!",
  disconnected: "បានផ្តាច់ Telegram!",
};

const statusOf = (s, ctx) => ({
  configured: telegram.ready(),
  active: ctx.addons.rest_telegram.active,
  connected: !!s.telegram?.chat_id,
  chat_name: s.telegram?.chat_name || "",
  chat_type: s.telegram?.chat_type || "",
  connected_at: s.telegram?.connected_at || null,
  daily_report: s.telegram?.daily_report !== false,
  shift_open: s.telegram?.shift_open !== false,
  shift_close: s.telegram?.shift_close !== false,
  stock_alerts: s.telegram?.stock_alerts !== false,
  report_time: s.telegram?.report_time || "21:00",
});
const setMany = (doc, values) => Object.entries(values).forEach(([k, v]) => doc.set(`telegram.${k}`, v));
const nameOf = (s) => s.name_km || s.name_en || "Restaurant";

module.exports = (prop, kit) => {
  const { base, guard, handle, withSettings, Bad, bool, token } = kit;
  const path = `${base}/telegram`;
  const needAddon = (ctx) => {
    if (!ctx.addons.rest_telegram.active) throw new Bad(T.needAddon, 402, { product: "rest_telegram" });
  };
  const fail = (err) => {
    if (err instanceof telegram.TelegramError) throw new Bad(err.message === "not_configured" ? T.notConfigured : err.message === "blocked" ? T.blocked : T.unreachable, err.status);
    throw err;
  };

  // someone pressed Start in Telegram with our code
  telegram.onStart(async (code, chat) => {
    if (!/^[A-Za-z0-9]{12,40}$/.test(code)) return null;
    const s = await M.RestSettings.findOne({ "telegram.link_code": code, "telegram.link_expires": { $gt: new Date() } });
    if (!s) return "⌛️ This link has expired. Open BizHub → Telegram → Connect again.\nតំណនេះផុតកំណត់ហើយ។ សូមចុច “ភ្ជាប់” ម្តងទៀត។";
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "Telegram");
    setMany(s, { chat_id: String(chat.id), chat_name: name.slice(0, 80), chat_type: chat.type || "private", connected_at: new Date(), link_code: "", link_expires: null });
    await s.save();
    const t = s.telegram;
    return `✅ <b>${telegram.escape(nameOf(s))}</b> is connected to this chat.\nបានភ្ជាប់ជាមួយ BizHub ហើយ។\n\n${t.daily_report ? `📊 Daily report: every day at ${t.report_time}.` : ""}`;
  });

  prop.app.get(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, false);
      res.json({ success: true, data: statusOf(settings, ctx) });
    }),
  );

  prop.app.post(
    `${path}/link`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      needAddon(ctx);
      if (!telegram.ready()) throw new Bad(T.notConfigured, 503);
      const bot = await telegram.botUsername().catch(fail);
      const code = token(24);
      const expires = new Date(Date.now() + LINK_MINUTES * 60000);
      settings.set("telegram.link_code", code);
      settings.set("telegram.link_expires", expires);
      await settings.save();
      res.json({ success: true, data: { url: `https://t.me/${bot}?start=${code}`, group_url: `https://t.me/${bot}?startgroup=${code}`, bot, expires_at: expires } });
    }),
  );

  prop.app.put(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      needAddon(ctx);
      const b = req.body || {};
      for (const k of ["daily_report", "shift_open", "shift_close", "stock_alerts"]) if (b[k] !== undefined) settings.set(`telegram.${k}`, bool(b, k));
      if (b.report_time !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.report_time))) throw new Bad(`${kit.MSG.badValue} (report_time)`);
        settings.set("telegram.report_time", b.report_time);
      }
      await settings.save();
      res.json({ success: true, data: statusOf(settings, ctx), message: kit.MSG.saved });
    }),
  );

  prop.app.post(
    `${path}/test`,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      needAddon(ctx);
      if (!settings.telegram?.chat_id) throw new Bad(T.notConnected);
      try {
        await telegram.send(settings.telegram.chat_id, `🔔 <b>${telegram.escape(nameOf(settings))}</b>\nTest message from BizHub — everything works.\nសារសាកល្បងពី BizHub — ដំណើរការល្អ។`);
      } catch (err) {
        if (err instanceof telegram.TelegramError && err.message === "blocked") {
          settings.set("telegram.chat_id", "");
          await settings.save();
        }
        fail(err);
      }
      res.json({ success: true, message: T.sent });
    }),
  );

  prop.app.delete(
    path,
    ...guard,
    handle(async (req, res) => {
      const { ctx, settings } = await withSettings(req, true);
      const chat = settings.telegram?.chat_id;
      setMany(settings, { chat_id: "", chat_name: "", chat_type: "", connected_at: null, link_code: "", link_expires: null });
      await settings.save();
      if (chat) telegram.send(chat, "🔌 BizHub disconnected from this chat.\nបានផ្តាច់ពី BizHub ហើយ។").catch(() => {});
      res.json({ success: true, data: statusOf(settings, ctx), message: T.disconnected });
    }),
  );
};
