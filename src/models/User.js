// ============================================================
// MEGA TOOLS — USER MODEL (v3.1 FIXED)
// ROLES: Owner (full hierarchy) + User (self only)
// FIXED v3.1: getTrackingCodesForUser properly implemented
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

const USER_OWNER_EDITABLE_FIELDS = [
  ...USER_EDITABLE_FIELDS, 'trackingCode', 'status',
];

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
      email: (data.email || '').toLowerCase().trim(),
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

    if (allUsers.find(u => u.username === user.username)) {
      throw new Error('Username already exists');
    }
    if (allUsers.find(u => u.email === user.email)) {
      throw new Error('Email already exists');
    }

    if (user.referralToken && allUsers.some(u => u.referralToken === user.referralToken)) {
      user.referralToken = user.referralToken + '_' + Math.random().toString(36).slice(2, 6);
    }

    allUsers.push(user);
    await db.users.write(allUsers);
    return sanitize(user);
  } catch (error) {
    console.error('[User] Create error:', error.message);
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
    console.error('[User] findById error:', error.message);
    throw new Error(`Failed to find user: ${error.message}`);
  }
}

async function findOne(filter = {}) {
  try {
    const all = await db.users.read();
    const user = all.find(u => Object.keys(filter).every(k => u[k] === filter[k]));
    return user ? sanitize(user) : null;
  } catch (error) {
    console.error('[User] findOne error:', error.message);
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
    console.error('[User] findMany error:', error.message);
    throw new Error(`Failed to find users: ${error.message}`);
  }
}

async function findByTrackingCode(code) {
  try {
    const all = await db.users.read();
    const user = all.find(u => u.trackingCode === code);
    return user ? sanitize(user) : null;
  } catch (error) {
    console.error('[User] findByTrackingCode error:', error.message);
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

    if (safeUpdates.email) {
      const all = await db.users.read();
      const existing = all.find(u => u.email === safeUpdates.email && toStringId(u._id) !== toStringId(id));
      if (existing) throw new Error('Email already in use');
      safeUpdates.email = safeUpdates.email.toLowerCase().trim();
    }

    delete safeUpdates.role;
    if (updates.role === ROLES.OWNER) delete updates.role;

    const updated = await db.users.findByIdAndUpdate(id, safeUpdates);
    return updated ? sanitize(updated) : null;
  } catch (error) {
    console.error('[User] update error:', error.message);
    throw new Error(`Failed to update user: ${error.message}`);
  }
}

async function updatePassword(id, newPassword) {
  try {
    return await db.users.findByIdAndUpdate(id, { password: hashPassword(newPassword) });
  } catch (error) {
    console.error('[User] updatePassword error:', error.message);
    throw new Error(`Failed to update password: ${error.message}`);
  }
}

async function updateLastLogin(id) {
  try {
    return await db.users.findByIdAndUpdate(id, { lastLogin: now() });
  } catch (error) {
    console.error('[User] updateLastLogin error:', error.message);
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
    console.error('[User] updatePresence error:', error.message);
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
    if (user.role === ROLES.OWNER) return null;
    return await db.users.findByIdAndDelete(id);
  } catch (error) {
    console.error('[User] remove error:', error.message);
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
    console.error('[User] count error:', error.message);
    return 0;
  }
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
    console.error('[User] getAccessibleUserIds error:', error.message);
    return [];
  }
}

async function getAccessibleTrackingCodes(user) {
  try {
    if (!user) return [];
    const allUsers = await db.users.read();
    const codes = [user.trackingCode].filter(Boolean);

    if (user.role === ROLES.OWNER) {
      allUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
    }

    return [...new Set(codes)];
  } catch (error) {
    console.error('[User] getAccessibleTrackingCodes error:', error.message);
    return [];
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
    console.error('[User] getTrackingCodesForUser error:', error.message);
    return [];
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