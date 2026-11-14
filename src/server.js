// ============================================================
// MEGA TOOLS — MAIN SERVER ENTRY POINT (ENTERPRISE v13.4)
// ============================================================
// FIX-S1..S54: retained.
//
// FIX-S55 (v13.4 — SINGLE EMIT SOURCE for back-to-online):
//   Root cause of the "double back-to-online sound" and residual
//   flicker after FIX-S54:
//     Both socket handlers (`session_init`, `session_heartbeat`)
//     still emitted a `sessionDelta` with `forceOnline: true` when
//     `Session.upsert` reported `statusFlipsToOnline`. Meanwhile
//     `Session.upsert` (FIX-S29) already fired the authoritative
//     eventBus → `sessionStatusDelta` with forceOnline:true.
//     FE hD + hStatus each ran `scheduleBackToOnline` with
//     different transitionIds → 2 sounds.
//
//   FIX:
//     1) `session_init` socket now ALWAYS emits
//        `forceOnline: false` on its `sessionDelta`. It also
//        forwards `transitionId` from `result.transitionId`
//        (FIX-S29) — same token as the eventBus one.
//     2) `session_heartbeat` socket no longer emits any
//        forceOnline delta. The eventBus handles the sound.
//        Its own delta is forceOnline:false (state refresh only).
//     3) `scheduleDeferredOffline` is unchanged — the flip
//        always goes through `Session.updatePresence` (FIX-S28)
//        which fires eventBus.
//     4) eventBus handler is unchanged — single socket emit of
//        `sessionStatusDelta` with full session state.
//     5) No other layer changed — CORS, rate limiters, data.js,
//        sessionManager.js, FE handlers, hysteresis are all
//        untouched.
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
const { EventEmitter } = require('events');

const CONFIG = require('./config');
const db = require('./database');

const sessionManager = require('./services/sessionManager');
const Session = require('./models/Session');
const User = require('./models/User');
const { toStringId } = require('./utils/helpers');
const { authenticate, isOwner, isAdminOrOwner } = require('./middleware/auth');
const { normalizeVisitorId, ownerCodeOf } = require('./utils/identity');

const routes = require('./routes');

let landingHtmlCache = null;
let smartRedirectCache = null;
let megaRuntimeCache = null;

let consolidationState = { ran: false, merged: 0, groups: 0, error: null, at: null };

// FIX-S53: pending deferred-disconnect timers, keyed by session _id.
const pendingDisconnectTimers = new Map();

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
  try { pendingDisconnectTimers.forEach(t => { try { clearTimeout(t); } catch (_) {} }); pendingDisconnectTimers.clear(); } catch (_) {}
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

function detectDeviceClass(uaRaw) {
  const ua = String(uaRaw || '').toLowerCase();
  if (!ua) return 'Unknown';

  if (
    ua.includes('iphone') ||
    ua.includes('ipad') ||
    ua.includes('ipod') ||
    ua.includes('macintosh') ||
    ua.includes('mac os x') ||
    ua.includes('macos')
  ) return 'Apple';

  if (ua.includes('android')) return 'Android';

  if (
    ua.includes('windows nt') ||
    ua.includes('windows phone') ||
    ua.includes('win64') ||
    ua.includes('win32') ||
    ua.includes('windows')
  ) return 'Windows';

  if (ua.includes('linux') || ua.includes('cros') || ua.includes('x11')) return 'Desktop';

  return 'Unknown';
}

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
  'X-Admin-Token',
];

const PUBLIC_CORS_OPTIONS = {
  origin: publicCorsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'DELETE', 'PUT', 'PATCH'],
  allowedHeaders: ALLOWED_HEADERS,
  exposedHeaders: ['Set-Cookie', 'X-Request-Id', 'Retry-After'],
  maxAge: 86400,
};

const STRICT_CORS_OPTIONS = {
  origin: strictCorsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ALLOWED_HEADERS,
  exposedHeaders: ['Set-Cookie', 'X-Request-Id', 'Retry-After'],
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

app.options('*', cors(PUBLIC_CORS_OPTIONS));
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(','));
  res.setHeader('Access-Control-Max-Age', '86400');
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  return res.sendStatus(204);
});

app.get('/api/health', cors(PUBLIC_CORS_OPTIONS), async (req, res) => {
  try {
    const dbHealth = await db.health();
    let foldersCount = 0;
    try { foldersCount = (await db.folders.read()).length; } catch (_) {}
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      version: 'v13.4',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbHealth,
      adminCorsOrigins: CONFIG.ADMIN_ALLOWED_ORIGINS.length,
      publicCorsOpen: CONFIG.PUBLIC_CORS_OPEN,
      publicCorsCredentials: PUBLIC_CORS_OPTIONS.credentials,
      allowedHeadersCount: ALLOWED_HEADERS.length,
      allowedHeaders: ALLOWED_HEADERS,
      consolidation: consolidationState,
      folders: { mounted: !!(routes && routes.foldersRoutes), count: foldersCount },
      rateLimits: {
        windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
        max: CONFIG.RATE_LIMIT_MAX,
        auth: CONFIG.AUTH_RATE_LIMIT_MAX,
        session: CONFIG.SESSION_RATE_LIMIT_MAX,
        data: CONFIG.DATA_RATE_LIMIT_MAX,
        skipPaths: CONFIG.SKIP_RATE_LIMIT_PATHS,
      },
      corsOrder: 'PUBLIC-before-STRICT (FIX-S34)',
      corsHeaderGuarantee: 'FIX-S46 (health/inbox-health/auth all set ACAO)',
      deviceClass: 'Apple | Android | Windows | Desktop | Unknown (FIX-S45)',
      sessionInitMemoryWrite: 'REMOVED (FIX-S48)',
      sessionInitStatusForce: 'FIX-S49 (status:Active + disconnect Offline)',
      autoCleanupGuarantee: 'FIX-S50 (on-boot + health-edge trigger)',
      identityConvergence: 'FIX-S51 (canonical normalizeVisitorId across all routes)',
      backToOnlineNoMiss: 'FIX-S52 (session_init/session_heartbeat carry seq + forceOnline)',
      disconnectDeferred: 'FIX-S53 (12s grace — no flicker on transient stall)',
      singleEmitSource: 'FIX-S54 (Session.eventBus → socket, single status flip emit)',
      singleEmitForceOnlineOff: 'FIX-S55 (session_init/session_heartbeat forceOnline:false)',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/inbox-health', cors(PUBLIC_CORS_OPTIONS), async (req, res) => {
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

    let globalTimer = null;
    try {
      const rawRead = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
      const raw = Array.isArray(rawRead) ? rawRead[0] : rawRead;
      if (raw && typeof raw === 'object') {
        const cycleEnd = Number(raw.cycleEnd) || 0;
        const cycleStart = Number(raw.cycleStart) || 0;
        globalTimer = {
          cycleStart, cycleEnd,
          cycleStartISO: cycleStart ? new Date(cycleStart).toISOString() : null,
          cycleEndISO: cycleEnd ? new Date(cycleEnd).toISOString() : null,
          lastCleanupAt: raw.lastCleanupAt || null,
          cleanupInProgress: !!raw.cleanupInProgress,
          remainingMs: Math.max(0, cycleEnd - now),
        };
      }
    } catch (_) {}

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      database: dbHealth,
      sessions: {
        total: allSessions.length, active: active.length, live: live.length,
        online: online.length, expired: expired.length, uniqueVisitors, totalSubmissions
      },
      socket: { connections: socketCount },
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB'
      },
      config: {
        sessionTimeout: Math.round(CONFIG.SESSION_TIMEOUT_MS / 60000) + 'min',
        heartbeatInterval: Math.round(CONFIG.HEARTBEAT_INTERVAL_MS / 1000) + 's'
      },
      globalTimer
    });

    try { setTimeout(() => sessionManager.globalInboxCleanup().catch(() => {}), 250); } catch (_) {}
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.use('/api/data', cors(PUBLIC_CORS_OPTIONS), routes.dataRoutes);
app.use('/api/webhook', cors(PUBLIC_CORS_OPTIONS), routes.webhookRoutes);
app.use('/api/redirect', cors(PUBLIC_CORS_OPTIONS), routes.redirectRoutes);

function rateLimitKeyGenerator(req) {
  try {
    if (req.user && req.user._id) return 'u:' + toStringId(req.user._id);
  } catch (_) {}
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').toString();
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 40);
  return 'ip:' + ip + ':' + ua;
}

function isMonitoringPath(p) {
  const MONITORING_PREFIXES = [
    '/api/health', '/api/inbox-health',
    '/health', '/ping', '/ready', '/status',
    '/api/ping', '/api/ready', '/api/status',
  ];
  if (!p) return false;
  for (const prefix of MONITORING_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + '/')) return true;
  }
  return false;
}
function isMonitoringIp(req) {
  const allow = CONFIG.MONITORING_ALLOW_IPS || [];
  if (!allow || allow.length === 0) return false;
  const ip = (req.ip || req.connection?.remoteAddress || '').toString().trim();
  if (!ip) return false;
  return allow.includes(ip);
}
function shouldSkipRateLimit(req) {
  if (req.method === 'OPTIONS') return true;
  if (req.headers.upgrade) return true;
  const p = req.path || '';
  if (isMonitoringPath(p)) return true;
  if (isMonitoringIp(req)) return true;
  const exact = CONFIG.SKIP_RATE_LIMIT_EXACT || new Set();
  if (exact.has(p)) return true;
  const skip = CONFIG.SKIP_RATE_LIMIT_PATHS || [];
  return skip.some(s => p === s || p.startsWith(s + '/'));
}

const globalLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  max: CONFIG.RATE_LIMIT_MAX,
  message: { message: 'Too many requests, please try again later.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator, skip: shouldSkipRateLimit,
});
const authLimiter = rateLimit({
  windowMs: 60000, max: CONFIG.AUTH_RATE_LIMIT_MAX || 600,
  message: { message: 'Too many auth requests, please wait a moment.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator, skip: shouldSkipRateLimit,
});
const sessionLimiter = rateLimit({
  windowMs: 60000, max: CONFIG.SESSION_RATE_LIMIT_MAX || 1800,
  message: { message: 'Too many session requests.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator, skip: shouldSkipRateLimit,
});
const dataLimiter = rateLimit({
  windowMs: 60000, max: CONFIG.DATA_RATE_LIMIT_MAX || 1200,
  message: { message: 'Too many tracking requests.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator, skip: shouldSkipRateLimit,
});
const uploadLimiter = rateLimit({
  windowMs: 60000, max: CONFIG.UPLOAD_RATE_LIMIT_MAX || 60,
  message: { message: 'Too many uploads, please slow down.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator, skip: shouldSkipRateLimit,
});
const webhookLimiter = rateLimit({
  windowMs: 60000, max: CONFIG.WEBHOOK_RATE_LIMIT_MAX || 200,
  message: { message: 'Too many webhook requests.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator, skip: shouldSkipRateLimit,
});

app.use('/api/', (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } catch (_) {}
  next();
});

app.use('/api/', globalLimiter);

app.use(cors(STRICT_CORS_OPTIONS));

app.use((req, res, next) => {
  try {
    if (req.headers.origin && !res.getHeader('Access-Control-Allow-Origin')) {
      if (isOriginAllowed(req.headers.origin, CONFIG.ADMIN_ALLOWED_ORIGINS) || !CONFIG.IS_PRODUCTION) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }
    }
  } catch (_) {}
  next();
});

app.use('/api/auth', cors(STRICT_CORS_OPTIONS), authLimiter, routes.authRoutes);
app.use('/api/sessions', cors(STRICT_CORS_OPTIONS), sessionLimiter, routes.sessionsRoutes);
app.use('/api/upload', cors(STRICT_CORS_OPTIONS), uploadLimiter, routes.uploadRoutes);

try {
  if (routes && routes.foldersRoutes) {
    app.use('/api/folders', authLimiter, routes.foldersRoutes);
  } else {
    console.warn('[Server] foldersRoutes not available — skipping /api/folders mount');
  }
} catch (err) {
  console.error('[Server] Failed to mount /api/folders:', err.message);
}

app.use('/api/links', routes.linksRoutes);
app.use('/api/export', routes.exportRoutes);
app.use('/api/theme', routes.themeRoutes);
app.use('/api/trash', routes.trashRoutes);
app.use('/api/generate-page', routes.generatePageRoutes);

app.use('/uploads', express.static(path.join(__dirname, '..', '..', 'uploads')));
app.use('/generated-pages', express.static(path.join(__dirname, '..', 'data', 'generatedPages')));

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'CORS blocked: origin not allowed', origin: req.headers.origin || null });
  }
  return next(err);
});

const server = http.createServer(app);

const socketCorsOrigin = function (origin, callback) { return callback(null, true); };

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

// FIX-S54: single emit source — Session.eventBus → socket.
const sessionEventBus = new EventEmitter();
sessionEventBus.setMaxListeners(50);
Session.eventBus = sessionEventBus;

sessionEventBus.on('session:statusFlip', async (payload) => {
  try {
    if (!payload || !payload.sessionId) return;
    let session = null;
    try {
      session = await Session.findById(payload.sessionId);
    } catch (_) {
      session = null;
    }
    if (!session || !session.trackingCode) return;
    const isOnline = payload.to === 'Online' || session.status === 'Online';
    const forceOnline = payload.from !== 'Online' && isOnline;
    try {
      io.to('room_' + ownerCodeOf(session.trackingCode)).emit(
        'sessionStatusDelta',
        {
          timestamp: new Date().toISOString(),
          seq: nextSocketSeq(),
          sessions: [{
            _id: session._id,
            visitorId: session.visitorId,
            isLive: session.isLive,
            status: session.status,
            lastActivity: session.lastActivity,
            lastSeenAt: session.lastSeenAt,
            trackingCode: session.trackingCode,
            baseCode: session.baseCode || '',
            forceOnline,
            transitionId: payload.transitionId || `${session._id}:${Date.now()}`,
            seq: nextSocketSeq(),
          }],
        }
      );
    } catch (_) {}
  } catch (err) {
    try { console.error('[Server] session:statusFlip handler error:', err.message); } catch (_) {}
  }
});

async function joinUserRooms(socket, user) {
  if (!user) return;
  try {
    const uid = toStringId(user._id);
    socket.join('user_' + uid);
    const trackingCodes = await User.getAccessibleTrackingCodes(user);
    for (const tc of trackingCodes) { if (tc) socket.join('room_' + tc); }
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
    if (!user) { socket.user = null; socket.userId = null; socket.userRole = 'guest'; return next(); }
    if (user.status === 'blocked') { socket.user = null; socket.userId = null; socket.userRole = 'guest'; return next(); }

    const activeJti = user.activeSessionId || null;
    const tokenJti = decoded.jti || null;
    if (activeJti && tokenJti && activeJti !== tokenJti) {
      socket.user = null;
      socket.userId = null;
      socket.userRole = 'guest';
      socket.sessionJti = null;
      return next();
    }

    socket.user = user;
    socket.userId = toStringId(user._id);
    socket.userRole = user.role;
    socket.sessionJti = tokenJti;
    next();
  } catch (err) {
    socket.user = null;
    socket.userId = null;
    socket.userRole = 'guest';
    next();
  }
});

const sessionSockets = {};
const SOCKET_CLEANUP_INTERVAL = 30000;
const DISCONNECT_GRACE_PERIOD = 2000;
const DEFERRED_OFFLINE_GRACE_MS = 12000; // FIX-S53 + FIX-S54: > 10s master cooldown
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
  return normalizeVisitorId({
    visitorId: visitorId || null,
    ip: clientIp && clientIp !== 'unknown' ? clientIp : null,
    trackingCode: trackingCode || null,
  });
}

function emitSessionDelta(io, trackingCode, sessionData) {
  if (!io || !trackingCode) return;
  const ownerCode = ownerCodeOf(trackingCode);
  try { io.to('room_' + ownerCode).emit('sessionDelta', sessionData); } catch (_) {}
  try { if (trackingCode !== ownerCode) io.to('room_' + trackingCode).emit('sessionDelta', sessionData); } catch (_) {}
}

function buildServerSessionDelta(session, opts = {}) {
  const type = opts.type || 'updated';
  const seq = opts.seq || nextSocketSeq();
  const forceOnline = !!opts.forceOnline;
  const lastActivity = session.lastActivity || new Date().toISOString();
  return {
    type,
    seq,
    forceOnline,
    transitionId: opts.transitionId,
    timestamp: new Date().toISOString(),
    session: {
      _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
      isLive: session.isLive, status: session.status || 'Online', lastActivity,
      lastSeenAt: session.lastSeenAt,
      clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType,
      deviceClass: session.deviceClass,
      baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl,
      ip: session.ip, browser: session.browser, formData: session.formData,
      redirectHistory: session.redirectHistory || [], lockedKeys: session.lockedKeys || [],
    },
  };
}

function cancelPendingDisconnect(sessionId) {
  const key = sessionId ? String(sessionId) : '';
  if (!key) return false;
  const t = pendingDisconnectTimers.get(key);
  if (!t) return false;
  try { clearTimeout(t); } catch (_) {}
  pendingDisconnectTimers.delete(key);
  return true;
}

function scheduleDeferredOffline(sessionId, trackingCode, visitorId) {
  const key = sessionId ? String(sessionId) : '';
  if (!key) return;
  cancelPendingDisconnect(key);
  const timer = setTimeout(async () => {
    pendingDisconnectTimers.delete(key);
    try {
      const fresh = await db.sessions.findById(key);
      if (fresh && fresh.isLive === true) return; // reconnected — abort
      await Session.updatePresence(key, { status: 'Offline', isLive: false });
    } catch (err) {
      console.error('[Socket] Deferred Offline error:', err.message);
    }
  }, DEFERRED_OFFLINE_GRACE_MS);
  pendingDisconnectTimers.set(key, timer);
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

      const ua = socket.handshake.headers['user-agent'] || 'Unknown';
      const deviceClass = detectDeviceClass(ua);
      const deviceType = deviceClass === 'Unknown' ? 'Desktop' : deviceClass;

      const result = await Session.upsert({
        visitorId: effectiveVisitorId,
        trackingCode,
        baseCode,
        entryUrl: baseCode,
        currentUrl: baseCode,
        ip: clientIp,
        browser: ua,
        deviceType,
        deviceClass,
        collectedTypes: ['session_init'],
        status: 'Active',
      });

      if (!result || !result.session) {
        console.warn('[Socket] Rejected session_init — invalid trackingCode:', trackingCode);
        return;
      }

      const { session, isNew } = result;

      if (session && session._id) {
        const wasCancelled = cancelPendingDisconnect(session._id);
        if (wasCancelled) {
          console.log('[Socket] session_init cancelled pending deferred-offline:', String(session._id));
        }
      }

      const sessionKey = effectiveVisitorId || (trackingCode + '_' + clientIp);
      sessionSockets[sessionKey] = socket.id;
      if (session._id) {
        sessionSockets[String(session._id)] = socket.id;
        sessionSockets['sid_' + String(session._id)] = socket.id;
      }
      socket.sessionKey = sessionKey;
      socket.sessionId = String(session._id);
      socket.trackingCode = trackingCode;
      socket.visitorId = effectiveVisitorId;

      if (session._id && !session.sessionId) {
        session.sessionId = String(session._id);
        try {
          await db.sessions.findByIdAndUpdate(session._id, {
            sessionId: session.sessionId,
          });
        } catch (_) {}
      }

      // FIX-S55: forceOnline is ALWAYS false here. Session.upsert
      // already fired the authoritative eventBus. The sessionDelta
      // is a pure state refresh — sound is emitted only by hStatus
      // reacting to the eventBus → sessionStatusDelta.
      const sessionData = buildServerSessionDelta(session, {
        type: isNew ? 'new' : 'updated',
        seq: nextSocketSeq(),
        forceOnline: false,
        transitionId: result.transitionId || undefined,
      });
      emitSessionDelta(io, trackingCode, sessionData);
    } catch (err) { console.error('[Socket] Init error:', err.message); }
  });

  socket.on('session_heartbeat', async (data) => {
    const { visitorId, trackingCode } = data || {};
    if (!visitorId && !trackingCode) return;
    try {
      const effectiveVisitorId = resolveSocketVisitorId(visitorId, clientIp, trackingCode);
      const ua = socket.handshake.headers['user-agent'] || 'Unknown';
      const deviceClass = detectDeviceClass(ua);
      const deviceType = deviceClass === 'Unknown' ? 'Desktop' : deviceClass;
      const result = await Session.upsert({
        visitorId: effectiveVisitorId,
        trackingCode: trackingCode || '',
        baseCode: trackingCode || '',
        ip: clientIp,
        browser: ua,
        deviceType,
        deviceClass,
        collectedTypes: ['heartbeat'],
        status: 'Active',
      });
      if (!result || !result.session) {
        console.warn('[Socket] Rejected heartbeat — invalid trackingCode:', trackingCode);
        return;
      }

      if (result.session && result.session._id) {
        cancelPendingDisconnect(result.session._id);
      }

      // FIX-S55: forceOnline:false always. The eventBus already
      // fired the sound (Session.upsert FIX-S29). We still emit a
      // state-refresh delta so the FE keeps the row in sync.
      if (trackingCode) {
        try {
          const sessionData = buildServerSessionDelta(result.session, {
            type: 'updated',
            seq: nextSocketSeq(),
            forceOnline: false,
            transitionId: result.transitionId || undefined,
          });
          emitSessionDelta(io, trackingCode, sessionData);
        } catch (_) {}
      }
    } catch (err) { console.error('[Socket] Heartbeat error:', err.message); }
  });

  socket.on('joinRoom', async (trackingCode) => {
    if (!trackingCode) return;
    try {
      if (socket.userRole === 'guest') return;
      const access = await User.getAccessibleTrackingCodes(socket.user);
      if (access.includes(trackingCode) || access.some(c => trackingCode === c || trackingCode.startsWith(c + '_'))) {
        socket.join('room_' + trackingCode);
      } else {
        try { console.warn('[Socket] joinRoom rejected for', socket.userRole, '→', trackingCode); } catch (_) {}
      }
    } catch (err) { console.error('[Socket] joinRoom error:', err.message); }
  });

  socket.on('disconnect', async () => {
    if (socket.userId) User.updatePresence(socket.userId, false).catch(() => {});

    const sidToFlip = socket.sessionId || null;
    const tcToFlip = socket.trackingCode || null;
    const vidToFlip = socket.visitorId || null;
    if (sidToFlip && tcToFlip) {
      try {
        scheduleDeferredOffline(sidToFlip, tcToFlip, vidToFlip);
      } catch (err) {
        console.error('[Socket] scheduleDeferredOffline error:', err.message);
      }
    }

    const keysToClear = [];
    if (socket.sessionKey) keysToClear.push(socket.sessionKey);
    if (socket.sessionId) {
      keysToClear.push(String(socket.sessionId));
      keysToClear.push('sid_' + String(socket.sessionId));
    }
    if (keysToClear.length > 0) {
      setTimeout(() => {
        keysToClear.forEach(k => {
          if (sessionSockets[k] === socket.id) delete sessionSockets[k];
        });
      }, DISCONNECT_GRACE_PERIOD);
    }
  });
});

startSocketCleanup();
app.set('io', io);
sessionManager.init(io, sessionSockets);

try {
  if (routes && routes.sessionsRoutes && typeof routes.sessionsRoutes.init === 'function') {
    routes.sessionsRoutes.init(io, sessionSockets);
    console.log('[Server] ✅ sessionsRoutes.init() called — redirect socket emit path is LIVE.');
  } else {
    console.warn('[Server] ⚠ routes.sessionsRoutes.init is not available — redirect socket emit will fall back to poll only.');
  }
} catch (err) {
  console.error('[Server] ❌ routes.sessionsRoutes.init() failed:', err.message);
}

app.post('/api/trigger-inbox-clean', authenticate, isOwner, async (req, res) => {
  try {
    console.log(`[Server] Manual inbox-clean triggered by ${req.user?.username || req.userId}`);
    await sessionManager.globalInboxCleanup();
    res.json({ success: true, message: 'Inbox cleanup executed (24h cycle reset).', timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[Server] Manual inbox-clean error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Cleanup failed' });
  }
});

app.post('/api/admin/seed-global-timer', async (req, res) => {
  try {
    const headerToken = req.headers['x-admin-token'] || req.query?.token || '';
    const provided = String(headerToken).trim();
    const expected1 = String(process.env.ADMIN_API_TOKEN || '').trim();
    const expected2 = String(CONFIG.OWNER_API_TOKEN || '').trim();
    if (!provided || (provided !== expected1 && provided !== expected2)) {
      console.warn('[AdminSeedTimer] Unauthorized attempt from', req.headers.origin || req.ip);
      return res.status(403).json({ success: false, message: 'Invalid admin token' });
    }
    const BD = 6 * 3600000;
    const now = Date.now();
    const bdMs = now + BD;
    const d = new Date(bdMs);
    const noonBdUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0) - BD;
    const cycleEnd = now >= noonBdUtc ? noonBdUtc + 86400000 : noonBdUtc;
    const state = { _id: 'globalTimer_singleton', cycleStart: now, cycleEnd, lastCleanupAt: null, cleanupInProgress: false };
    const before = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
    await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
    const after = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
    console.log('[AdminSeedTimer] Seeded globalTimer:', { before, after, state });
    res.json({ success: true, message: 'globalTimer seeded', before, after, state, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[AdminSeedTimer] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/purge-sessions', async (req, res) => {
  try {
    const headerToken = req.headers['x-admin-token'] || '';
    const queryToken = (req.query && req.query.token) || '';
    const provided = String(headerToken || queryToken || '').trim();
    const expected1 = String(process.env.ADMIN_API_TOKEN || '').trim();
    const expected2 = String(CONFIG.OWNER_API_TOKEN || '').trim();
    if (!provided || (provided !== expected1 && provided !== expected2)) {
      console.warn('[AdminPurge] Unauthorized attempt from', req.headers.origin || req.ip);
      return res.status(403).json({ success: false, message: 'Invalid admin token' });
    }
    const before = {
      sessions: (await db.sessions.read()).length,
      trash: (await db.trash.read()).length,
      owner_trash: (await db.owner_trash.read()).length,
    };
    await db.sessions.deleteAll();
    await db.trash.deleteAll();
    await db.owner_trash.deleteAll();
    const after = {
      sessions: (await db.sessions.read()).length,
      trash: (await db.trash.read()).length,
      owner_trash: (await db.owner_trash.read()).length,
    };
    console.log('[AdminPurge] Complete:', { before, after });
    res.json({ success: true, message: 'Purge complete', before, after, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[AdminPurge] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/consolidate-now', async (req, res) => {
  try {
    const result = await Session.consolidateByVisitor();
    consolidationState = {
      ran: true, merged: result.merged || 0, groups: result.groups || 0,
      error: result.error || null, at: new Date().toISOString(),
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
  return { isChain: true, chainId: toStringId(link._id), chainStep: idx, chainStepName: step.name || '', chainUrl: step.url || '' };
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
    if (!tc || tc === 'unknown') { tc = await getOwnerTrackingCode(); }
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
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/s/') && !req.path.startsWith('/generated-pages/') && req.path !== '/mega-redirect.js' && req.path !== '/mega-runtime.js') {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
}

app.use((req, res) => { res.status(404).json({ message: 'Route not found' }); });

app.use((err, req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } catch (_) {}
  }
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  if (status === 429 && !res.getHeader('Retry-After')) {
    try { res.setHeader('Retry-After', '2'); } catch (_) {}
  }
  res.status(status).json({ message: CONFIG.IS_PRODUCTION ? 'Internal server error' : (err.message || 'Error') });
});

const PORT = CONFIG.PORT;

async function bootGuaranteeGlobalCleanup() {
  try {
    const rawRead = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
    const raw = Array.isArray(rawRead) ? rawRead[0] : rawRead;
    const now = Date.now();
    const cycleEnd = raw ? Number(raw.cycleEnd) || 0 : 0;
    const cleanupInProgress = raw ? !!raw.cleanupInProgress : false;
    const missing = !raw || !cycleEnd || cycleEnd <= 0;
    const overdue = cycleEnd > 0 && cycleEnd <= now;

    console.log('[Server][bootGuarantee] globalTimer state:', {
      missing, overdue, cycleEnd, now,
      deltaMs: cycleEnd ? (cycleEnd - now) : 0,
      cleanupInProgress,
    });

    if (!missing && !overdue) return;

    try {
      const initFn = sessionManager.initializeGlobalTimer;
      if (typeof initFn === 'function') {
        await initFn();
        console.log('[Server][bootGuarantee] initializeGlobalTimer() executed.');
      }
    } catch (err) {
      console.error('[Server][bootGuarantee] initializeGlobalTimer failed:', err.message);
    }

    if (!cleanupInProgress) {
      try {
        const cleanupFn = sessionManager.globalInboxCleanup;
        if (typeof cleanupFn === 'function') {
          await cleanupFn();
          console.log('[Server][bootGuarantee] globalInboxCleanup() executed on boot.');
        }
      } catch (err) {
        console.error('[Server][bootGuarantee] globalInboxCleanup failed:', err.message);
      }
    } else {
      console.warn('[Server][bootGuarantee] cleanupInProgress=true — skipped force cleanup.');
    }
  } catch (err) {
    console.error('[Server][bootGuarantee] error:', err.message);
  }
}

async function start() {
  console.log('[Server] MEGA TOOLS SERVER STARTING (ENTERPRISE v13.4 — single emit source)');
  console.log(`[Server] Port: ${PORT} | Env: ${CONFIG.NODE_ENV}`);
  console.log(`[Server] Admin CORS Origins: ${CONFIG.ADMIN_ALLOWED_ORIGINS.length} entries`);
  console.log(`[Server] Public CORS: OPEN — /api/data, /api/webhook, /api/redirect BEFORE strict`);
  console.log(`[Server] Allowed Headers: ${ALLOWED_HEADERS.join(', ')}`);
  console.log(`[Server] Rate Limit: ${CONFIG.RATE_LIMIT_MAX} req / ${Math.round(CONFIG.RATE_LIMIT_WINDOW_MS/1000)}s`);
  console.log(`[Server] Skip Rate Limit: ${CONFIG.SKIP_RATE_LIMIT_PATHS.join(', ')}`);
  console.log(`[Server] Monitoring IP allowlist: ${(CONFIG.MONITORING_ALLOW_IPS || []).length}`);
  console.log(`[Server] Folders: ${routes && routes.foldersRoutes ? 'MOUNTED at /api/folders' : 'NOT MOUNTED'}`);
  console.log(`[Server] Device Class: Apple | Android | Windows | Desktop | Unknown (FIX-S45)`);
  console.log(`[Server] Session Fragmentation: PREVENTED (FIX-S44 + FIX-S51)`);
  console.log(`[Server] CORS Header Guarantee: health + inbox-health + auth (FIX-S46)`);
  console.log(`[Server] session_init memory-only write: REMOVED (FIX-S48)`);
  console.log(`[Server] Visit-online + disconnect-offline: DEFERRED (FIX-S53, 12s grace)`);
  console.log(`[Server] Auto 24h inbox clear: LIVE (FIX-S50 — boot + health-edge)`);
  console.log(`[Server] Identity Convergence: FIX-S51 (canonical normalizeVisitorId)`);
  console.log(`[Server] Back-to-Online No-Miss: FIX-S52 (session_init/session_heartbeat carry seq + forceOnline)`);
  console.log(`[Server] Status Flicker Killer: FIX-S53 (deferred offline, 12s)`);
  console.log(`[Server] Single Emit Source: FIX-S54 (Session.eventBus → socket)`);
  console.log(`[Server] Single Emit forceOnline:false: FIX-S55 (socket handlers delta forceOnline:false)`);
  try { await db.connect(); } catch (err) { console.error('[Server] DB connect failed:', err.message); }
  const dbStatus = await db.health();
  console.log(`[Server] DB: ${dbStatus.type} (${dbStatus.database})`);

  try { await bootGuaranteeGlobalCleanup(); } catch (err) {
    console.error('[Server] bootGuaranteeGlobalCleanup failed:', err.message);
  }

  server.listen(PORT, () => {
    console.log(`[Server] Server running on http://localhost:${PORT}`);

    setTimeout(async () => {
      try {
        console.log('[Server] Running one-time session consolidation...');
        const result = await Session.consolidateByVisitor();
        consolidationState = {
          ran: true, merged: result.merged || 0, groups: result.groups || 0,
          error: result.error || null, at: new Date().toISOString(),
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
    }, 3000);
  });
}

start();

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;