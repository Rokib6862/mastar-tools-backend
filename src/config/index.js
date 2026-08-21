// ============================================================
// MEGA TOOLS — CENTRAL CONFIGURATION (v3.0 Production Hardened)
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const CONFIG = {
  // ---- SERVER ----
  PORT: parseInt(process.env.PORT) || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',

  // ---- DATABASE ----
  MONGODB_URI: process.env.MONGODB_URI || '',
  MONGODB_DB: process.env.MONGODB_DB || 'megamastartools',
  DB_CONNECT_TIMEOUT: 5000,
  DB_SERVER_SELECTION_TIMEOUT: 5000,
  DB_MAX_RETRIES: 3,
  DB_RETRY_DELAY: 1000,

  // ---- SECURITY ----
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRY: '7d',
  BCRYPT_SALT_ROUNDS: parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12,
  WEBHOOK_SECRET_KEY: process.env.WEBHOOK_SECRET_KEY || '',
  ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN || '',

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

  // ---- GLOBAL 24-HOUR CYCLE ----
  CYCLE_DURATION_MS: parseInt(process.env.CYCLE_DURATION_MS) || 86400000,
  CYCLE_CHECK_INTERVAL_MS: parseInt(process.env.CYCLE_CHECK_INTERVAL_MS) || 10000,
  CYCLE_TIMER_UPDATE_INTERVAL_MS: parseInt(process.env.CYCLE_TIMER_UPDATE_INTERVAL_MS) || 60000,

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
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'https://mega-tools.online,http://localhost:5173,http://localhost:5174,http://localhost:5000,http://localhost:3000').split(',').map(o => o.trim()).filter(Boolean),

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

// ============================================================
// PRODUCTION VALIDATION — HARD FAIL (Server will NOT start)
// ============================================================

if (CONFIG.IS_PRODUCTION) {
  const errors = [];

  // ---- REQUIRED: Database ----
  if (!CONFIG.MONGODB_URI || CONFIG.MONGODB_URI.includes('your_') || CONFIG.MONGODB_URI.includes('REPLACE')) {
    errors.push('MONGODB_URI is required in production');
  }

  // ---- REQUIRED: Security ----
  if (!CONFIG.JWT_SECRET || CONFIG.JWT_SECRET.includes('default_') || CONFIG.JWT_SECRET.includes('your_') || CONFIG.JWT_SECRET.includes('REPLACE') || CONFIG.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters in production');
  }
  if (!CONFIG.WEBHOOK_SECRET_KEY || CONFIG.WEBHOOK_SECRET_KEY.includes('default_') || CONFIG.WEBHOOK_SECRET_KEY.includes('your_') || CONFIG.WEBHOOK_SECRET_KEY.includes('REPLACE')) {
    errors.push('WEBHOOK_SECRET_KEY must be set in production');
  }
  if (!CONFIG.ADMIN_API_TOKEN || CONFIG.ADMIN_API_TOKEN.includes('default_') || CONFIG.ADMIN_API_TOKEN.includes('your_') || CONFIG.ADMIN_API_TOKEN.includes('REPLACE')) {
    errors.push('ADMIN_API_TOKEN must be set in production');
  }

  // ---- REQUIRED: Email ----
  if (!CONFIG.BREVO_API_KEY || CONFIG.BREVO_API_KEY.includes('your_') || CONFIG.BREVO_API_KEY.includes('REPLACE')) {
    errors.push('BREVO_API_KEY is required in production');
  }

  // ---- REQUIRED: Image Upload (at least one service) ----
  const hasImgbb = CONFIG.IMGBB_API_KEY_1 || CONFIG.IMGBB_API_KEY_2 || CONFIG.IMGBB_API_KEY;
  const hasFreeImage = CONFIG.FREEIMAGE_API_KEY;
  if (!hasImgbb && !hasFreeImage) {
    errors.push('At least one image upload service (IMGBB_API_KEY or FREEIMAGE_API_KEY) is required in production');
  }

  // ---- HARD FAIL ----
  if (errors.length > 0) {
    console.error('========================================');
    console.error('❌ PRODUCTION CONFIGURATION ERROR:');
    errors.forEach(e => console.error(`   - ${e}`));
    console.error('========================================');
    console.error('Server will NOT start until all required environment variables are set.');
    console.error('Check your .env file and restart.');
    console.error('========================================');
    process.exit(1);
  }

  console.log('✅ Production configuration validated successfully.');
} else {
  // ---- DEVELOPMENT: Soft warnings only ----
  if (!CONFIG.JWT_SECRET) {
    console.warn('⚠️  DEV MODE: JWT_SECRET not set, using empty string. Set it in .env for security.');
  }
  if (!CONFIG.MONGODB_URI) {
    console.log('📂 DEV MODE: MONGODB_URI empty, using JSON file storage.');
  }
}

module.exports = CONFIG;