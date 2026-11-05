import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3009;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory active sessions
const activeSessions = new Map();

/**
 * Format phone number to WhatsApp JID (e.g. 628123456789@s.whatsapp.net)
 */
function toJid(phone) {
  let clean = phone.replace(/@c\.us|@s\.whatsapp\.net/g, '').replace(/\D+/g, '');
  if (clean.startsWith('0')) {
    clean = '62' + clean.slice(1);
  }
  return clean + '@s.whatsapp.net';
}

/**
 * Initialize / Resume a Baileys session
 */
async function initSession(sessionId, webhookUrl = null) {
  if (activeSessions.has(sessionId)) {
    const existing = activeSessions.get(sessionId);
    if (existing.status === 'connected' || existing.status === 'qr_ready') {
      if (webhookUrl) existing.webhookUrl = webhookUrl;
      return existing;
    }
  }

  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`[Session: ${sessionId}] Initializing with Baileys v${version.join('.')}, isLatest: ${isLatest}`);

  const sessionData = {
    sessionId,
    webhookUrl: webhookUrl || null,
    status: 'initializing',
    qr: null,
    phone: null,
    sock: null,
    reconnectAttempts: 0
  };
  activeSessions.set(sessionId, sessionData);

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: ['Hope Sparepart Admin', 'Chrome', '124.0.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    syncFullHistory: false
  });

  sessionData.sock = sock;

  // Save auth state updates
  sock.ev.on('creds.update', saveCreds);

  // Connection events
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[Session: ${sessionId}] New QR Code generated.`);
      try {
        const qrBase64 = await QRCode.toDataURL(qr, {
          width: 320,
          margin: 2,
          color: { dark: '#0f172a', light: '#ffffff' }
        });
        sessionData.qr = qrBase64;
        sessionData.status = 'qr_ready';
      } catch (err) {
        console.error(`[Session: ${sessionId}] QR generation error:`, err);
      }
    }

    if (connection === 'open') {
      const userPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Unknown';
      console.log(`[Session: ${sessionId}] WhatsApp CONNECTED! Phone: ${userPhone}`);
      sessionData.status = 'connected';
      sessionData.phone = userPhone;
      sessionData.qr = null;
      sessionData.reconnectAttempts = 0;

      // Notify webhook of connection
      if (sessionData.webhookUrl) {
        axios.post(sessionData.webhookUrl, {
          event: 'connection.open',
          sessionId,
          status: 'connected',
          phone: userPhone,
          timestamp: Date.now()
        }).catch(e => console.warn(`[Webhook] Connection notify failed:`, e.message));
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[Session: ${sessionId}] Connection closed (status: ${statusCode}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        sessionData.status = 'reconnecting';
        sessionData.reconnectAttempts++;
        const delay = Math.min(sessionData.reconnectAttempts * 3000, 15000);
        console.log(`[Session: ${sessionId}] Reconnecting in ${delay}ms...`);
        setTimeout(() => initSession(sessionId, sessionData.webhookUrl), delay);
      } else {
        console.log(`[Session: ${sessionId}] Logged out permanently. Cleaning up folder.`);
        sessionData.status = 'disconnected';
        sessionData.phone = null;
        sessionData.qr = null;
        activeSessions.delete(sessionId);
        try {
          fs.rmSync(sessionFolder, { recursive: true, force: true });
        } catch (e) {}
      }
    }
  });

  // Incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const messageContent =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '[Media Message]';

      console.log(`[Session: ${sessionId}] Incoming message from ${remoteJid}: "${messageContent}"`);

      if (sessionData.webhookUrl) {
        axios.post(sessionData.webhookUrl, {
          sessionId,
          messageId: msg.key.id,
          from: remoteJid.replace('@s.whatsapp.net', ''),
          text: messageContent,
          timestamp: msg.messageTimestamp,
          raw: msg
        }).catch(e => console.warn(`[Webhook] Error sending to webhook:`, e.message));
      }
    }
  });

  return sessionData;
}

// ── API ROUTES FOR ChatServiceAPI.php ──

/**
 * Health check
 */
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Hope WhatsApp Gateway (Baileys)',
    uptime: process.uptime(),
    activeSessions: activeSessions.size
  });
});

/**
 * POST /api/session/start
 * Initializes session and returns QR code / connection status
 */
app.post('/api/session/start', async (req, res) => {
  const { sessionId, webhookUrl } = req.body;
  if (!sessionId) {
    return res.status(400).json({ success: false, message: 'sessionId is required' });
  }

  try {
    const session = await initSession(sessionId, webhookUrl);

    // Give it a moment to generate QR if initializing
    let attempts = 0;
    while (!session.qr && session.status !== 'connected' && attempts < 15) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }

    return res.json({
      success: true,
      sessionId,
      status: session.status,
      phone: session.phone,
      qr: session.qr || null
    });
  } catch (err) {
    console.error('Failed to start session:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/session/status/:sessionId
 */
app.get('/api/session/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    // Check if session directory exists
    const sessionFolder = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionFolder)) {
      // Resume background init
      initSession(sessionId);
      return res.json({
        success: true,
        sessionId,
        status: 'initializing'
      });
    }
    return res.json({
      success: true,
      sessionId,
      status: 'disconnected'
    });
  }

  return res.json({
    success: true,
    sessionId,
    status: session.status,
    phone: session.phone || null,
    hasQr: !!session.qr
  });
});

/**
 * GET /api/session/qr/:sessionId
 */
app.get('/api/session/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  let session = activeSessions.get(sessionId);

  if (!session) {
    session = await initSession(sessionId);
    let attempts = 0;
    while (!session.qr && session.status !== 'connected' && attempts < 15) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
  }

  return res.json({
    success: true,
    sessionId,
    status: session.status,
    qr: session.qr || null,
    phone: session.phone || null
  });
});

/**
 * POST /api/session/send
 * Sends text, image URL, image base64, or document
 */
app.post('/api/session/send', async (req, res) => {
  const { sessionId, to, text, imageUrl, imageBase64, filename, caption } = req.body;

  if (!sessionId || !to) {
    return res.status(400).json({ success: false, message: 'sessionId and to are required' });
  }

  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'connected' || !session.sock) {
    return res.status(400).json({ success: false, message: 'WhatsApp session is not connected' });
  }

  const jid = toJid(to);

  try {
    let result = null;

    if (imageUrl) {
      // Send image from URL
      result = await session.sock.sendMessage(jid, {
        image: { url: imageUrl },
        caption: caption || ''
      });
    } else if (imageBase64) {
      // Send image from Base64
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      result = await session.sock.sendMessage(jid, {
        image: buffer,
        caption: caption || ''
      });
    } else if (text) {
      // Send text message
      result = await session.sock.sendMessage(jid, {
        text: text
      });
    } else {
      return res.status(400).json({ success: false, message: 'text or imageUrl/imageBase64 required' });
    }

    return res.json({
      success: true,
      messageId: result.key.id,
      status: 'sent',
      to: jid
    });
  } catch (err) {
    console.error(`[Session: ${sessionId}] Send message error:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/session/read
 * Mark chat as read
 */
app.post('/api/session/read', async (req, res) => {
  const { sessionId, chatId } = req.body;
  const session = activeSessions.get(sessionId);
  if (!session || !session.sock) {
    return res.json({ success: true });
  }

  try {
    const jid = toJid(chatId);
    await session.sock.readMessages([{ remoteJid: jid, id: req.body.messageId || '' }]);
    return res.json({ success: true });
  } catch (err) {
    return res.json({ success: true });
  }
});

/**
 * POST /api/session/disconnect
 */
app.post('/api/session/disconnect', async (req, res) => {
  const { sessionId } = req.body;
  const session = activeSessions.get(sessionId);

  if (session && session.sock) {
    try {
      await session.sock.logout();
    } catch (e) {}
    activeSessions.delete(sessionId);
    const sessionFolder = path.join(SESSIONS_DIR, sessionId);
    try {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    } catch (e) {}
  }

  return res.json({ success: true, message: 'Session disconnected' });
});

// Resume all existing sessions on startup
fs.readdir(SESSIONS_DIR, (err, files) => {
  if (err || !files) return;
  for (const f of files) {
    const sPath = path.join(SESSIONS_DIR, f);
    if (fs.statSync(sPath).isDirectory()) {
      console.log(`[Startup] Resuming saved session: ${f}`);
      initSession(f).catch(e => console.warn(`Failed to resume ${f}:`, e.message));
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`  HOPE WHATSAPP GATEWAY (BAILEYS 24/7) ACTIVE  `);
  console.log(`  Listening on port: ${PORT}                  `);
  console.log(`===============================================`);
});
