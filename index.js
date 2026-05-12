// ─────────────────────────────────────────────────────────
//  Minecraft AFK Bot for Aternos  –  Railway-ready
//  • Auto-reconnects on disconnect / kick / error
//  • Sends /register 1234  on first spawn
//  • Anti-AFK: random movement + head look every few seconds
//  • Tiny Express health-check so Railway keeps the dyno alive
// ─────────────────────────────────────────────────────────

const mineflayer = require('mineflayer');
const express = require('express');

// ── Configuration (set via environment variables or defaults) ──
const BOT_CONFIG = {
  host: process.env.MC_HOST || 'RotiChor_SMP.aternos.me',   // Aternos server address
  port: parseInt(process.env.MC_PORT || '51111', 10),
  username: process.env.MC_USERNAME || 'hacker',           // offline-mode username
  version: process.env.MC_VERSION || false,                 // auto-detect, or e.g. '1.20.4'
  auth: process.env.MC_AUTH || 'offline',                   // 'offline' for cracked / Aternos default
};

const REGISTER_PASSWORD = process.env.REGISTER_PASSWORD || '1234';
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '10000', 10); // 10 s
const ANTI_AFK_INTERVAL_MS = parseInt(process.env.ANTI_AFK_INTERVAL || '15000', 10); // 15 s
const HEALTH_PORT = parseInt(process.env.PORT || '3000', 10);

// ── State ──
let bot = null;
let antiAfkTimer = null;
let reconnectTimeout = null;
let isConnecting = false;

// ── Logging helper ──
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─────────────────────────────────────────────────────────
//  Anti-AFK: random walk + look
// ─────────────────────────────────────────────────────────
function startAntiAfk() {
  stopAntiAfk();

  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity) return;

    try {
      // Random control-state walk for 1-3 seconds
      const directions = ['forward', 'back', 'left', 'right'];
      const dir = directions[Math.floor(Math.random() * directions.length)];

      bot.setControlState(dir, true);

      // Also jump occasionally
      if (Math.random() > 0.5) {
        bot.setControlState('jump', true);
      }

      // Random head look
      const yaw = (Math.random() * Math.PI * 2) - Math.PI;
      const pitch = (Math.random() * 0.8) - 0.4;
      bot.look(yaw, pitch, false);

      // Swing arm for extra "presence"
      if (Math.random() > 0.7) {
        bot.swingArm();
      }

      // Stop movement after a short burst
      setTimeout(() => {
        if (!bot) return;
        bot.clearControlStates();
      }, 800 + Math.random() * 1500);

    } catch (err) {
      log(`Anti-AFK error (non-fatal): ${err.message}`);
    }
  }, ANTI_AFK_INTERVAL_MS);

  log('Anti-AFK movement started');
}

function stopAntiAfk() {
  if (antiAfkTimer) {
    clearInterval(antiAfkTimer);
    antiAfkTimer = null;
  }
}

// ─────────────────────────────────────────────────────────
//  Bot creation & event handling
// ─────────────────────────────────────────────────────────
function createBot() {
  if (isConnecting) return;
  isConnecting = true;

  stopAntiAfk();

  log(`Connecting to ${BOT_CONFIG.host}:${BOT_CONFIG.port} as "${BOT_CONFIG.username}" ...`);

  bot = mineflayer.createBot({
    host: BOT_CONFIG.host,
    port: BOT_CONFIG.port,
    username: BOT_CONFIG.username,
    version: BOT_CONFIG.version || undefined,
    auth: BOT_CONFIG.auth,
    hideErrors: false,
    checkTimeoutInterval: 60000,     // longer timeout to avoid false disconnects
    keepAlive: true,
  });

  // ── Login ──
  bot.once('login', () => {
    log('Logged in to server!');
    isConnecting = false;
  });

  // ── Spawn: register + start anti-AFK ──
  let hasRegistered = false;

  bot.once('spawn', () => {
    log('Bot spawned in world');

    // Auto-register after a short delay (server needs a moment)
    setTimeout(() => {
      if (!hasRegistered) {
        log(`Sending /register ${REGISTER_PASSWORD}`);
        bot.chat(`/register ${REGISTER_PASSWORD} ${REGISTER_PASSWORD}`);
        hasRegistered = true;

        // Also try /login in case already registered
        setTimeout(() => {
          log(`Sending /login ${REGISTER_PASSWORD}`);
          bot.chat(`/login ${REGISTER_PASSWORD}`);
        }, 3000);
      }

      // Start anti-AFK after registration
      setTimeout(() => {
        startAntiAfk();
      }, 5000);
    }, 2000);
  });

  // ── Chat listener (respond to auth prompts) ──
  bot.on('message', (chatMsg) => {
    const text = chatMsg.toString().toLowerCase();
    log(`[CHAT] ${chatMsg.toString()}`);

    // If the server asks us to register or login, do it
    if (text.includes('register') && text.includes('/register')) {
      log('Server requested registration – sending /register');
      bot.chat(`/register ${REGISTER_PASSWORD} ${REGISTER_PASSWORD}`);
    }
    if (text.includes('login') && text.includes('/login')) {
      log('Server requested login – sending /login');
      bot.chat(`/login ${REGISTER_PASSWORD}`);
    }
  });

  // ── Resource Pack handling ──
  bot.on('resourcePack', (url, hash) => {
    log(`Resource pack requested: ${url}`);
    bot.acceptResourcePack();
    log('Accepted resource pack');
  });

  // ── Kicked ──
  bot.on('kicked', (reason, loggedIn) => {
    log(`Kicked! Reason: ${reason} (loggedIn: ${loggedIn})`);
    scheduleReconnect();
  });

  // ── Connection error ──
  bot.on('error', (err) => {
    log(`Error: ${err.message}`);
    // Don't reconnect on ECONNREFUSED-like errors too quickly
    isConnecting = false;
  });

  // ── Disconnected ──
  bot.on('end', (reason) => {
    log(`Disconnected: ${reason}`);
    stopAntiAfk();
    isConnecting = false;
    scheduleReconnect();
  });
}

// ─────────────────────────────────────────────────────────
//  Reconnect logic
// ─────────────────────────────────────────────────────────
function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s ...`);
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    createBot();
  }, RECONNECT_DELAY_MS);
}

// ─────────────────────────────────────────────────────────
//  Express health-check (keeps Railway process alive)
// ─────────────────────────────────────────────────────────
const app = express();

app.get('/', (_req, res) => {
  const status = bot && bot.entity
    ? {
      status: 'online',
      username: bot.username,
      health: bot.health,
      food: bot.food,
      position: bot.entity.position,
      uptime: process.uptime(),
    }
    : { status: 'connecting', uptime: process.uptime() };

  res.json(status);
});

app.get('/health', (_req, res) => res.send('OK'));

app.listen(HEALTH_PORT, '0.0.0.0', () => {
  log(`Health-check server running on port ${HEALTH_PORT}`);
});

// ─────────────────────────────────────────────────────────
//  Start!
// ─────────────────────────────────────────────────────────
log('=== Minecraft AFK Bot starting ===');
log(`Server: ${BOT_CONFIG.host}:${BOT_CONFIG.port}`);
log(`Username: ${BOT_CONFIG.username}`);
log(`Anti-AFK interval: ${ANTI_AFK_INTERVAL_MS / 1000}s`);
log(`Reconnect delay: ${RECONNECT_DELAY_MS / 1000}s`);
createBot();
