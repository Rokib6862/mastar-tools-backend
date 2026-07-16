// ============================================================
// MEGA TOOLS — CENTRAL CONFIGURATION
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const CONFIG = {
  // ---- SERVER ----
  PORT: parseInt(process.env.PORT) || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
  IS_PRODUCTION: process.env.NODE_ENV === 'production',

  // ---- DATABASE ----
  MONGODB_URI: process.env.MONGODB_URI || '',
  MONGODB_DB: process.env.MONGODB_DB || 'megamastartools',
  DB_CONNECT_TIMEOUT: 5000,
  DB_SERVER_SELECTION_TIMEOUT: 5000,
  DB_MAX_RETRIES: 3,
  DB_RETRY_DELAY: 1000,

  // ---- SECURITY ----
  JWT_SECRET: process.env.JWT_SECRET || 'default_dev_secret_change_in_production',
  JWT_EXPIRY: '7d',
  JWT_TRIAL_EXPIRY: '1h',
  BCRYPT_SALT_ROUNDS: parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12,
  WEBHOOK_SECRET_KEY: process.env.WEBHOOK_SECRET_KEY || 'default_webhook_dev',
  ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN || 'default_admin_dev',

  // ---- EMAIL (Brevo) ----
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',
  BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL || 'noreply@megatools.site',
  BREVO_SENDER_NAME: process.env.BREVO_SENDER_NAME || 'Mega Tools Support',

  // ---- IMAGE UPLOAD (Hybrid - imgbb + FreeImage) ----
  IMGBB_API_KEY_1: process.env.IMGBB_API_KEY_1 || '',
  IMGBB_API_KEY_2: process.env.IMGBB_API_KEY_2 || '',
  FREEIMAGE_API_KEY: process.env.FREEIMAGE_API_KEY || '',
  IMGBB_API_KEY: process.env.IMGBB_API_KEY || process.env.IMGBB_API_KEY_1 || '',
  IMGBB_TIMEOUT: 60000,
  UPLOAD_MAX_RETRIES: 2,

  // ---- SESSION TIMINGS ----
  SESSION_TIMEOUT_MS: parseInt(process.env.SESSION_TIMEOUT_MS) || 600000,
  HEARTBEAT_INTERVAL_MS: parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 30000,
  AWAY_THRESHOLD_MS: parseInt(process.env.AWAY_THRESHOLD_MS) || 120000,
  INBOX_CLEAN_INTERVAL_MS: parseInt(process.env.INBOX_CLEAN_INTERVAL_MS) || 86400000,
  TRIAL_DURATION_MS: parseInt(process.env.TRIAL_DURATION_MS) || 3600000,

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
  ALLOWED_ORIGINS: [
    'https://mega-tools.online',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5000','http://localhost:3000',
  ],

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

// ---- COMPUTED ----
CONFIG.IS_PRODUCTION = CONFIG.NODE_ENV === 'production';

// ---- VALIDATION ----
if (CONFIG.IS_PRODUCTION) {
  const required = ['JWT_SECRET', 'BREVO_API_KEY', 'BREVO_SENDER_EMAIL'];
  const missing = required.filter(key => {
    return !CONFIG[key] || CONFIG[key].includes('default_') || CONFIG[key].includes('replace_');
  });
  if (missing.length > 0) {
    console.warn(`⚠️ WARNING: Missing required production config: ${missing.join(', ')}`);
  }
}

module.exports = CONFIG;