// ============================================================
// MEGA TOOLS — TRASH MODEL
// ============================================================

const db = require('../database');
const { toStringId, now } = require('../utils/helpers');
const CONFIG = require('../config');
const { ROLES, getRoleLevel } = require('./roles');

// ============================================================
// FIND
// ============================================================

async function findMany(filters = {}) {
  let trash = await db.trash.read();

  if (filters.trackingCode) {
    trash = trash.filter(t => t.trackingCode === filters.trackingCode);
  }
  if (filters.userId) {
    trash = trash.filter(t => t.trashedBy && t.trashedBy[toStringId(filters.userId)]);
  }

  trash.sort((a, b) => new Date(b.trashedAt || b.deletedAt) - new Date(a.trashedAt || a.deletedAt));
  return trash;
}

async function findById(id) {
  return db.trash.findById(id);
}

// ============================================================
// CLEAR — Role-Based Cascade Hide
// ============================================================
// Rules:
//   - User hides from self only
//   - Team Manager hides from self + their users
//   - Admin hides from self + their team managers + users
//   - Owner permanent delete (clear all)
// ============================================================

async function clearAll(filters = {}) {
  let trash = await db.trash.read();
  const totalBefore = trash.length;
  const { trackingCode, userRole, userTrackingCodes } = filters;

  if (userRole === ROLES.OWNER) {
    // Owner: permanent delete everything
    await db.trash.write([]);
    return { cleared: totalBefore, remaining: 0 };
  }

  // Non-Owner: hide from own view + child roles
  const codesToHide = new Set(userTrackingCodes || []);
  if (trackingCode) codesToHide.add(trackingCode);

  const remaining = trash.filter(t => !codesToHide.has(t.trackingCode));
  const cleared = totalBefore - remaining.length;
  await db.trash.write(remaining);

  return { cleared, remaining: remaining.length };
}

// ============================================================
// AUTO-PRUNE (called by scheduler)
// ============================================================

async function autoPrune() {
  const all = await db.trash.read();
  const nowMs = Date.now();
  const maxAge = CONFIG.TRASH_MAX_AGE_MS;

  const remaining = all.filter(t => {
    const trashedTime = new Date(t.trashedAt || t.deletedAt || t.timestamp || Date.now()).getTime();
    return (nowMs - trashedTime) <= maxAge;
  });

  const pruned = all.length - remaining.length;
  if (pruned > 0) {
    await db.trash.write(remaining);
    console.log(`[Trash] Auto-pruned ${pruned} old items`);
  }
  return pruned;
}

// ============================================================
// COUNT
// ============================================================

async function count(filters = {}) {
  let trash = await db.trash.read();
  if (filters.trackingCode) {
    trash = trash.filter(t => t.trackingCode === filters.trackingCode);
  }
  return trash.length;
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  findMany,
  findById,
  clearAll,
  autoPrune,
  count,
};