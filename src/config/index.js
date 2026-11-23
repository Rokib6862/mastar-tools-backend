// ============================================================
// MEGA TOOLS — CENTRAL CONFIGURATION (v7.8 — 2-MIN SESSION TIMEOUT SYNC)
// ============================================================
// FIX-CFG1 (v7.1 — TIMER FILE NAME): retained
// FIX-CFG2 (v7.2 — VERCEL DOMAINS): retained
// FIX-CFG3 (v7.3 — RENDER FREE TIER SAFETY): retained
// FIX-CFG4 (v7.4 — RATE LIMIT STORM FIX): retained
//
// FIX-CFG5 (v7.5 — MONITORING ENDPOINT PROTECTION):
//   UptimeRobot hit /api/health every 5 minutes and still received
//   HTTP 429 (see incident 2026-11-09 20:30:39 → 20:40:51).
//   Root cause: the health route was registered AFTER the global
//   rate limiter, so the limiter's per-IP counter (backed by the
//   client IP — proxy or not) kept growing and eventually blocked
//   monitoring probes. The skip-list alone was not enough because
//   express-rate-limit requires the skip() to run BEFORE any other
//   counters and the route must be reachable even when a limiter
//   has tripped.
//   Fixes:
//     * Expanded SKIP_RATE_LIMIT_PATHS to also cover monitoring
//       aliases (/health, /inbox-health, /ping, /ready, /status).
//     * Added SKIP_RATE_LIMIT_EXACT (Set) for fast, O(1) lookup.
//     * Added MONITORING_ALLOW_IPS (empty by default) so a specific
//       IP allowlist can bypass rate limiting entirely if needed.
//
// FIX-CFG6 (v7.5 — CORS WILDCARD FOR VERCEL + RENDER):
//   Added `*.vercel.app` and `*.onrender.com` wildcard patterns so
//   every preview / staging deployment on those platforms works
//   without code changes. Explicit entries for grow-links.vercel.app
//   and mega-tools.online are retained.
//
// FIX-CFG7 (v7.5 — SESSION TIMEOUT EXPLICIT):
//   SESSION_TIMEOUT_MS is documented as the maximum time a
//   visitor's Live Inbox session stays marked "Online" without a
//   heartbeat. Default was 5 minutes in v7.5; see FIX-CFG8 (v7.6)
//   for the 1-minute value; see FIX-CFG10 (v7.8) for 2-minute.
//
// FIX-CFG8 (v7.6 — 1-MIN SESSION TIMEOUT): RETAINED AS COMMENT.
//   SESSION_TIMEOUT_MS default was changed 5 * 60 * 1000 (300000)
//   → 60 * 1000 (60000). Superseded by FIX-CFG10 (v7.8).
//
// FIX-CFG9 (v7.7 — REFERRAL DOMAIN FALLBACK):
//   Referral / public links were being emitted as
//   https://mega-tools.online because resolveClientUrl() fell
//   back to that legacy domain whenever CLIENT_URL was missing
//   (Render Dashboard env was empty or pointed to localhost).
//   Production frontend is now deployed on Vercel at
//   https://grow-links.vercel.app — the fallback has been
//   switched to that domain.
//   Override order is UNCHANGED (CLIENT_URL → FRONTEND_URL →
//   fallback). Any deployment that pins CLIENT_URL via env keeps
//   working with that value; only the missing-env fallback has
//   changed.
//   If a custom domain is reintroduced later, set CLIENT_URL in
//   the Render Dashboard — no code change will be required.
//
// FIX-CFG10 (v7.8 — 2-MIN SESSION TIMEOUT SYNC):
//   User requirement: an online-but-empty visitor must be flipped
//   to Offline after 2 minutes of inactivity (not 1, not 3).
//   Backend sessionManager.js ACTIVITY_TIMEOUT_MS was changed
//   180000 → 120000 (FIX-SM32). To keep every consumer aligned
//   (statusMonitor, /api/sessions/online count, /sessions/timer),
//   SESSION_TIMEOUT_MS is now 120000 (2 min) and AWAY_THRESHOLD_MS
//   is bumped 30000 → 120000 to match.
//   Changes in this file (FIX-CFG10):
//     • SESSION_TIMEOUT_MS: 60000 → 120000 (2 min).
//     • AWAY_THRESHOLD_MS: 30000 → 120000 (aligned with activity gap).
//     • No change to INBOX_GLOBAL_CYCLE_MS (24h noon), MIN_SESSION_AGE_MS
//       (24h), OFFLINE_GRACE_MS (24h in Session.upsert), or any CORS /
//       rate-limit / upload / pagination constant.
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

// ---- HELPERS ----
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function parseOrigins(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function resolveClientUrl() {
  if (process.env.CLIENT_URL) return process.env.CLIENT_URL.replace(/\/$/, '');
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, '');
  // FIX-CFG9 (v7.7): production fallback → Vercel frontend
  return IS_PRODUCTION ? 'https://grow-links.vercel.app' : 'http://localhost:5173';
}

// ---- ADMIN CORS ORIGINS (strict whitelist — admin/auth only) ----
const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:3000',
];

// FIX-CFG6: wildcard patterns are matched by server.js isOriginAllowed()
const PRODUCTION_ADMIN_ORIGINS = [
  'https://mega-tools.online',
  'https://www.mega-tools.online',
  'https://megatools.site',
  'https://www.megatools.site',
  'https://grow-links.vercel.app',
  'https://megatools-frontend.vercel.app',
  'https://mastar-tools-backend.onrender.com',
  // FIX-CFG6: allow any Vercel preview deployment
  '*.vercel.app',
  // FIX-CFG6: allow any Render deployment domain
  '*.onrender.com',
];

const ENV_ADMIN_ORIGINS = [
  ...parseOrigins(process.env.ALLOWED_ORIGINS),
  ...parseOrigins(process.env.CLIENT_URL),
  ...parseOrigins(process.env.FRONTEND_URL),
];

const ADMIN_ALLOWED_ORIGINS = Array.from(new Set([
  ...LOCAL_ORIGINS,
  ...(IS_PRODUCTION ? PRODUCTION_ADMIN_ORIGINS : []),
  ...ENV_ADMIN_ORIGINS,
])).filter(Boolean);

// ---- DATABASE ----
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const MONGODB_DB = (process.env.MONGODB_DB || 'megamastartools').trim();
const DB_MODE = MONGODB_URI ? 'mongodb' : 'json';

// FIX-CFG5: monitoring endpoint protection
// These paths must be reachable even if a rate limiter has tripped.
const SKIP_RATE_LIMIT_PATHS = [
  '/api/health',
  '/api/inbox-health',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/sessions/timer',
  // FIX-CFG5: monitoring aliases
  '/health',
  '/ping',
  '/ready',
  '/status',
  '/api/ping',
  '/api/ready',
  '/api/status',
];

// FIX-CFG5: O(1) lookup set for server.js shouldSkipRateLimit()
const SKIP_RATE_LIMIT_EXACT = new Set(SKIP_RATE_LIMIT_PATHS);

// FIX-CFG5: IP allowlist (comma-separated in env). Empty = none.
const MONITORING_ALLOW_IPS = parseOrigins(process.env.MONITORING_ALLOW_IPS);

// ---- BUILD CONFIG ----
const CONFIG = {
  // ---- SERVER ----
  PORT: parseInt(process.env.PORT) || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CLIENT_URL: resolveClientUrl(),
  IS_PRODUCTION,

  // ---- DATABASE ----
  MONGODB_URI,
  MONGODB_DB,
  DB_MODE,

  // ---- SECURITY ----
  JWT_SECRET: process.env.JWT_SECRET || 'mega_tools_local_dev_secret',
  JWT_EXPIRY: '30d',
  BCRYPT_SALT_ROUNDS: parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12,
  WEBHOOK_SECRET_KEY: process.env.WEBHOOK_SECRET_KEY || 'mega_webhook_local_dev',
  OWNER_API_TOKEN: process.env.OWNER_API_TOKEN || 'mega_owner_local_dev',

  // ---- SESSION TIMINGS ----
  // FIX-CFG10 (v7.8): maximum time a visitor's Live Inbox session
  // stays "Online" without a heartbeat — 2 minutes.
  // Aligned with sessionManager.js ACTIVITY_TIMEOUT_MS = 120000
  // (FIX-SM32). Do not lower this without also lowering the
  // backend monitor's threshold — they must stay in sync.
  SESSION_TIMEOUT_MS: parseInt(process.env.SESSION_TIMEOUT_MS) || 120000,
  HEARTBEAT_INTERVAL_MS: parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 5000,
  // FIX-CFG10: away-threshold aligned to 2 min to match activity gap.
  AWAY_THRESHOLD_MS: parseInt(process.env.AWAY_THRESHOLD_MS) || 120000,

  // ---- GLOBAL INBOX 24-HOUR LIFECYCLE ----
  INBOX_GLOBAL_CYCLE_MS: 24 * 60 * 60 * 1000,
  INBOX_GLOBAL_TIMER_FILE: 'globalTimer',

  // ---- LOGIN SECURITY ----
  LOGIN_ATTEMPTS_MAX: parseInt(process.env.LOGIN_ATTEMPTS_MAX) || 5,
  LOGIN_ATTEMPTS_WINDOW_MS: parseInt(process.env.LOGIN_ATTEMPTS_WINDOW_MS) || 900000,

  // ---- RATE LIMITING ----
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 3000,
  AUTH_RATE_LIMIT_MAX: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 600,
  SESSION_RATE_LIMIT_MAX: parseInt(process.env.SESSION_RATE_LIMIT_MAX) || 1800,
  DATA_RATE_LIMIT_MAX: parseInt(process.env.DATA_RATE_LIMIT_MAX) || 1200,
  UPLOAD_RATE_LIMIT_MAX: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX) || 60,
  WEBHOOK_RATE_LIMIT_MAX: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX) || 200,
  // FIX-CFG5: paths that MUST bypass every limiter
  SKIP_RATE_LIMIT_PATHS,
  SKIP_RATE_LIMIT_EXACT,
  // FIX-CFG5: IP allowlist for monitoring probes
  MONITORING_ALLOW_IPS,

  // ---- UPLOAD LIMITS ----
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE) || 10485760,
  MAX_IMAGE_SIZE: parseInt(process.env.MAX_IMAGE_SIZE) || 5242880,
  ALLOWED_IMAGE_TYPES: (process.env.ALLOWED_IMAGE_TYPES || 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml').split(','),

  // ---- CORS ----
  ADMIN_ALLOWED_ORIGINS,

  // ---- PUBLIC CORS ----
  PUBLIC_CORS_OPEN: true,

  // ---- PAGINATION ----
  SESSIONS_PER_PAGE: 20,
  USERS_PER_PAGE: 50,
  LINKS_PER_PAGE: 50,
  MESSAGES_PER_PAGE: 50,
  EXPORT_MAX_ROWS: 10000,

  // ---- CACHE ----
  CACHE_TTL: 300000,

  // ---- FEATURES ----
  CHAIN_VISITOR_MAP_MAX: 1000,
  SESSION_IDS_MAX: 30,
  MAX_REDIRECTS_PER_SESSION: 50,
  REDIRECT_DELAY: 1500,
};

CONFIG.IS_PRODUCTION = CONFIG.NODE_ENV === 'production';

console.log('[Config] ✅ Configuration loaded (v7.8)');
console.log(`   📡 PORT: ${CONFIG.PORT}`);
console.log(`   🌍 NODE_ENV: ${CONFIG.NODE_ENV}`);
console.log(`   💾 DB Mode: ${CONFIG.DB_MODE}${CONFIG.DB_MODE === 'mongodb' ? ' (' + CONFIG.MONGODB_DB + ')' : ''}`);
console.log(`   🌐 CLIENT_URL: ${CONFIG.CLIENT_URL}`);
console.log(`   🔄 Global Inbox: 24-Hour Lifecycle (Noon-Aligned BD)`);
console.log(`   🔒 Admin CORS Origins (${CONFIG.ADMIN_ALLOWED_ORIGINS.length}): ${CONFIG.ADMIN_ALLOWED_ORIGINS.slice(0, 5).join(', ')}${CONFIG.ADMIN_ALLOWED_ORIGINS.length > 5 ? '...' : ''}`);
console.log(`   🌍 Public CORS: OPEN (any origin) for /api/data/* + /api/webhook/*`);
console.log(`   ⚡ Rate Limit: ${CONFIG.RATE_LIMIT_MAX} req / ${Math.round(CONFIG.RATE_LIMIT_WINDOW_MS/1000)} sec`);
console.log(`   ⚡ Tiered: auth=${CONFIG.AUTH_RATE_LIMIT_MAX} | sessions=${CONFIG.SESSION_RATE_LIMIT_MAX} | data=${CONFIG.DATA_RATE_LIMIT_MAX}`);
console.log(`   🛡️  Skip Rate Limit: ${CONFIG.SKIP_RATE_LIMIT_PATHS.length} path(s)`);
console.log(`   🛡️  Monitoring IPs allowlisted: ${CONFIG.MONITORING_ALLOW_IPS.length}`);
console.log(`   ⏱️  Session Timeout: ${Math.round(CONFIG.SESSION_TIMEOUT_MS/60000)} min`);

module.exports = CONFIG;