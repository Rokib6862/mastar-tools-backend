// ============================================================
// MEGA TOOLS — USER MODEL
// ============================================================

const db = require('../database');
const { ROLES, ALL_ROLES } = require('./roles');
const {
  toStringId,
  generateId,
  generateTrackingCode,
  hashPassword,
  isPasswordHashed,
  now,
  pickFields,
} = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// CONSTANTS
// ============================================================

const USER_READABLE_FIELDS = [
  '_id', 'name', 'fullName', 'username', 'email', 'role',
  'trackingCode', 'referralCode', 'phone', 'facebook',
  'profilePic', 'parentId', 'parentUsername', 'createdBy',
  'status', 'isTrial', 'trialExpiry', 'trialRole',
  'created_at', 'updated_at', 'lastLogin',
];

const USER_EDITABLE_FIELDS = [
  'name', 'fullName', 'email', 'phone', 'facebook', 'profilePic', 'referralCode',
];

const USER_ADMIN_EDITABLE_FIELDS = [
  ...USER_EDITABLE_FIELDS, 'trackingCode', 'status', 'isTrial', 'trialExpiry',
];

// ============================================================
// CREATE
// ============================================================

async function create(data) {
  const nowISO = now();

  const user = {
    _id: generateId('u'),
    name: data.name || data.fullName || data.username || 'User',
    fullName: data.fullName || data.name || '',
    username: data.username || (data.email ? data.email.split('@')[0] : 'user'),
    email: (data.email || '').toLowerCase().trim(),
    password: hashPassword(data.password || ''),
    role: ALL_ROLES.includes(data.role) ? data.role : ROLES.USER,
    trackingCode: data.trackingCode || generateTrackingCode(),
    referralCode: data.referralCode || '',
    phone: data.phone || '',
    facebook: data.facebook || '',
    profilePic: data.profilePic || '',
    parentId: toStringId(data.parentId) || null,
    parentUsername: data.parentUsername || null,
    createdBy: toStringId(data.createdBy) || null,
    status: data.status || 'active',
    isTrial: data.isTrial || false,
    trialExpiry: data.isTrial ? new Date(Date.now() + CONFIG.TRIAL_DURATION_MS).toISOString() : null,
    trialRole: data.trialRole || null,
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

  // Ensure unique referral code
  if (user.referralCode && allUsers.some(u => u.referralCode === user.referralCode)) {
    user.referralCode = user.referralCode + '_' + Math.random().toString(36).slice(2, 6);
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
  if (filters.isTrial !== undefined) users = users.filter(u => u.isTrial === filters.isTrial);
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
  const all = await db.users.read();
  const user = all.find(u => u.trackingCode === code);
  return user ? sanitize(user) : null;
}

// ============================================================
// UPDATE
// ============================================================

async function update(id, updates, isAdmin = false) {
  const allowedFields = isAdmin ? USER_ADMIN_EDITABLE_FIELDS : USER_EDITABLE_FIELDS;
  const safeUpdates = pickFields(updates, allowedFields);

  if (safeUpdates.email) {
    const all = await db.users.read();
    const existing = all.find(u => u.email === safeUpdates.email && toStringId(u._id) !== toStringId(id));
    if (existing) throw new Error('Email already in use');
    safeUpdates.email = safeUpdates.email.toLowerCase().trim();
  }

  // Protect owner role
  delete safeUpdates.role;
  if (updates.role === ROLES.OWNER) delete updates.role;

  const updated = await db.users.findByIdAndUpdate(id, safeUpdates);
  return updated ? sanitize(updated) : null;
}

async function updatePassword(id, newPassword) {
  return db.users.findByIdAndUpdate(id, { password: hashPassword(newPassword) });
}

async function updateLastLogin(id) {
  return db.users.findByIdAndUpdate(id, { lastLogin: now() });
}

// ============================================================
// DELETE
// ============================================================

async function remove(id) {
  const user = await db.users.findById(id);
  if (!user) return null;
  // Protect owner deletion
  if (user.role === ROLES.OWNER && !user.isTrial) return null;
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
 * Get all user IDs accessible to the given user based on role hierarchy.
 * OWNER → all users
 * ADMIN → self + direct children (TM + User) + TM's children (User)
 * TM → self + direct children (User)
 * USER → self only
 */
async function getAccessibleUserIds(user) {
  if (!user) return [];
  const allUsers = await db.users.read();
  const uid = toStringId(user._id);
  const ids = [uid];

  if (user.role === ROLES.OWNER) {
    allUsers.forEach(u => ids.push(toStringId(u._id)));
  } else if (user.role === ROLES.ADMIN) {
    const directChildren = allUsers.filter(u => u.parentId === uid);
    directChildren.forEach(u => ids.push(toStringId(u._id)));
    const tmIds = directChildren.filter(u => u.role === ROLES.TEAM_MANAGER).map(u => toStringId(u._id));
    allUsers.forEach(u => {
      if (tmIds.includes(u.parentId)) ids.push(toStringId(u._id));
    });
  } else if (user.role === ROLES.TEAM_MANAGER) {
    allUsers.filter(u => u.parentId === uid).forEach(u => ids.push(toStringId(u._id)));
  }

  return [...new Set(ids)];
}

/**
 * Get ALL tracking codes accessible to a given user (including full hierarchy below them).
 * This is used for personal link visibility — when a link is assigned to a user,
 * everyone in that user's hierarchy (including the user) should see it.
 */
async function getAccessibleTrackingCodes(user) {
  if (!user) return [];
  const allUsers = await db.users.read();
  const uid = toStringId(user._id);
  const codes = [user.trackingCode].filter(Boolean);

  if (user.role === ROLES.OWNER) {
    allUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
  } else if (user.role === ROLES.ADMIN) {
    const directUsers = allUsers.filter(u => u.parentId === uid);
    directUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
    const tmIds = directUsers.filter(u => u.role === ROLES.TEAM_MANAGER).map(u => toStringId(u._id));
    allUsers.forEach(u => {
      if (u.trackingCode && tmIds.includes(u.parentId)) codes.push(u.trackingCode);
    });
  } else if (user.role === ROLES.TEAM_MANAGER) {
    allUsers.filter(u => u.parentId === uid).forEach(u => {
      if (u.trackingCode) codes.push(u.trackingCode);
    });
  }

  return [...new Set(codes)];
}

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
  remove,
  count,
  getAccessibleUserIds,
  getAccessibleTrackingCodes,
  getTrackingCodesForUser,
  sanitize,
  USER_READABLE_FIELDS,
};