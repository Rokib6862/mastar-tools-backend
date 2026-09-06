// ============================================================
// MEGA TOOLS — CENTRAL CONFIGURATION (v7.0 PERFECT PRESENCE)
// v7.0: 10s detection window + anti-flicker grace period
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const CONFIG = {
  PORT: parseInt(process.env.PORT) || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
  IS_PRODUCTION,

  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRY: '30d',
  BCRYPT_SALT_ROUNDS: parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12,
  WEBHOOK_SECRET_KEY: process.env.WEBHOOK_SECRET_KEY,
  OWNER_API_TOKEN: process.env.OWNER_API_TOKEN,

  // ============================================================
  // PRESENCE TIMING (v7.0 — PERFECT ONLINE/OFFLINE)
  // ============================================================
  // Heartbeat: প্রতি ৩ সেকেন্ডে visitor থেকে signal আসবে
  // Detection Window: ১০ সেকেন্ড timeout → Offline confirm
  // Monitor: প্রতি ২ সেকেন্ডে server check করবে
  // Grace Period: ৬ সেকেন্ড (2 missed heartbeats) → transition শুরু
  // ============================================================

  SESSION_TIMEOUT_MS: parseInt(process.env.SESSION_TIMEOUT_MS) || 180000,
  HEARTBEAT_INTERVAL_MS: parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 3000,
  AWAY_THRESHOLD_MS: parseInt(process.env.AWAY_THRESHOLD_MS) || 10000,

  STATUS_DETECTION_WINDOW_MS: parseInt(process.env.STATUS_DETECTION_WINDOW_MS) || 10000,
  STATUS_MONITOR_INTERVAL_MS: parseInt(process.env.STATUS_MONITOR_INTERVAL_MS) || 2000,

  // v7.0: Grace period — heartbeat miss হওয়ার পর কতক্ষণ Online দেখাবে
  GRACE_PERIOD_MS: parseInt(process.env.GRACE_PERIOD_MS) || 6000,

  // v7.0: Anti-flicker — status change broadcast minimum gap
  STATUS_BROADCAST_MIN_GAP_MS: parseInt(process.env.STATUS_BROADCAST_MIN_GAP_MS) || 8000,

  MAX_SESSION_DURATION_MS: parseInt(process.env.MAX_SESSION_DURATION_MS) || 300000,

  // ✅ v6.6: INBOX_GLOBAL_CYCLE_MS — 24 hours (from env or default)
  INBOX_GLOBAL_CYCLE_MS: parseInt(process.env.INBOX_CLEAN_INTERVAL_MS) || (24 * 60 * 60 * 1000),
  INBOX_GLOBAL_TIMER_FILE: 'globalTimer.json',

  LOGIN_ATTEMPTS_MAX: parseInt(process.env.LOGIN_ATTEMPTS_MAX) || 5,
  LOGIN_ATTEMPTS_WINDOW_MS: parseInt(process.env.LOGIN_ATTEMPTS_WINDOW_MS) || 900000,

  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 500,
  UPLOAD_RATE_LIMIT_MAX: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX) || 20,
  WEBHOOK_RATE_LIMIT_MAX: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX) || 100,

  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE) || 10485760,
  MAX_IMAGE_SIZE: parseInt(process.env.MAX_IMAGE_SIZE) || 5242880,
  ALLOWED_IMAGE_TYPES: (process.env.ALLOWED_IMAGE_TYPES || 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml').split(','),

  IMAGEKIT_PUBLIC_KEY: process.env.IMAGEKIT_PUBLIC_KEY || '',
  IMAGEKIT_PRIVATE_KEY: process.env.IMAGEKIT_PRIVATE_KEY || '',
  IMAGEKIT_URL_ENDPOINT: process.env.IMAGEKIT_URL_ENDPOINT || '',

  ALLOWED_ORIGINS: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5000',
    'http://localhost:3000',
  ],

  // ✅ v6.6: SESSIONS_PER_PAGE properly defined
  SESSIONS_PER_PAGE: 20,
  USERS_PER_PAGE: 50,
  LINKS_PER_PAGE: 50,
  MESSAGES_PER_PAGE: 50,
  EXPORT_MAX_ROWS: 10000,

  CACHE_TTL: 300000,

  CHAIN_VISITOR_MAP_MAX: 1000,
  SESSION_IDS_MAX: 30,
  MAX_REDIRECTS_PER_SESSION: 50,
  REDIRECT_DELAY: 1500,
};

CONFIG.IS_PRODUCTION = CONFIG.NODE_ENV === 'production';

console.log('[Config] ✅ Configuration loaded');
console.log(`   📡 PORT: ${CONFIG.PORT}`);
console.log(`   🌍 NODE_ENV: ${CONFIG.NODE_ENV}`);
console.log(`   💾 Database: JSON File (local)`);
console.log(`   🔄 Global Inbox: ${CONFIG.INBOX_GLOBAL_CYCLE_MS / (60 * 60 * 1000)}-Hour Lifecycle`);
console.log(`   ⚡ Heartbeat: ${CONFIG.HEARTBEAT_INTERVAL_MS}ms (3s)`);
console.log(`   🎯 Detection Window: ${CONFIG.STATUS_DETECTION_WINDOW_MS}ms (10s)`);
console.log(`   🔄 Monitor: ${CONFIG.STATUS_MONITOR_INTERVAL_MS}ms (2s)`);
console.log(`   🛡️ Grace Period: ${CONFIG.GRACE_PERIOD_MS}ms (6s)`);
console.log(`   📡 Broadcast Min Gap: ${CONFIG.STATUS_BROADCAST_MIN_GAP_MS}ms (8s)`);
console.log(`   ⏱️ Max Session Duration: ${CONFIG.MAX_SESSION_DURATION_MS}ms (5min)`);
console.log(`   📄 Sessions Per Page: ${CONFIG.SESSIONS_PER_PAGE}`);
console.log(`   🖼️ ImageKit: ${CONFIG.IMAGEKIT_PUBLIC_KEY ? 'Configured' : 'Not Configured'}`);

module.exports = CONFIG;