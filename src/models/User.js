// ============================================================
// MEGA TOOLS — USER MODEL (v3.0 Production Hardened)
// ENTERPRISE: Owner + User only. Hierarchy simplified.
// ============================================================

const db = require('../database');
const { ROLES, ALL_ROLES } = require('./roles');
const {
  toStringId,
  generateId,
  generateTrackingCode,
  hashPassword,
  now,
  pickFields,
} = require('../utils/helpers');

// ============================================================
// CONSTANTS
// ============================================================

const USER_READABLE_FIELDS = [
  '_id', 'name', 'fullName', 'username', 'email', 'role',
  'trackingCode', 'phone', 'facebook',
  'profilePic', 'parentId', 'parentUsername', 'createdBy',
  'status',
  'created_at', 'updated_at', 'lastLogin',
  'isOnline', 'lastSeen',
];

const USER_EDITABLE_FIELDS = [
  'name', 'fullName', 'email', 'phone', 'facebook', 'profilePic',
];

// ENTERPRISE v2.0: Owner can edit all fields including trackingCode, status
const USER_OWNER_EDITABLE_FIELDS = [
  ...USER_EDITABLE_FIELDS, 'trackingCode', 'status',
];

// ============================================================
// CREATE
// ============================================================

async function create(data) {
  const nowISO = now();

  // Validation
  if (!data.email || !data.email.trim()) {
    throw new Error('Email is required');
  }
  if (!data.password || data.password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }

  const user = {
    _id: generateId('u'),
    name: data.name || data.fullName || data.username || 'User',
    fullName: data.fullName || data.name || '',
    username: data.username || (data.email ? data.email.split('@')[0] : 'user'),
    email: (data.email || '').toLowerCase().trim(),
    password: hashPassword(data.password || ''),
    role: ALL_ROLES.includes(data.role) ? data.role : ROLES.USER,
    trackingCode: data.trackingCode || generateTrackingCode(),
    phone: data.phone || '',
    facebook: data.facebook || '',
    profilePic: data.profilePic || '',
    parentId: toStringId(data.parentId) || null,
    parentUsername: data.parentUsername || null,
    createdBy: toStringId(data.createdBy) || null,
    status: data.status || 'active',
    isOnline: false,
    lastSeen: null,
    created_at: nowISO,
    updated_at: nowISO,
    lastLogin: null,
  };

  const allUsers = await db.users.read();

  // Check duplicates
  if (allUsers.find(u => u.username === user.username)) {
    throw new Error('Username already exists');
  }
  if (allUsers.find(u => u.email === user.email)) {
    throw new Error('Email already exists');
  }

  allUsers.push(user);
  await db.users.write(allUsers);
  return sanitize(user);
}

// ============================================================
// FIND
// ============================================================

async function findById(id) {
  const user = await db.users.findById(id);
  return user ? sanitize(user) : null;
}

async function findOne(filter = {}) {
  const all = await db.users.read();
  const user = all.find(u => Object.keys(filter).every(k => u[k] === filter[k]));
  return user ? sanitize(user) : null;
}

async function findMany(filters = {}) {
  let users = await db.users.read();

  if (filters.status) users = users.filter(u => u.status === filters.status);
  if (filters.role) users = users.filter(u => u.role === filters.role);
  if (filters.parentId) users = users.filter(u => u.parentId === toStringId(filters.parentId));
  if (filters.search) {
    const q = filters.search.toLowerCase();
    users = users.filter(u =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.trackingCode || '').toLowerCase().includes(q) ||
      (u.username || '').toLowerCase().includes(q)
    );
  }

  users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return users.map(sanitize);
}

async function findByTrackingCode(code) {
  if (!code) return null;
  const all = await db.users.read();
  const user = all.find(u => u.trackingCode === code);
  return user ? sanitize(user) : null;
}

// ============================================================
// UPDATE
// ============================================================

async function update(id, updates, isOwner = false) {
  const allowedFields = isOwner ? USER_OWNER_EDITABLE_FIELDS : USER_EDITABLE_FIELDS;
  const safeUpdates = pickFields(updates, allowedFields);

  // Protect sensitive fields from modification
  delete safeUpdates._id;
  delete safeUpdates.role;
  delete safeUpdates.password;
  delete safeUpdates.username;
  delete safeUpdates.parentId;
  delete safeUpdates.createdBy;
  delete safeUpdates.created_at;
  delete safeUpdates.lastLogin;
  delete safeUpdates.isOnline;

  if (safeUpdates.email) {
    const all = await db.users.read();
    const existing = all.find(u => u.email === safeUpdates.email && toStringId(u._id) !== toStringId(id));
    if (existing) throw new Error('Email already in use');
    safeUpdates.email = safeUpdates.email.toLowerCase().trim();
  }

  const updated = await db.users.findByIdAndUpdate(id, safeUpdates);
  return updated ? sanitize(updated) : null;
}

async function updatePassword(id, newPassword) {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }
  return db.users.findByIdAndUpdate(id, { password: hashPassword(newPassword) });
}

async function updateLastLogin(id) {
  return db.users.findByIdAndUpdate(id, { lastLogin: now() });
}

async function updatePresence(id, isOnline) {
  return db.users.findByIdAndUpdate(id, {
    isOnline: !!isOnline,
    lastSeen: now(),
  });
}

// ============================================================
// DELETE
// ============================================================

async function remove(id) {
  const user = await db.users.findById(id);
  if (!user) return null;
  // Protect owner deletion
  if (user.role === ROLES.OWNER) return null;
  return db.users.findByIdAndDelete(id);
}

// ============================================================
// COUNT
// ============================================================

async function count(filters = {}) {
  return db.users.count(filters);
}

// ============================================================
// HELPERS
// ============================================================

function sanitize(user) {
  if (!user) return null;
  const cleaned = {};
  USER_READABLE_FIELDS.forEach(f => {
    if (user[f] !== undefined) cleaned[f] = user[f];
  });
  cleaned._id = toStringId(cleaned._id);
  cleaned.id = cleaned._id;
  return cleaned;
}

/**
 * v2.0 Clean: Get all user IDs accessible to the given user.
 * Owner → all users
 * User → self only
 */
async function getAccessibleUserIds(user) {
  if (!user) return [];
  const allUsers = await db.users.read();
  const uid = toStringId(user._id);
  const ids = [uid];

  if (user.role === ROLES.OWNER) {
    allUsers.forEach(u => ids.push(toStringId(u._id)));
  }
  // User: only self (already added above)

  return [...new Set(ids)];
}

/**
 * v2.0 Clean: Get ALL tracking codes accessible to a given user.
 * Owner → all tracking codes
 * User → own tracking code only
 */
async function getAccessibleTrackingCodes(user) {
  if (!user) return [];
  const allUsers = await db.users.read();
  const codes = [user.trackingCode].filter(Boolean);

  if (user.role === ROLES.OWNER) {
    allUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
  }

  return [...new Set(codes)];
}

/**
 * Get tracking codes accessible for a specific user ID.
 * @param {string} userId - User ID to lookup
 * @returns {string[]} Array of tracking codes
 */
async function getTrackingCodesForUser(userId) {
  const allUsers = await db.users.read();
  const uid = toStringId(userId);
  const user = allUsers.find(u => toStringId(u._id) === uid);
  if (!user) return [];
  return getAccessibleTrackingCodes(user);
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  create,
  findById,
  findOne,
  findMany,
  findByTrackingCode,
  update,
  updatePassword,
  updateLastLogin,
  updatePresence,
  remove,
  count,
  getAccessibleUserIds,
  getAccessibleTrackingCodes,
  getTrackingCodesForUser,
  sanitize,
  USER_READABLE_FIELDS,
};