// ============================================================
// MEGA TOOLS — UTILITY HELPERS
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
// PASSWORD HELPERS
// ============================================================

const isPasswordHashed = (password) => {
  return password && (password.startsWith('$2b$') || password.startsWith('$2a$'));
};

const hashPassword = (password) => {
  if (isPasswordHashed(password)) return password;
  return bcrypt.hashSync(password, CONFIG.BCRYPT_SALT_ROUNDS);
};

const comparePassword = async (plainPassword, hashedPassword) => {
  return bcrypt.compare(plainPassword, hashedPassword);
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

const parseTrackingCode = (code) => {
  if (!code || typeof code !== 'string') {
    return { trackingCode: null, slug: null, actionCode: null };
  }
  const parts = code.split('_');
  if (parts.length >= 3) {
    return { trackingCode: parts[0], slug: parts[1], actionCode: parts[2] };
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
const isExpired = (isoDate) => new Date(isoDate) < new Date();
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// ============================================================
// PAGINATION HELPERS
// ============================================================

const paginate = (array, page = 1, limit = 20) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.max(1, parseInt(limit));
  const start = (pageNum - 1) * limitNum;
  const sliced = array.slice(start, start + limitNum);
  const total = array.length;
  return {
    data: sliced,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limitNum),
    hasMore: start + limitNum < total,
  };
};

// ============================================================
// SANITIZATION
// ============================================================

const sanitizeText = (text) => {
  if (!text) return '';
  return text
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, '')
    .substring(0, 5000);
};

// ============================================================
// OBJECT HELPERS
// ============================================================

const pickFields = (obj, fields) => {
  const result = {};
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

  // Password
  isPasswordHashed,
  hashPassword,
  comparePassword,
  generateRandomPassword,

  // URL
  cleanUrl,
  parseTrackingCode,

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