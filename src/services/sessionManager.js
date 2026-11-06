// ============================================================
// MEGA TOOLS — SESSION MANAGER (v11.0 — ADAPTIVE MONITOR)
// GLOBAL 24-HOUR INBOX LIFECYCLE + TRASH AUTO-PERMANENT-DELETE
// FIX-T1..T13: retained
// FIX-T14 (v11.0 — ADAPTIVE STATUS MONITOR):
//   - statusMonitor interval adapts to session count
//   - Empty (0 sessions): 30s interval (2 wakeups/min → 120/hr)
//   - Active (≥1 session): 5s interval (was 3s)
//   - When session count crosses threshold, timer reschedules
//   - Reduces Render Free tier CPU wakeups by -40% (active) to -90% (idle)
//   - Frontend UX: 5s status delay is imperceptible (was 3s)
// ============================================================

const db = require('../database');
const CONFIG = require('../config');
const Session = require('../models/Session');

// ============================================================
// STATE
// ============================================================

let ioInstance = null;
let sessionSockets = {};
let statusMonitorTimer = null;
let globalCleanupTimer = null;
let trashCleanupTimer = null;
let previousStatusMap = new Map();

const ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const RECENT_WINDOW_MS = 10 * 60 * 1000;
const PREV_STATUS_TTL_MS = 10 * 60 * 1000;
const PREV_STATUS_MAX = 2000;

// Trash retention: auto permanent-delete after this age
const TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;
const TRASH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // check every hour

// FIX-T14: adaptive status monitor intervals
const STATUS_INTERVAL_ACTIVE = 5000;   // 5s when sessions exist
const STATUS_INTERVAL_IDLE   = 30000;  // 30s when no sessions
let currentStatusInterval = STATUS_INTERVAL_ACTIVE;

// ============================================================
// FIX-T10: safe array coercion helper
// ============================================================
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

// ============================================================
// FIX-T13: NOON-ALIGNED CYCLE HELPER
// ============================================================
const BD_OFFSET_MS = 6 * 60 * 60 * 1000; // 6 hours

function getNextNoonBDMs() {
  const utcNowMs = Date.now();
  const bdNowMs = utcNowMs + BD_OFFSET_MS;
  const bdNow = new Date(bdNowMs);
  const y = bdNow.getUTCFullYear();
  const m = bdNow.getUTCMonth();
  const d = bdNow.getUTCDate();
  const noonBdUtcMs = Date.UTC(y, m, d, 12, 0, 0) - BD_OFFSET_MS;
  if (utcNowMs >= noonBdUtcMs) {
    return noonBdUtcMs + 24 * 60 * 60 * 1000;
  }
  return noonBdUtcMs;
}

function isNoonAligned(ms) {
  if (!Number.isFinite(ms)) return false;
  const bdMs = ms + BD_OFFSET_MS;
  const dt = new Date(bdMs);
  return dt.getUTCHours() === 12 && dt.getUTCMinutes() === 0 && dt.getUTCSeconds() === 0;
}

// ============================================================
// INIT
// ============================================================

function init(io, sockets) {
  ioInstance = io;
  sessionSockets = sockets || {};
  startStatusMonitor();
  startGlobalCleanupScheduler();
  startTrashCleanupScheduler();
}

// ============================================================
// GLOBAL TIMER PERSISTENCE
// ============================================================

function isValidTimerState(data) {
  if (!data || typeof data !== 'object') return false;
  const start = Number(data.cycleStart);
  const end = Number(data.cycleEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start <= 0) return false;
  if (end <= 0) return false;
  if (end <= start) return false;
  return true;
}

async function getGlobalTimerState() {
  try {
    const data = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
    if (isValidTimerState(data)) return data;
    return null;
  } catch { return null; }
}

async function initializeGlobalTimer() {
  try {
    const existing = await getGlobalTimerState();

    if (isValidTimerState(existing)) {
      const endMs = Number(existing.cycleEnd);
      const nowMs = Date.now();
      if (endMs > nowMs && !isNoonAligned(endMs)) {
        const newEndMs = getNextNoonBDMs();
        console.log(
          '[GlobalInbox] MIGRATION — realigning cycleEnd from',
          new Date(endMs).toISOString(),
          'to next noon BD:',
          new Date(newEndMs).toISOString()
        );
        existing.cycleEnd = newEndMs;
        await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, existing);
        return existing;
      }
      return existing;
    }

    const now = Date.now();
    const state = {
      cycleStart: now,
      cycleEnd: getNextNoonBDMs(),
      lastCleanupAt: (existing && existing.lastCleanupAt) || null,
      cleanupInProgress: false,
    };
    await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
    console.log('[GlobalInbox] Timer initialized. Cycle ends (next noon BD):', new Date(state.cycleEnd).toISOString());
    return state;
  } catch (err) {
    console.error('[GlobalInbox] Timer init error:', err.message);
    return null;
  }
}

async function getRemainingTimeMs() {
  let state = await getGlobalTimerState();
  if (!state) {
    state = await initializeGlobalTimer();
    if (!state) return CONFIG.INBOX_GLOBAL_CYCLE_MS;
  }
  const end = Number(state.cycleEnd) || 0;
  return Math.max(0, end - Date.now());
}

// ============================================================
// PREVIOUS STATUS MAP — TTL + cap
// ============================================================

function prevStatusSet(sid, status, nowMs) {
  previousStatusMap.set(sid, { status, changedAt: nowMs });
  if (previousStatusMap.size > PREV_STATUS_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of previousStatusMap.entries()) {
      if (v.changedAt < oldestTime) { oldestTime = v.changedAt; oldestKey = k; }
    }
    if (oldestKey) previousStatusMap.delete(oldestKey);
  }
}

function prevStatusEvictExpired(nowMs) {
  for (const [k, v] of previousStatusMap.entries()) {
    if (nowMs - v.changedAt > PREV_STATUS_TTL_MS) previousStatusMap.delete(k);
  }
}

// ============================================================
// GLOBAL CLEANUP — ARCHIVE TO USER TRASH + OWNER TRASH
// ============================================================

async function globalInboxCleanup() {
  try {
    const state = await getGlobalTimerState();
    if (!state) return;
    if (state.cleanupInProgress) return;

    const end = Number(state.cycleEnd) || 0;
    if (end <= 0) {
      console.warn('[GlobalInbox] Corrupt cycleEnd — skipping cleanup');
      return;
    }
    if (end > Date.now()) {
      return;
    }

    state.cleanupInProgress = true;
    await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
    console.log('[GlobalInbox] Cleanup started...');

    const allSessions = asArray(await db.readJSON('sessions'));
    const allUsers = asArray(await db.readJSON('users'));

    const owner = allUsers.find(u => u.role === 'owner');
    const ownerId = owner ? owner._id.toString() : null;
    const ownerTC = owner ? (owner.trackingCode || '') : '';
    const now = new Date().toISOString();

    if (allSessions.length === 0) {
      console.log('[GlobalInbox] No sessions to cleanup');
      state.cleanupInProgress = false;
      state.cycleStart = Date.now();
      state.cycleEnd = getNextNoonBDMs();
      state.lastCleanupAt = now;
      await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
      return;
    }

    const trashItems = [];
    const ownerTrashItems = [];

    for (const session of allSessions) {
      if (!session || !session._id) continue;
      const sid = session._id.toString();

      const tc = session.trackingCode || '';
      const matchedUser = allUsers.find(u => u.trackingCode && tc.startsWith(u.trackingCode));
      const matchedUserId = matchedUser ? matchedUser._id.toString() : null;

      trashItems.push({
        ...session,
        _id: 'trash_' + sid + '_' + (matchedUserId || 'unknown'),
        originalId: sid,
        deletedBy: matchedUserId || 'unknown',
        deletedAt: now,
        permanentlyDeleted: false,
      });

      const isOwnerOwnSession = ownerId && (matchedUserId === ownerId || (ownerTC && tc.startsWith(ownerTC)));
      if (owner && !isOwnerOwnSession) {
        ownerTrashItems.push({
          ...session,
          _id: 'owner_trash_' + sid + '_' + ownerId,
          originalId: sid,
          deletedBy: ownerId,
          deletedAt: now,
          permanentlyDeleted: false,
        });
      }
    }

    const existingTrash = asArray(await db.readJSON('trash'));
    const existingIds = new Set(existingTrash.map(t => t.originalId));
    const newTrashItems = trashItems.filter(t => !existingIds.has(t.originalId));
    await db.writeJSON('trash', [...existingTrash, ...newTrashItems]);

    const existingOwnerTrash = asArray(await db.readJSON('owner_trash'));
    const existingOwnerIds = new Set(existingOwnerTrash.map(t => t.originalId));
    const newOwnerItems = ownerTrashItems.filter(t => !existingOwnerIds.has(t.originalId));
    await db.writeJSON('owner_trash', [...existingOwnerTrash, ...newOwnerItems]);

    const verifyTrash = asArray(await db.readJSON('trash'));
    const verifyOwnerTrash = asArray(await db.readJSON('owner_trash'));
    const verifiedTrashIds = new Set(verifyTrash.map(t => t.originalId));
    const verifiedOwnerIds = new Set(verifyOwnerTrash.map(t => t.originalId));

    const freshSessions = asArray(await db.readJSON('sessions'));
    const remainingSessions = freshSessions.filter(s => {
      if (!s || !s._id) return false;
      const sid = s._id.toString();
      const tc = s.trackingCode || '';
      const matchedUser = allUsers.find(u => u.trackingCode && tc.startsWith(u.trackingCode));
      const matchedUserId = matchedUser ? matchedUser._id.toString() : null;
      const isOwnerOwnSession = ownerId && (matchedUserId === ownerId || (ownerTC && tc.startsWith(ownerTC)));
      const inUserTrash = verifiedTrashIds.has(sid);
      const inOwnerTrash = verifiedOwnerIds.has(sid);
      if (isOwnerOwnSession) return !inUserTrash;
      return !(inUserTrash && inOwnerTrash);
    });

    await db.writeJSON('sessions', remainingSessions);
    console.log('[GlobalInbox] Cleanup complete. Archived:', newTrashItems.length, 'Owner:', newOwnerItems.length, 'Remaining:', remainingSessions.length);

    state.cleanupInProgress = false;
    state.lastCleanupAt = now;
    state.cycleStart = Date.now();
    state.cycleEnd = getNextNoonBDMs();
    await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);

    if (ioInstance) {
      try {
        ioInstance.emit('globalInboxCleared', {
          count: newTrashItems.length,
          ownerCount: newOwnerItems.length,
          timestamp: now,
        });
        ioInstance.emit('inboxCleared', { count: newTrashItems.length });
      } catch (_) {}
    }
  } catch (err) {
    console.error('[GlobalInbox] Cleanup error:', err.message);
    try {
      const state = await getGlobalTimerState();
      if (state) {
        state.cleanupInProgress = false;
        await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
      }
    } catch (_) {}
  }
}

// ============================================================
// TRASH CLEANUP — PERMANENT DELETE AFTER 24H
// ============================================================

async function trashPermanentCleanup() {
  try {
    const nowMs = Date.now();

    let trash = asArray(await db.readJSON('trash'));
    let ownerTrash = asArray(await db.readJSON('owner_trash'));

    const isExpired = (item) => {
      if (!item) return false;
      const at = item.deletedAt || item.timestamp;
      if (!at) return false;
      const atMs = new Date(at).getTime();
      if (!Number.isFinite(atMs)) return false;
      const age = nowMs - atMs;
      return age >= TRASH_RETENTION_MS;
    };

    const trashBefore = trash.length;
    const ownerBefore = ownerTrash.length;

    const keptTrash = trash.filter(t => !isExpired(t));
    const keptOwnerTrash = ownerTrash.filter(t => !isExpired(t));

    const removedTrash = trashBefore - keptTrash.length;
    const removedOwner = ownerBefore - keptOwnerTrash.length;

    if (removedTrash > 0) {
      await db.writeJSON('trash', keptTrash);
    }
    if (removedOwner > 0) {
      await db.writeJSON('owner_trash', keptOwnerTrash);
    }

    if (removedTrash > 0 || removedOwner > 0) {
      console.log(`[TrashCleanup] Permanently deleted ${removedTrash} user trash + ${removedOwner} owner trash items`);
      if (ioInstance) {
        try {
          ioInstance.emit('trashPermanentlyCleared', {
            count: removedTrash,
            ownerCount: removedOwner,
            timestamp: new Date().toISOString(),
          });
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('[TrashCleanup] Error:', err.message);
  }
}

async function startTrashCleanupScheduler() {
  if (trashCleanupTimer) clearInterval(trashCleanupTimer);
  trashCleanupTimer = setInterval(trashPermanentCleanup, TRASH_CLEANUP_INTERVAL_MS);
  setTimeout(() => { trashPermanentCleanup().catch(() => {}); }, 10000);
  console.log('[TrashCleanup] Scheduler started — retention:', Math.round(TRASH_RETENTION_MS / 3600000), 'hours');
}

// ============================================================
// GLOBAL SCHEDULER
// ============================================================

async function globalCleanupCheck() {
  try {
    let state = await getGlobalTimerState();

    if (!state) {
      state = await initializeGlobalTimer();
      return;
    }

    const end = Number(state.cycleEnd) || 0;
    const start = Number(state.cycleStart) || 0;

    if (end <= 0 || start <= 0 || end <= start) {
      await initializeGlobalTimer();
      return;
    }

    if (Date.now() < end) return;

    if (state.cleanupInProgress) return;

    await globalInboxCleanup();
  } catch (err) {
    console.error('[GlobalInbox] Scheduler check error:', err.message);
  }
}

async function startGlobalCleanupScheduler() {
  await initializeGlobalTimer();
  if (globalCleanupTimer) clearInterval(globalCleanupTimer);
  globalCleanupTimer = setInterval(globalCleanupCheck, 60000);
  setTimeout(() => { globalCleanupCheck().catch(() => {}); }, 5000);
}

// ============================================================
// SAFE READ SESSIONS
// ============================================================

async function safeReadSessions() {
  try {
    let data = await db.sessions.read();
    if (!Array.isArray(data)) {
      try { data = asArray(await db.readJSON('sessions')); } catch (err) { return []; }
    }
    data = asArray(data);
    if (data.length === 0) return [];
    const nowMs = Date.now();
    return data.filter(s => {
      if (!s || !s._id) return false;
      if (s.isLive === true) return true;
      const lastActivityMs = new Date(s.lastActivity || s.timestamp || 0).getTime();
      if (nowMs - lastActivityMs < RECENT_WINDOW_MS) return true;
      if (previousStatusMap.has(s._id.toString())) return true;
      return false;
    });
  } catch (err) { return []; }
}

function isSocketAlive(visitorId, trackingCode, ip) {
  if (!ioInstance) return false;
  if (visitorId && sessionSockets[visitorId]) {
    const socket = ioInstance.sockets.sockets.get(sessionSockets[visitorId]);
    if (socket && socket.connected) return true;
  }
  if (trackingCode && ip) {
    const code = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
    const key = code + '_' + ip;
    const socketId = sessionSockets[key];
    if (socketId) {
      const socket = ioInstance.sockets.sockets.get(socketId);
      return socket && socket.connected;
    }
  }
  return false;
}

function emitToOwnerRoom(sessions) {
  if (!ioInstance || !sessions || sessions.length === 0) return;
  const grouped = {};
  for (const s of sessions) {
    const tc = s.trackingCode || '';
    if (!tc) continue;
    const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
    if (!grouped[ownerCode]) grouped[ownerCode] = [];
    grouped[ownerCode].push({ _id: s._id, isLive: s.isLive, status: s.status, lastActivity: s.lastActivity, trackingCode: tc });
  }
  for (const [ownerCode, ownerSessions] of Object.entries(grouped)) {
    try {
      ioInstance.to('room_' + ownerCode).emit('sessionStatusDelta', {
        timestamp: new Date().toISOString(),
        sessions: ownerSessions,
      });
    } catch (_) {}
    for (const s of ownerSessions) {
      if (s.trackingCode && s.trackingCode !== ownerCode) {
        try {
          ioInstance.to('room_' + s.trackingCode).emit('sessionStatusDelta', {
            timestamp: new Date().toISOString(),
            sessions: [s],
          });
        } catch (_) {}
      }
    }
  }
}

function computeStatus(session, socketAlive, nowMs) {
  const lastActivityMs = new Date(session.lastActivity || session.timestamp || Date.now()).getTime();
  const elapsed = nowMs - lastActivityMs;
  if (session.isLive === false) return 'Offline';
  if (socketAlive) {
    if (elapsed > ACTIVITY_TIMEOUT_MS) return 'Offline';
    return 'Online';
  }
  const HEARTBEAT_GRACE_MS = 3000;
  if (elapsed < HEARTBEAT_GRACE_MS) return 'Online';
  return 'Offline';
}

// ============================================================
// FIX-T14: ADAPTIVE STATUS MONITOR
// Reschedules interval based on session count:
//   0 sessions  → STATUS_INTERVAL_IDLE  (30s)
//   1+ sessions → STATUS_INTERVAL_ACTIVE (5s)
// ============================================================

function _rescheduleStatusMonitor(desiredInterval) {
  if (desiredInterval === currentStatusInterval) return;
  currentStatusInterval = desiredInterval;
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  statusMonitorTimer = setInterval(statusMonitor, currentStatusInterval);
}

async function statusMonitor() {
  try {
    const nowMs = Date.now();
    prevStatusEvictExpired(nowMs);

    const all = await safeReadSessions();

    // FIX-T14: adaptive interval — adjust based on session count
    const desiredInterval = (!all || all.length === 0) ? STATUS_INTERVAL_IDLE : STATUS_INTERVAL_ACTIVE;
    _rescheduleStatusMonitor(desiredInterval);

    if (!all || all.length === 0) return;

    const changedSessions = [];
    for (const session of all) {
      if (!session._id) continue;
      if (session.hiddenForAll) continue;
      const sid = session._id.toString();
      const socketAlive = isSocketAlive(session.visitorId, session.trackingCode, session.ip);
      const newStatus = computeStatus(session, socketAlive, nowMs);
      const prev = previousStatusMap.get(sid);
      if (newStatus === session.status) {
        if (prev) prev.changedAt = nowMs;
        continue;
      }
      if (!prev || prev.status !== newStatus) {
        prevStatusSet(sid, newStatus, nowMs);
        continue;
      }
      const elapsed = nowMs - prev.changedAt;
      if (newStatus === 'Offline' && !socketAlive && elapsed < 3000) continue;
      session.status = newStatus;
      session.isLive = newStatus !== 'Offline';
      session.lastActivity = new Date().toISOString();
      changedSessions.push(session);
      prevStatusSet(sid, newStatus, nowMs);
      try {
        await Session.updatePresence(session._id, {
          status: session.status,
          isLive: session.isLive,
          lastActivity: session.lastActivity,
        });
      } catch (err) {}
    }
    if (changedSessions.length > 0) emitToOwnerRoom(changedSessions);
  } catch (err) {}
}

function startStatusMonitor() {
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  currentStatusInterval = STATUS_INTERVAL_ACTIVE;
  statusMonitorTimer = setInterval(statusMonitor, currentStatusInterval);
  setTimeout(() => { statusMonitor().catch(() => {}); }, 1000);
}

function stop() {
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  if (globalCleanupTimer) clearInterval(globalCleanupTimer);
  if (trashCleanupTimer) clearInterval(trashCleanupTimer);
  statusMonitorTimer = null;
  globalCleanupTimer = null;
  trashCleanupTimer = null;
  previousStatusMap.clear();
}

function getIO() { return ioInstance; }
function getSessionSockets() { return sessionSockets; }

module.exports = {
  init,
  stop,
  statusMonitor,
  getIO,
  getSessionSockets,
  getRemainingTimeMs,
  initializeGlobalTimer,
  globalInboxCleanup,
  trashPermanentCleanup,
  getNextNoonBDMs,
  isNoonAligned,
};