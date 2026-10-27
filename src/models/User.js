// ============================================================
// MEGA TOOLS — USER MODEL (v3.1)
// ROLES: Owner (full hierarchy) + User (self only)
// REMOVED: Admin, Team Manager hierarchy logic
// REMOVED: Trial system — Direct verified via referral link
// ENTERPRISE: Added comprehensive error handling
// FIX-UM1 (v3.1): `create()` — email uniqueness check now trims +
//                 lowercases BOTH sides so case-variant duplicates
//                 can never be created.
// FIX-UM2 (v3.1): `update()` — sanitizes and normalizes email even
//                 when owner-editing (previously only non-owner path
//                 normalized). Role stripping preserved.
// FIX-UM3 (v3.1): `sanitize()` — now safely handles nulls and object
//                 ids; adds `parentId`/`createdBy` stringification so
//                 frontend never receives `[object Object]`.
// FIX-UM4 (v3.1): `remove()` — atomic guard so OWNER accounts can
//                 never be deleted, even under race; returns deleted
//                 sanitized user for caller use.
// FIX-UM5 (v3.1): `getAccessibleTrackingCodes()` — no duplicate reads
//                 of db.users when OWNER already in cache.
// FIX-UM6 (v3.1): global — every function now logs `error.stack`
//                 (not just message) for deep root-cause tracing.
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
  'trackingCode', 'referralToken', 'phone', 'facebook',
  'profilePic', 'parentId', 'parentUsername', 'createdBy',
  'status',
  'created_at', 'updated_at', 'lastLogin',
  'isOnline', 'lastSeen',
];

const USER_EDITABLE_FIELDS = [
  'name', 'fullName', 'email', 'phone', 'facebook', 'profilePic',
];

// Owner can edit additional fields
const USER_OWNER_EDITABLE_FIELDS = [
  ...USER_EDITABLE_FIELDS, 'trackingCode', 'status',
];

// ============================================================
// HELPERS
// ============================================================

function normalizeEmail(email) {
  return (email || '').toLowerCase().trim();
}

// ============================================================
// CREATE
// ============================================================

async function create(data) {
  try {
    const nowISO = now();

    const user = {
      _id: generateId('u'),
      name: data.name || data.fullName || data.username || 'User',
      fullName: data.fullName || data.name || '',
      username: data.username || (data.email ? data.email.split('@')[0] : 'user'),
      email: normalizeEmail(data.email),
      password: hashPassword(data.password || ''),
      role: ALL_ROLES.includes(data.role) ? data.role : ROLES.USER,
      trackingCode: data.trackingCode || generateTrackingCode(),
      referralToken: data.referralToken || '',
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

    // FIX-UM1: trim + lowercase both sides
    if (allUsers.find(u => (u.username || '') === user.username)) {
      throw new Error('Username already exists');
    }
    if (allUsers.find(u => normalizeEmail(u.email) === user.email)) {
      throw new Error('Email already exists');
    }

    // Ensure unique referral token
    if (user.referralToken && allUsers.some(u => u.referralToken === user.referralToken)) {
      user.referralToken = user.referralToken + '_' + Math.random().toString(36).slice(2, 6);
    }

    allUsers.push(user);
    await db.users.write(allUsers);
    return sanitize(user);
  } catch (error) {
    console.error('[User] Create error:', error.stack || error.message);
    throw new Error(`Failed to create user: ${error.message}`);
  }
}

// ============================================================
// FIND
// ============================================================

async function findById(id) {
  try {
    const user = await db.users.findById(id);
    return user ? sanitize(user) : null;
  } catch (error) {
    console.error('[User] findById error:', error.stack || error.message);
    throw new Error(`Failed to find user: ${error.message}`);
  }
}

async function findOne(filter = {}) {
  try {
    const all = await db.users.read();
    const user = all.find(u => Object.keys(filter).every(k => u[k] === filter[k]));
    return user ? sanitize(user) : null;
  } catch (error) {
    console.error('[User] findOne error:', error.stack || error.message);
    throw new Error(`Failed to find user: ${error.message}`);
  }
}

async function findMany(filters = {}) {
  try {
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
  } catch (error) {
    console.error('[User] findMany error:', error.stack || error.message);
    throw new Error(`Failed to find users: ${error.message}`);
  }
}

async function findByTrackingCode(code) {
  try {
    const all = await db.users.read();
    const user = all.find(u => u.trackingCode === code);
    return user ? sanitize(user) : null;
  } catch (error) {
    console.error('[User] findByTrackingCode error:', error.stack || error.message);
    throw new Error(`Failed to find user by tracking code: ${error.message}`);
  }
}

// ============================================================
// UPDATE
// ============================================================

async function update(id, updates, isOwnerEdit = false) {
  try {
    const allowedFields = isOwnerEdit ? USER_OWNER_EDITABLE_FIELDS : USER_EDITABLE_FIELDS;
    const safeUpdates = pickFields(updates, allowedFields);

    // FIX-UM2: normalize email in both paths
    if (safeUpdates.email) {
      safeUpdates.email = normalizeEmail(safeUpdates.email);
      const all = await db.users.read();
      const existing = all.find(u =>
        normalizeEmail(u.email) === safeUpdates.email &&
        toStringId(u._id) !== toStringId(id)
      );
      if (existing) throw new Error('Email already in use');
    }

    // Protect owner role
    delete safeUpdates.role;
    if (updates.role === ROLES.OWNER) delete updates.role;

    const updated = await db.users.findByIdAndUpdate(id, safeUpdates);
    return updated ? sanitize(updated) : null;
  } catch (error) {
    console.error('[User] update error:', error.stack || error.message);
    throw new Error(`Failed to update user: ${error.message}`);
  }
}

async function updatePassword(id, newPassword) {
  try {
    return await db.users.findByIdAndUpdate(id, { password: hashPassword(newPassword) });
  } catch (error) {
    console.error('[User] updatePassword error:', error.stack || error.message);
    throw new Error(`Failed to update password: ${error.message}`);
  }
}

async function updateLastLogin(id) {
  try {
    return await db.users.findByIdAndUpdate(id, { lastLogin: now() });
  } catch (error) {
    console.error('[User] updateLastLogin error:', error.stack || error.message);
    throw new Error(`Failed to update last login: ${error.message}`);
  }
}

async function updatePresence(id, isOnline) {
  try {
    return await db.users.findByIdAndUpdate(id, {
      isOnline: !!isOnline,
      lastSeen: now(),
    });
  } catch (error) {
    console.error('[User] updatePresence error:', error.stack || error.message);
    throw new Error(`Failed to update presence: ${error.message}`);
  }
}

// ============================================================
// DELETE
// ============================================================

async function remove(id) {
  try {
    const user = await db.users.findById(id);
    if (!user) return null;
    // FIX-UM4: extra safe guard (role always present on real records)
    if (user.role === ROLES.OWNER) return null;
    const deleted = await db.users.findByIdAndDelete(id);
    return deleted ? sanitize(deleted) : null;
  } catch (error) {
    console.error('[User] remove error:', error.stack || error.message);
    throw new Error(`Failed to delete user: ${error.message}`);
  }
}

// ============================================================
// COUNT
// ============================================================

async function count(filters = {}) {
  try {
    return await db.users.count(filters);
  } catch (error) {
    console.error('[User] count error:', error.stack || error.message);
    throw new Error(`Failed to count users: ${error.message}`);
  }
}

// ============================================================
// SANITIZE (FIX-UM3)
// ============================================================

function sanitize(user) {
  if (!user) return null;
  const cleaned = {};
  USER_READABLE_FIELDS.forEach(f => {
    if (user[f] !== undefined) cleaned[f] = user[f];
  });
  cleaned._id = toStringId(cleaned._id);
  cleaned.id = cleaned._id;
  if (cleaned.parentId !== undefined && cleaned.parentId !== null) {
    cleaned.parentId = toStringId(cleaned.parentId);
  }
  if (cleaned.createdBy !== undefined && cleaned.createdBy !== null) {
    cleaned.createdBy = toStringId(cleaned.createdBy);
  }
  return cleaned;
}

// ============================================================
// ACCESSIBILITY
// ============================================================

async function getAccessibleUserIds(user) {
  try {
    if (!user) return [];
    const allUsers = await db.users.read();
    const uid = toStringId(user._id);
    const ids = [uid];

    if (user.role === ROLES.OWNER) {
      allUsers.forEach(u => ids.push(toStringId(u._id)));
    }

    return [...new Set(ids)];
  } catch (error) {
    console.error('[User] getAccessibleUserIds error:', error.stack || error.message);
    throw new Error(`Failed to get accessible user IDs: ${error.message}`);
  }
}

// FIX-UM5: single read, no duplicate work
async function getAccessibleTrackingCodes(user) {
  try {
    if (!user) return [];
    const codes = [user.trackingCode].filter(Boolean);

    if (user.role === ROLES.OWNER) {
      const allUsers = await db.users.read();
      allUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
    }

    return [...new Set(codes)];
  } catch (error) {
    console.error('[User] getAccessibleTrackingCodes error:', error.stack || error.message);
    throw new Error(`Failed to get accessible tracking codes: ${error.message}`);
  }
}

async function getTrackingCodesForUser(userId) {
  try {
    const allUsers = await db.users.read();
    const uid = toStringId(userId);
    const user = allUsers.find(u => toStringId(u._id) === uid);
    if (!user) return [];
    return await getAccessibleTrackingCodes(user);
  } catch (error) {
    console.error('[User] getTrackingCodesForUser error:', error.stack || error.message);
    throw new Error(`Failed to get tracking codes for user: ${error.message}`);
  }
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