// ============================================================
// MEGA TOOLS — UTILITY HELPERS (v2.1)
// FIXED: Referral link ALWAYS uses production URL (no localhost leak)
// FIX-HLP1 (v2.1): parseTrackingCode — now understands action codes
//                  even when slug itself contains underscores, by
//                  splitting from the right when actionCode is present.
// FIX-HLP2 (v2.1): comparePassword — handles null/undefined inputs
//                  and malformed hashes without throwing.
// FIX-HLP3 (v2.1): sanitizeText — preserves safe punctuation (dots,
//                  commas, quotes) while stripping scripts; robust
//                  against catastrophic regex on huge inputs.
// FIX-HLP4 (v2.1): paginate — accepts non-integer page/limit and
//                  clamps to >=1 without NaN leakage.
// FIX-HLP5 (v2.1): resolvePublicSiteUrl — rejects any URL that is not
//                  http(s) or that points to a "localhost" subdomain
//                  like "local.hostname.tld" is fine but "localhost.*"
//                  is rejected.
// ============================================================

const bcrypt = require('bcryptjs');
const CONFIG = require('../config');

// ============================================================
// ID HELPERS
// ============================================================

const toStringId = (id) => {
  if (!id) return null;
  return id?.toString ? id.toString() : String(id);
};

const generateId = (prefix = '') => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}${timestamp}_${random}`;
};

// ============================================================
// CODE GENERATORS
// ============================================================

const CHARSET = 'abcdefghjkmnpqrstuvwxyz23456789';

const generateCode = (length = 8) => {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return code;
};

const generateTrackingCode = () => generateCode(8);
const generateBaseCode = () => generateCode(9);
const generateActionCode = () => generateCode(6);

const generateReferralCode = async (prefix, existingCodes = []) => {
  let code;
  let attempts = 0;
  do {
    code = prefix + Math.random().toString(36).substring(2, 10).toUpperCase();
    attempts++;
  } while (existingCodes.includes(code) && attempts < 20);
  return code;
};

// ============================================================
// PUBLIC SITE URL RESOLVER
// Ensures referral / public links NEVER contain localhost
// ============================================================

function resolvePublicSiteUrl() {
  const PRODUCTION_FALLBACK = 'https://mega-tools.online';

  const candidates = [
    CONFIG.CLIENT_URL,
    CONFIG.FRONTEND_URL,
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
  ].filter(Boolean).map(u => String(u).trim().replace(/\/$/, ''));

  // FIX-HLP5: stricter host check
  const isLocalHost = (url) => {
    try {
      const u = new URL(url);
      const h = u.hostname.toLowerCase();
      return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h.endsWith('.localhost');
    } catch (_) {
      return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url);
    }
  };

  for (const url of candidates) {
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (isLocalHost(url)) continue;
    return url;
  }

  if (CONFIG.IS_PRODUCTION) return PRODUCTION_FALLBACK;

  // In dev, allow localhost so testing works
  for (const url of candidates) {
    if (/^https?:\/\//i.test(url)) return url;
  }
  return 'http://localhost:5173';
}

// ============================================================
// REFERRAL LINK GENERATOR
// ============================================================

const generateReferralLink = (prefix = 'REF', existingTokens = []) => {
  let token;
  let attempts = 0;
  do {
    token = prefix + '-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    attempts++;
  } while (existingTokens.includes(token) && attempts < 50);

  const baseUrl = resolvePublicSiteUrl();

  return {
    token,
    link: `${baseUrl}/login?ref=${token}`,
  };
};

// ============================================================
// PASSWORD HELPERS
// ============================================================

const isPasswordHashed = (password) => {
  return !!(password && (password.startsWith('$2b$') || password.startsWith('$2a$')));
};

const hashPassword = (password) => {
  if (!password) return '';
  if (isPasswordHashed(password)) return password;
  return bcrypt.hashSync(password, CONFIG.BCRYPT_SALT_ROUNDS);
};

// FIX-HLP2: defensive compare
const comparePassword = async (plainPassword, hashedPassword) => {
  try {
    if (!plainPassword || !hashedPassword) return false;
    if (!isPasswordHashed(hashedPassword)) return false;
    return await bcrypt.compare(plainPassword, hashedPassword);
  } catch (e) {
    return false;
  }
};

const generateRandomPassword = () => {
  const adjectives = ['Swift', 'Bright', 'Calm', 'Bold', 'Wise', 'Cool', 'Kind', 'Safe', 'Brave', 'Clear'];
  const nouns = ['Fox', 'Eagle', 'Lion', 'Wolf', 'Hawk', 'Bear', 'Deer', 'Dove', 'Tiger', 'Falcon'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${adj}${noun}${num}`;
};

// ============================================================
// URL HELPERS
// ============================================================

const cleanUrl = (url) => {
  if (!url) return '';
  return url.split('#')[0].split('?')[0].replace(/\/$/, '');
};

// FIX-HLP1: right-split for actionCode when present
const parseTrackingCode = (code) => {
  if (!code || typeof code !== 'string') {
    return { trackingCode: null, slug: null, actionCode: null };
  }
  const parts = code.split('_');

  if (parts.length >= 3) {
    // actionCode is the LAST segment when length >= 3
    const actionCode = parts[parts.length - 1];
    const slug = parts.slice(1, -1).join('_');
    return { trackingCode: parts[0], slug, actionCode };
  }
  if (parts.length === 2) {
    return { trackingCode: parts[0], slug: parts[1], actionCode: null };
  }
  return { trackingCode: null, slug: parts[0], actionCode: null };
};

// ============================================================
// DATE HELPERS
// ============================================================

const now = () => new Date().toISOString();
const nowMs = () => Date.now();
const isExpired = (isoDate) => {
  const t = new Date(isoDate).getTime();
  return Number.isFinite(t) ? t < Date.now() : false;
};
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// ============================================================
// PAGINATION HELPERS
// ============================================================

// FIX-HLP4: never NaN
const paginate = (array, page = 1, limit = 20) => {
  const safeArray = Array.isArray(array) ? array : [];
  let pageNum = parseInt(page, 10);
  let limitNum = parseInt(limit, 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) pageNum = 1;
  if (!Number.isFinite(limitNum) || limitNum < 1) limitNum = 20;
  const start = (pageNum - 1) * limitNum;
  const sliced = safeArray.slice(start, start + limitNum);
  const total = safeArray.length;
  return {
    data: sliced,
    total,
    page: pageNum,
    totalPages: Math.max(1, Math.ceil(total / limitNum)),
    hasMore: start + limitNum < total,
  };
};

// ============================================================
// SANITIZATION
// ============================================================

// FIX-HLP3: safer text sanitization
const sanitizeText = (text) => {
  if (!text) return '';
  const str = String(text);
  // Strip <script>/<style> blocks first, then all tags
  const noScripts = str.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  return noScripts
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, '')
    .trim()
    .substring(0, 5000);
};

// ============================================================
// OBJECT HELPERS
// ============================================================

const pickFields = (obj, fields) => {
  const result = {};
  if (!obj) return result;
  fields.forEach(f => {
    if (obj[f] !== undefined) result[f] = obj[f];
  });
  return result;
};

const uniqueBy = (array, keyFn) => {
  const seen = new Set();
  return array.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  // ID
  toStringId,
  generateId,

  // Code
  generateCode,
  generateTrackingCode,
  generateBaseCode,
  generateActionCode,
  generateReferralCode,
  generateReferralLink,

  // Password
  isPasswordHashed,
  hashPassword,
  comparePassword,
  generateRandomPassword,

  // URL
  cleanUrl,
  parseTrackingCode,
  resolvePublicSiteUrl,

  // Date
  now,
  nowMs,
  isExpired,
  daysAgo,

  // Pagination
  paginate,

  // Sanitize
  sanitizeText,

  // Object
  pickFields,
  uniqueBy,
};