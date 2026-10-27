// ============================================================
// MEGA TOOLS — CENTRAL CONFIGURATION (v7.0)
// ARCHITECTURE: Split CORS
//   - ADMIN_ALLOWED_ORIGINS: strict whitelist (admin/auth endpoints)
//   - PUBLIC tracking endpoints: open CORS (any origin)
//   - Unlimited external visitor pages (Netlify, Vercel, custom, etc.)
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
  return IS_PRODUCTION ? 'https://mega-tools.online' : 'http://localhost:5173';
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

const PRODUCTION_ADMIN_ORIGINS = [
  // Primary admin app
  'https://mega-tools.online',
  'https://www.mega-tools.online',
  'https://megatools.site',
  'https://www.megatools.site',
  // Backend
  'https://mastar-tools-backend.onrender.com',
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
  SESSION_TIMEOUT_MS: parseInt(process.env.SESSION_TIMEOUT_MS) || 180000,
  HEARTBEAT_INTERVAL_MS: parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 5000,
  AWAY_THRESHOLD_MS: parseInt(process.env.AWAY_THRESHOLD_MS) || 30000,

  // ---- GLOBAL INBOX 24-HOUR LIFECYCLE ----
  INBOX_GLOBAL_CYCLE_MS: 24 * 60 * 60 * 1000,
  INBOX_GLOBAL_TIMER_FILE: 'globalTimer.json',

  // ---- LOGIN SECURITY ----
  LOGIN_ATTEMPTS_MAX: parseInt(process.env.LOGIN_ATTEMPTS_MAX) || 5,
  LOGIN_ATTEMPTS_WINDOW_MS: parseInt(process.env.LOGIN_ATTEMPTS_WINDOW_MS) || 900000,

  // ---- RATE LIMITING ----
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 500,
  UPLOAD_RATE_LIMIT_MAX: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX) || 20,
  WEBHOOK_RATE_LIMIT_MAX: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX) || 100,

  // ---- UPLOAD LIMITS ----
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE) || 10485760,
  MAX_IMAGE_SIZE: parseInt(process.env.MAX_IMAGE_SIZE) || 5242880,
  ALLOWED_IMAGE_TYPES: (process.env.ALLOWED_IMAGE_TYPES || 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml').split(','),

  // ---- CORS ----
  ADMIN_ALLOWED_ORIGINS,

  // ---- PUBLIC CORS ----
  // Public tracking endpoints (/api/data/* + /api/webhook/*) accept ANY origin
  // This enables unlimited external visitor pages on any domain
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

console.log('[Config] ✅ Configuration loaded');
console.log(`   📡 PORT: ${CONFIG.PORT}`);
console.log(`   🌍 NODE_ENV: ${CONFIG.NODE_ENV}`);
console.log(`   💾 DB Mode: ${CONFIG.DB_MODE}${CONFIG.DB_MODE === 'mongodb' ? ' (' + CONFIG.MONGODB_DB + ')' : ''}`);
console.log(`   🌐 CLIENT_URL: ${CONFIG.CLIENT_URL}`);
console.log(`   🔄 Global Inbox: 24-Hour Lifecycle`);
console.log(`   🔒 Admin CORS Origins (${CONFIG.ADMIN_ALLOWED_ORIGINS.length}): ${CONFIG.ADMIN_ALLOWED_ORIGINS.slice(0, 5).join(', ')}${CONFIG.ADMIN_ALLOWED_ORIGINS.length > 5 ? '...' : ''}`);
console.log(`   🌍 Public CORS: OPEN (any origin) for /api/data/* + /api/webhook/*`);

module.exports = CONFIG;