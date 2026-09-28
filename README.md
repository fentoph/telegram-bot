# Fentoph Telegram Broadcast Bot

Owner-controlled Telegram bot that copies messages sent to the bot into every connected group and channel.

## Features
- Telegram webhook architecture for Render
- PostgreSQL persistence for connected chats
- /connect and /disconnect
- Only the configured owner can broadcast
- copyMessage preserves Telegram message types
- Broadcast delivery logs
- Automatic deactivation of inaccessible chats
- Webhook secret validation
- Render health check

## Environment
TELEGRAM_BOT_TOKEN=...
TELEGRAM_OWNER_ID=...
DATABASE_URL=...
TELEGRAM_WEBHOOK_SECRET=...
PORT=10000

Render provides RENDER_EXTERNAL_URL automatically.

## Setup
1. Create a bot with BotFather.
2. Regenerate the token if it was ever exposed.
3. Set the owner's numeric Telegram ID.
4. Create PostgreSQL and set DATABASE_URL.
5. Deploy to Render.
6. Add the bot as administrator to target groups/channels.
7. Send /connect in each target chat.
8. Message the bot privately to broadcast.