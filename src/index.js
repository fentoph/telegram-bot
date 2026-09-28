const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = String(process.env.TELEGRAM_ADMIN_IDS || process.env.TELEGRAM_OWNER_ID || "").split(",").map(v => v.trim()).filter(Boolean);
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!ADMIN_IDS.length) throw new Error("TELEGRAM_ADMIN_IDS is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const app = express();
app.use(express.json({ limit: "1mb" }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }, max: 5 });
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

async function telegram(method, body = {}) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram API error: ${response.status}`);
  return data.result;
}
async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS telegram_chats (
    id BIGSERIAL PRIMARY KEY, chat_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('group','supergroup','channel')),
    title TEXT, username TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS broadcast_logs (
    id BIGSERIAL PRIMARY KEY, source_message_id BIGINT NOT NULL, source_chat_id TEXT NOT NULL,
    target_chat_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('sent','failed')),
    error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_telegram_chats_active ON telegram_chats(active);
  CREATE INDEX IF NOT EXISTS idx_broadcast_logs_created_at ON broadcast_logs(created_at DESC);`);
}
function isAdmin(m){ return ADMIN_IDS.includes(String(m?.from?.id || "")); }
function getMessage(u){ return u.message || u.channel_post || null; }
function getCommand(text){ if(!text || !text.startsWith("/")) return null; return text.trim().split(/\s+/)[0].split("@")[0].toLowerCase(); }
async function saveChat(c){ await pool.query(`INSERT INTO telegram_chats(chat_id,type,title,username,active) VALUES($1,$2,$3,$4,TRUE)
ON CONFLICT(chat_id) DO UPDATE SET type=EXCLUDED.type,title=EXCLUDED.title,username=EXCLUDED.username,active=TRUE,updated_at=NOW()`,[String(c.id),c.type,c.title||null,c.username||null]); }
async function deactivateChat(id){ await pool.query("UPDATE telegram_chats SET active=FALSE,updated_at=NOW() WHERE chat_id=$1",[String(id)]); }
async function getActiveChats(){ return (await pool.query("SELECT chat_id,type,title,username FROM telegram_chats WHERE active=TRUE ORDER BY id")).rows; }
async function isChatAdmin(chatId,userId){ const admins=await telegram("getChatAdministrators",{chat_id:chatId}); return admins.some(a=>String(a.user.id)===String(userId)); }
async function sendText(chatId,text){ return telegram("sendMessage",{chat_id:chatId,text,disable_web_page_preview:true}); }

async function connectChat(m){
  const c=m.chat; if(!["group","supergroup","channel"].includes(c.type)) return;
  if(c.type!=="channel" && (!m.from || !(await isChatAdmin(c.id,m.from.id)))) return sendText(c.id,"❌ Faqat guruh administratori botni ulashi mumkin.");
  await saveChat(c);
  if(c.type!=="channel") await sendText(c.id,`✅ Ulandi: ${c.title || "Telegram chat"}\n\nBu chat broadcast ro'yxatiga qo'shildi.`);
}
async function disconnectChat(m){
  const c=m.chat; if(!["group","supergroup","channel"].includes(c.type)) return;
  if(c.type!=="channel" && (!m.from || !(await isChatAdmin(c.id,m.from.id)))) return sendText(c.id,"❌ Faqat guruh administratori botni uzishi mumkin.");
  await deactivateChat(c.id); if(c.type!=="channel") await sendText(c.id,"🔴 Ushbu chat broadcast ro'yxatidan chiqarildi.");
}
async function listChats(m){
  if(!isAdmin(m)) return; const chats=await getActiveChats();
  if(!chats.length) return sendText(m.chat.id,"📡 Hozircha ulangan guruh yoki kanallar yo'q.");
  await sendText(m.chat.id,`📡 Ulangan chatlar: ${chats.length} ta\n\n${chats.map((c,i)=>`${i+1}. ${c.type==="channel"?"📣":"👥"} ${c.title||c.username||c.chat_id} (${c.chat_id})`).join("\n")}`);
}
async function adminPanel(m){ if(!isAdmin(m)) return; const chats=await getActiveChats(); return sendText(m.chat.id, "🛠 ADMIN PANEL\n\n👥 Ulangan chatlar: " + chats.length + " ta\n\n/groups — ulangan chatlar\n/connect — ulash\n/disconnect — uzish"); }\nasync function broadcast(m){
  const chats=await getActiveChats(); let sent=0,failed=0;
  for(const c of chats){
    try{
      await telegram("copyMessage",{chat_id:c.chat_id,from_chat_id:m.chat.id,message_id:m.message_id});
      await pool.query(`INSERT INTO broadcast_logs(source_message_id,source_chat_id,target_chat_id,status) VALUES($1,$2,$3,'sent')`,[m.message_id,String(m.chat.id),c.chat_id]); sent++;
    }catch(e){
      failed++; const err=String(e.message||e).slice(0,1000);
      await pool.query(`INSERT INTO broadcast_logs(source_message_id,source_chat_id,target_chat_id,status,error) VALUES($1,$2,$3,'failed',$4)`,[m.message_id,String(m.chat.id),c.chat_id,err]);
      if(/chat not found|kicked|not enough rights|forbidden/i.test(err)) await deactivateChat(c.chat_id);
    }
    await new Promise(r=>setTimeout(r,55));
  }
  await sendText(m.chat.id,`📢 Broadcast yakunlandi.\n\n✅ Yetkazildi: ${sent}\n❌ Xatolik: ${failed}`);
}
async function handleUpdate(u){
  const m=getMessage(u); if(!m) return; const cmd=getCommand(m.text||m.caption);
  if(cmd==="/connect") return connectChat(m); if(cmd==="/disconnect") return disconnectChat(m);
  if(m.chat.type!=="private") return;
  if(!isAdmin(m)) return sendText(m.chat.id,"❌ Sizda ushbu botdan foydalanish huquqi yo'q.");
  if(cmd==="/start"||cmd==="/help") return sendText(m.chat.id,"🤖 Telegram Broadcast Bot\n\nMenga yuborgan xabaringiz ulangan barcha guruh va kanallarga nusxalanadi.\n\n/admin — admin panel\n/groups — ulangan chatlar\n/help — yordam");
  if(cmd==="/admin") return adminPanel(m); if(cmd==="/groups") return listChats(m); if(cmd) return; return broadcast(m);
}
app.get("/health",async(_req,res)=>{try{await pool.query("SELECT 1");res.json({ok:true,service:"telegram-bot"});}catch{res.status(503).json({ok:false});}});
app.post("/telegram/webhook",async(req,res)=>{
  if(WEBHOOK_SECRET){const s=req.get("x-telegram-bot-api-secret-token"); if(!s||s.length!==WEBHOOK_SECRET.length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(WEBHOOK_SECRET))) return res.sendStatus(401);}
  res.sendStatus(200); try{await handleUpdate(req.body);}catch(e){console.error("Update handling error:",e);}
});
app.get("/",(_req,res)=>res.json({service:"Fentoph Telegram Broadcast Bot",status:"running"}));
async function configureWebhook(){
  const publicUrl=process.env.RENDER_EXTERNAL_URL; if(!publicUrl){console.warn("RENDER_EXTERNAL_URL is not set; webhook was not configured automatically.");return;}
  const webhookUrl=`${publicUrl.replace(/\/$/,"")}/telegram/webhook`;
  await telegram("setWebhook",{url:webhookUrl,secret_token:WEBHOOK_SECRET||undefined,allowed_updates:["message","channel_post"]});
  console.log(`Telegram webhook configured: ${webhookUrl}`);
}
async function main(){await initDb();await configureWebhook();app.listen(PORT,"0.0.0.0",()=>console.log(`Server listening on port ${PORT}`));}
main().catch(e=>{console.error(e);process.exit(1);});
process.on("SIGTERM",async()=>{await pool.end();process.exit(0);});