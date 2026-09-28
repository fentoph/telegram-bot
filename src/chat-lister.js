'use strict';

let TelegramClient;
let StringSession;
let Api;

function loadClient() {
  if (!TelegramClient) {
    ({ TelegramClient, Api } = require('teleproto'));
    ({ StringSession } = require('teleproto/sessions'));
  }
}

function createChatLister({ isAdmin, sendText }) {
  const apiId = Number(process.env.TG_API_ID || 0);
  const apiHash = process.env.TG_API_HASH || '';
  const saved = process.env.TG_SESSION || '';
  let client = null;

  async function list(message) {
    if (!isAdmin(message)) return;

    try {
      if (!apiId || !apiHash || !saved) {
        return sendText(
          message.chat.id,
          '🔐 /listmy uchun MTProto sozlamalari kerak: TG_API_ID, TG_API_HASH va TG_SESSION.'
        );
      }

      loadClient();

      if (!client) {
        client = new TelegramClient(
          new StringSession(saved),
          apiId,
          apiHash,
          { connectionRetries: 5 }
        );
        await client.connect();

        if (!(await client.checkAuthorization())) {
          client = null;
          throw new Error('Saqlangan Telegram sessiyasi avtorizatsiyadan chiqqan.');
        }
      }

      const result = await client.invoke(
        new Api.channels.GetAdminedPublicChannels({})
      );

      const chats = Array.isArray(result?.chats) ? result.chats : [];
      const owned = chats.filter(
        (chat) => chat && chat.username && chat.creator === true
      );

      const channels = owned.filter((chat) => chat.broadcast === true);
      const groups = owned.filter((chat) => chat.megagroup === true);

      let out = '📋 Siz ochgan public chatlar\n\n';

      out += channels.length
        ? '📣 Kanallar:\n' + channels.map((c, i) => (i + 1) + '. ' + c.title + ' — @' + c.username).join('\n') + '\n\n'
        : '📣 Kanallar: yo‘q\n\n';

      out += groups.length
        ? '👥 Guruhlar:\n' + groups.map((c, i) => (i + 1) + '. ' + c.title + ' — @' + c.username).join('\n')
        : '👥 Guruhlar: yo‘q';

      return sendText(message.chat.id, out);
    } catch (error) {
      console.error('listmy:', error?.message || 'unknown error');
      return sendText(message.chat.id, '❌ /listmy ishlamadi.\n\n' + String(error.message || error));
    }
  }

  return { list };
}

module.exports = { createChatLister };
