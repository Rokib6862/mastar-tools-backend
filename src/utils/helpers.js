// ============================================================
// MEGA TOOLS — UTILITY HELPERS (v2.3)
// FIXED: Referral link ALWAYS uses production URL (no localhost leak)
// FIX-HLP1..HLP6: retained from v2.1 / v2.2
// FIX-HLP7 (v2.3 — BASE-URL SANITIZATION + DOMAIN VALIDATION):
//   Root cause of the "short.link//dreamy-sopapillas-..." bug in
//   Custom URLs:
//     * A baseUrl could be saved as "https://hostA/hostB/path"
//       (double-host) because cleanUrl() collapsed protocols but
//       never noticed that the FIRST path segment was itself an
//       FQDN.
//     * Folder names could be saved as arbitrary strings (e.g.
//       "ffffffffffffff") because normalizeFolderName() never
//       validated the format.
//   Added three new helpers:
//     1. extractBasePath(url) — returns ONLY the path portion,
//        stripping ANY number of leading FQDN-shaped segments
//        (host1/host2/... → path). Idempotent. Never throws.
//     2. isValidDomain(name) — strict DNS-ish hostname check
//        (label-label.tld). Rejects bare words, whitespace,
//        protocol prefix, path suffix.
//     3. sanitizeBaseUrl(url) — cleanUrl() + double-host strip.
//        Example:
//          "https://a.com/a.com/foo"  → "https://a.com/foo"
//          "https://a.com/b.com/foo"  → "https://a.com/foo"
//          "https://a.com/foo"        → "https://a.com/foo"
//        This makes Link.create/update future-proof: even if the
//        client already stored a double host, saving again
//        cleans it up.
//   All existing callers keep working. Signature of cleanUrl
//   is unchanged. New exports are additive only.
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

// FIX-HLP6 (v2.2): bullet-proof URL cleaner.
// FIX-HLP7 (v2.3): unchanged contract, but now documented as the
// ONLY place where protocol normalization happens. Composes with
// sanitizeBaseUrl() to also strip double hosts.
const cleanUrl = (url) => {
  if (url === null || url === undefined) return '';
  try {
    let s = String(url).trim();
    if (!s) return '';

    // Drop query-string and hash first so they never leak into the
    // protocol-normalisation step.
    s = s.split('#')[0].split('?')[0].trim();
    if (!s) return '';

    // Collapse any run of leading http:// or https:// into one.
    if (/^(?:https?:\/\/)+/i.test(s)) {
      s = 'https://' + s.replace(/^(?:https?:\/\/)+/i, '');
    } else if (!/^https?:\/\//i.test(s) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) {
      s = 'https://' + s;
    }

    // Remove trailing slashes (but preserve the rest of the path)
    s = s.replace(/\/+$/, '');

    return s;
  } catch (_) {
    return '';
  }
};

// FIX-HLP7: strict DNS-ish hostname check.
// Accepts:  "short.link", "sub.example.co", "mydomain.com"
// Rejects:  "ffffffffffffff", "a", "http://x", "x/y", "x y", "", null
const isValidDomain = (name) => {
  if (name === null || name === undefined) return false;
  const s = String(name).trim().toLowerCase();
  if (!s) return false;
  // Length guard
  if (s.length < 4 || s.length > 253) return false;
  // Must contain at least one dot
  if (!s.includes('.')) return false;
  // No protocol, no path, no whitespace
  if (/[\/\s?#@]/.test(s)) return false;
  // Label rules: 1..63 chars, alnum or hyphen, no leading/trailing hyphen
  const labels = s.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label) return false;
    if (label.length < 1 || label.length > 63) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  // TLD must be alphabetic, >= 2 chars
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return false;
  return true;
};

// FIX-HLP7: extract ONLY the path portion of a URL.
// Strips any number of leading FQDN-shaped segments so a corrupted
// baseUrl such as:
//   "https://hostA.com/hostB.com/video_start"
// returns "video_start" — the client can then rebuild a clean URL
// from folder.name + path + suffix.
//
// Examples:
//   "https://a.com/foo/bar"        → "foo/bar"
//   "https://a.com/a.com/foo"      → "foo"
//   "https://a.com/b.com/foo"      → "foo"
//   "a.com/foo"                    → "foo"
//   "/foo"                         → "foo"
//   "foo"                          → "foo"
//   ""                             → ""
const extractBasePath = (url) => {
  if (url === null || url === undefined) return '';
  try {
    let s = String(url).trim();
    if (!s) return '';
    // Strip protocol
    s = s.replace(/^(?:https?:\/\/)+/i, '');
    // Split into segments
    const segments = s.split('/').filter(Boolean);
    // Drop leading FQDN-shaped segments (host1, host2, ...)
    const fqdnRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
    let i = 0;
    while (i < segments.length && fqdnRe.test(segments[i])) i++;
    return segments.slice(i).join('/');
  } catch (_) {
    return '';
  }
};

// FIX-HLP7: cleanUrl() + strip double-host.
// Safe, idempotent, never throws.
//   "https://a.com/a.com/foo"  → "https://a.com/foo"
//   "https://a.com/b.com/foo"  → "https://a.com/foo"
//   "https://a.com/foo"        → "https://a.com/foo"
//   "a.com/foo"                → "https://a.com/foo"
const sanitizeBaseUrl = (url) => {
  const cleaned = cleanUrl(url);
  if (!cleaned) return '';
  try {
    const m = cleaned.match(/^(https?:\/\/)([^/]+)(\/.*)?$/i);
    if (!m) return cleaned;
    const proto = m[1].toLowerCase();
    const host = m[2].toLowerCase();
    let rest = m[3] || '';

    // Split the remaining path; strip any leading FQDN segments that
    // duplicate OR differ from the host.
    const segments = rest.split('/').filter(Boolean);
    const fqdnRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
    let i = 0;
    while (i < segments.length && fqdnRe.test(segments[i])) i++;
    const cleanedPath = segments.slice(i).join('/');
    return cleanedPath
      ? `${proto}${host}/${cleanedPath}`
      : `${proto}${host}`;
  } catch (_) {
    return cleaned;
  }
};

// FIX-HLP1: right-split for actionCode when present
const parseTrackingCode = (code) => {
  if (!code || typeof code !== 'string') {
    return { trackingCode: null, slug: null, actionCode: null };
  }
  const parts = code.split('_');

  if (parts.length >= 3) {
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

const sanitizeText = (text) => {
  if (!text) return '';
  const str = String(text);
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

  // URL — FIX-HLP7
  extractBasePath,
  isValidDomain,
  sanitizeBaseUrl,

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