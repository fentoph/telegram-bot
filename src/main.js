const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const { createChatLister } = require("./chat-lister");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = String(process.env.TELEGRAM_ADMIN_IDS || process.env.TELEGRAM_OWNER_ID || "").split(",").map(v => v.trim()).filter(Boolean);
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!ADMIN_IDS.length) throw new Error("TELEGRAM_ADMIN_IDS is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const app = express();
app.use(express.json({ limit: "1mb" }));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 5
});
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
let chatLister;

async function telegram(method, body = {}) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram API error: ${response.status}`);
  return data.result;
}

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS telegram_chats (
    id BIGSERIAL PRIMARY KEY,
    chat_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('group','supergroup','channel')),
    title TEXT,
    username TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS broadcast_logs (
    id BIGSERIAL PRIMARY KEY,
    source_message_id BIGINT NOT NULL,
    source_chat_id TEXT NOT NULL,
    target_chat_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent','failed')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_telegram_chats_active ON telegram_chats(active)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_broadcast_logs_created_at ON broadcast_logs(created_at DESC)");
}

function isAdmin(m) {
  return ADMIN_IDS.includes(String(m?.from?.id || ""));
}

function getMessage(u) {
  return u.message || u.channel_post || null;
}

function getCommand(text) {
  if (!text || !text.startsWith("/")) return null;
  return text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
}

function getCommandArgs(text) {
  if (!text || !text.startsWith("/")) return [];
  return text.trim().split(/\s+/).slice(1);
}

async function saveChat(c) {
  await pool.query(
    `INSERT INTO telegram_chats(chat_id,type,title,username,active)
     VALUES($1,$2,$3,$4,TRUE)
     ON CONFLICT(chat_id) DO UPDATE SET
       type=EXCLUDED.type,
       title=EXCLUDED.title,
       username=EXCLUDED.username,
       active=TRUE,
       updated_at=NOW()`,
    [String(c.id), c.type, c.title || null, c.username || null]
  );
}

async function deactivateChat(id) {
  await pool.query("UPDATE telegram_chats SET active=FALSE,updated_at=NOW() WHERE chat_id=$1", [String(id)]);
}

async function getActiveChats() {
  return (await pool.query("SELECT chat_id,type,title,username FROM telegram_chats WHERE active=TRUE ORDER BY id")).rows;
}

async function isChatAdmin(chatId, userId) {
  const admins = await telegram("getChatAdministrators", { chat_id: chatId });
  return admins.some(a => String(a.user.id) === String(userId));
}

async function getBotMember(chatId) {
  const me = await telegram("getMe");
  return telegram("getChatMember", { chat_id: chatId, user_id: me.id });
}

async function verifyBotCanBroadcast(c) {
  const member = await getBotMember(c.id);
  if (!["administrator", "creator"].includes(member.status)) {
    throw new Error("Bot chatda administrator emas.");
  }

  if (c.type === "channel" && member.status === "administrator" && member.can_post_messages !== true) {
    throw new Error("Bot kanal administratori, lekin 'Post Messages / Xabar joylash' huquqi berilmagan.");
  }

  if (["group", "supergroup"].includes(c.type) && member.status === "administrator" && member.can_post_messages === false) {
    throw new Error("Botda guruhga xabar yuborish huquqi yo'q.");
  }

  return member;
}

async function resolveAndConnect(chatRef, userId) {
  const c = await telegram("getChat", { chat_id: chatRef });

  if (!["group", "supergroup", "channel"].includes(c.type)) {
    throw new Error("Faqat guruh, superguruh yoki kanal ulanishi mumkin.");
  }

  if (userId != null && !(await isChatAdmin(c.id, userId))) {
    throw new Error("Siz ushbu chat administratori emassiz.");
  }

  await verifyBotCanBroadcast(c);
  await saveChat(c);
  return c;
}

async function sendText(chatId, text) {
  return telegram("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

async function connectChat(m) {
  const args = getCommandArgs(m.text || m.caption);
  const c = m.chat;

  // The reliable channel flow: admin sends /connect @channelusername to the bot privately.
  if (c.type === "private") {
    if (!isAdmin(m)) return sendText(c.id, "❌ Sizda ushbu botdan foydalanish huquqi yo'q.");

    if (!args.length) {
      return sendText(
        c.id,
        "🔗 Chat ulash\n\n" +
        "Guruh yoki kanalni botga ulash uchun:\n" +
        "/connect @username\n\n" +
        "Masalan:\n/connect @fentoph_channel\n\n" +
        "Kanal uchun bot administrator bo'lishi va 'Post Messages / Xabar joylash' huquqiga ega bo'lishi kerak."
      );
    }

    try {
      const target = await resolveAndConnect(args[0], m.from.id);
      return sendText(
        c.id,
        `✅ Chat muvaffaqiyatli ulandi.\n\n${target.type === "channel" ? "📣 Kanal" : "👥 Guruh"}: ${target.title || target.username || target.id}\n🆔 ${target.id}`
      );
    } catch (e) {
      return sendText(c.id, `❌ Ulanmadi.\n\n${String(e.message || e)}`);
    }
  }

  if (!["group", "supergroup", "channel"].includes(c.type)) {
    return sendText(c.id, "❌ /connect faqat guruh, superguruh yoki kanalda ishlaydi.");
  }

  try {
    // In a channel_post there is no normal m.from user. The bot's admin status
    // is therefore the authoritative check for a direct channel /connect.
    if (c.type !== "channel" && (!m.from || !(await isChatAdmin(c.id, m.from.id)))) {
      return sendText(c.id, "❌ Faqat chat administratori botni ulashi mumkin.");
    }

    await resolveAndConnect(c.id, c.type === "channel" ? null : m.from.id);
    return sendText(
      c.id,
      `✅ Ulandi: ${c.title || "Telegram chat"}\n\nBu ${c.type === "channel" ? "kanal" : "chat"} broadcast ro'yxatiga qo'shildi.`
    );
  } catch (e) {
    return sendText(c.id, `❌ Chatni ulab bo'lmadi.\n\n${String(e.message || e)}`);
  }
}

async function disconnectChat(m) {
  const args = getCommandArgs(m.text || m.caption);
  const c = m.chat;

  if (c.type === "private") {
    if (!isAdmin(m)) return sendText(c.id, "❌ Sizda ushbu botdan foydalanish huquqi yo'q.");
    if (!args.length) return sendText(c.id, "🔗 Uzish uchun:\n/disconnect @username");

    try {
      const target = await telegram("getChat", { chat_id: args[0] });
      await deactivateChat(target.id);
      return sendText(c.id, `🔴 Uzildi: ${target.title || target.username || target.id}`);
    } catch (e) {
      return sendText(c.id, `❌ Chatni uzib bo'lmadi.\n\n${String(e.message || e)}`);
    }
  }

  if (!["group", "supergroup", "channel"].includes(c.type)) return;

  try {
    if (c.type !== "channel" && (!m.from || !(await isChatAdmin(c.id, m.from.id)))) {
      return sendText(c.id, "❌ Faqat chat administratori botni uzishi mumkin.");
    }
    await deactivateChat(c.id);
    return sendText(c.id, "🔴 Ushbu chat broadcast ro'yxatidan chiqarildi.");
  } catch (e) {
    return sendText(c.id, `❌ Uzib bo'lmadi.\n\n${String(e.message || e)}`);
  }
}

async function listChats(m) {
  if (!isAdmin(m)) return;
  const chats = await getActiveChats();
  if (!chats.length) return sendText(m.chat.id, "📡 Hozircha ulangan guruh yoki kanallar yo'q.");
  await sendText(
    m.chat.id,
    `📡 Ulangan chatlar: ${chats.length} ta\n\n${chats.map((c, i) => `${i + 1}. ${c.type === "channel" ? "📣" : "👥"} ${c.title || c.username || c.chat_id} (${c.chat_id})`).join("\n")}`
  );
}

async function adminPanel(m) {
  if (!isAdmin(m)) return;
  const chats = await getActiveChats();
  return sendText(
    m.chat.id,
    "🛠 ADMIN PANEL\n\n👥 Ulangan chatlar: " + chats.length + " ta\n\n/groups — ulangan chatlar\n/connect @username — chat ulash\n/disconnect @username — chatni uzish"
  );
}

async function broadcast(m) {
  const chats = await getActiveChats();
  let sent = 0;
  let failed = 0;

  for (const c of chats) {
    try {
      await telegram("copyMessage", {
        chat_id: c.chat_id,
        from_chat_id: m.chat.id,
        message_id: m.message_id
      });
      await pool.query(
        "INSERT INTO broadcast_logs(source_message_id,source_chat_id,target_chat_id,status) VALUES($1,$2,$3,'sent')",
        [m.message_id, String(m.chat.id), c.chat_id]
      );
      sent++;
    } catch (e) {
      failed++;
      const err = String(e.message || e).slice(0, 1000);
      await pool.query(
        "INSERT INTO broadcast_logs(source_message_id,source_chat_id,target_chat_id,status,error) VALUES($1,$2,$3,'failed',$4)",
        [m.message_id, String(m.chat.id), c.chat_id, err]
      );
      if (/chat not found|kicked|not enough rights|forbidden/i.test(err)) await deactivateChat(c.chat_id);
    }
    await new Promise(r => setTimeout(r, 55));
  }

  await sendText(m.chat.id, `📢 Broadcast yakunlandi.\n\n✅ Yetkazildi: ${sent}\n❌ Xatolik: ${failed}`);
}

async function handleUpdate(u) {
  const m = getMessage(u);
  if (!m) return;
  const cmd = getCommand(m.text || m.caption);

  if (cmd === "/connect") return connectChat(m);
  if (cmd === "/disconnect") return disconnectChat(m);
  if (cmd === "/listmy") return chatLister.list(m);

  if (m.chat.type !== "private") return;
  if (!isAdmin(m)) return sendText(m.chat.id, "❌ Sizda ushbu botdan foydalanish huquqi yo'q.");

  if (cmd === "/start" || cmd === "/help") {
    return sendText(
      m.chat.id,
      "🤖 Telegram Broadcast Bot\n\nMenga yuborgan xabaringiz ulangan barcha guruh va kanallarga nusxalanadi.\n\n/admin — admin panel\n/groups — ulangan chatlar\n/connect @username — chat ulash\n/disconnect @username — chatni uzish\n/help — yordam"
    );
  }

  if (cmd === "/admin") return adminPanel(m);
  if (cmd === "/groups") return listChats(m);
  if (cmd) return;
  return broadcast(m);
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "telegram-bot" });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/cron/db-cleanup", async (req, res) => {
  const expected = process.env.DB_CLEANUP_SECRET || "";
  const queryToken = String(req.query.token || "");
  const auth = String(req.get("authorization") || "");
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const supplied = headerToken || queryToken;
  if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.sendStatus(401);
  }

  try {
    const retentionDays = Number(process.env.BROADCAST_LOG_RETENTION_DAYS || 30);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      return res.status(500).json({ ok: false, error: "Invalid retention configuration" });
    }
    const result = await pool.query(
      "DELETE FROM broadcast_logs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')",
      [retentionDays]
    );
    return res.json({ ok: true, deletedBroadcastLogs: result.rowCount, retentionDays });
  } catch (e) {
    console.error("DB cleanup failed:", e);
    return res.status(500).json({ ok: false });
  }
});

app.post("/telegram/webhook", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const s = req.get("x-telegram-bot-api-secret-token");
    if (!s || s.length !== WEBHOOK_SECRET.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(WEBHOOK_SECRET))) {
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200);
  try {
    await handleUpdate(req.body);
  } catch (e) {
    console.error("Update handling error:", e);
  }
});

app.get("/", (_req, res) => res.json({ service: "Fentoph Telegram Broadcast Bot", status: "running" }));

async function configureWebhook() {
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (!publicUrl) {
    console.warn("RENDER_EXTERNAL_URL is not set; webhook was not configured automatically.");
    return;
  }

  const webhookUrl = `${publicUrl.replace(/\/$/, "")}/telegram/webhook`;
  await telegram("setWebhook", {
    url: webhookUrl,
    secret_token: WEBHOOK_SECRET || undefined,
    allowed_updates: ["message", "channel_post"]
  });
  console.log(`Telegram webhook configured: ${webhookUrl}`);
}

async function main() {
  await initDb();
  chatLister = createChatLister({ isAdmin, sendText });
  await configureWebhook();
  app.listen(PORT, "0.0.0.0", () => console.log(`Server listening on port ${PORT}`));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
