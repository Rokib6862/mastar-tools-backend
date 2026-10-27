// ============================================================
// MEGA TOOLS — SESSION MANAGER (ENTERPRISE v7.0)
// GLOBAL 24-HOUR INBOX LIFECYCLE + TRASH AUTO-PERMANENT-DELETE
// - Inbox: sessions archive to trash after 24h cycle
// - Trash: sessions older than 24h are permanently deleted
// FIX-T1: getGlobalTimerState validates cycleStart AND cycleEnd
//         AND future cycleEnd — corrupt / past state returns null
// FIX-T2: initializeGlobalTimer always regenerates when state invalid
//         (cycleStart<=0 OR cycleEnd<=now OR type mismatch)
// FIX-T3: globalCleanupCheck double-guards — auto-repair before cleanup
// FIX-T4: globalInboxCleanup never runs on invalid / past cycleEnd
// FIX-T5: safe numeric coercion for all timestamp comparisons
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
// FIX-T1: strict validation
// ============================================================

function isValidTimerState(data) {
  if (!data || typeof data !== 'object') return false;
  const start = Number(data.cycleStart);
  const end = Number(data.cycleEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start <= 0) return false;
  if (end <= 0) return false;
  if (end <= start) return false;
  if (end <= Date.now()) return false;
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
      return existing;
    }
    const now = Date.now();
    const state = {
      cycleStart: now,
      cycleEnd: now + CONFIG.INBOX_GLOBAL_CYCLE_MS,
      lastCleanupAt: (existing && existing.lastCleanupAt) || null,
      cleanupInProgress: false,
    };
    await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
    console.log('[GlobalInbox] Timer initialized. Cycle ends:', new Date(state.cycleEnd).toISOString());
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

    // FIX-T4: never run on invalid cycleEnd
    const end = Number(state.cycleEnd) || 0;
    if (end <= 0 || end > Date.now()) {
      // Not due yet — silently skip
      return;
    }

    state.cleanupInProgress = true;
    await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
    console.log('[GlobalInbox] Cleanup started...');

    const allSessions = await db.readJSON('sessions') || [];
    const allUsers = await db.readJSON('users') || [];
    const owner = allUsers.find(u => u.role === 'owner');
    const ownerId = owner ? owner._id.toString() : null;
    const ownerTC = owner ? (owner.trackingCode || '') : '';
    const now = new Date().toISOString();

    if (allSessions.length === 0) {
      console.log('[GlobalInbox] No sessions to cleanup');
      state.cleanupInProgress = false;
      state.cycleStart = Date.now();
      state.cycleEnd = Date.now() + CONFIG.INBOX_GLOBAL_CYCLE_MS;
      await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
      return;
    }

    const trashItems = [];
    const ownerTrashItems = [];

    for (const session of allSessions) {
      if (!session._id) continue;
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

    const existingTrash = await db.readJSON('trash') || [];
    const existingIds = new Set(existingTrash.map(t => t.originalId));
    const newTrashItems = trashItems.filter(t => !existingIds.has(t.originalId));
    await db.writeJSON('trash', [...existingTrash, ...newTrashItems]);

    const existingOwnerTrash = await db.readJSON('owner_trash') || [];
    const existingOwnerIds = new Set(existingOwnerTrash.map(t => t.originalId));
    const newOwnerItems = ownerTrashItems.filter(t => !existingOwnerIds.has(t.originalId));
    await db.writeJSON('owner_trash', [...existingOwnerTrash, ...newOwnerItems]);

    const verifyTrash = await db.readJSON('trash') || [];
    const verifyOwnerTrash = await db.readJSON('owner_trash') || [];
    const verifiedTrashIds = new Set(verifyTrash.map(t => t.originalId));
    const verifiedOwnerIds = new Set(verifyOwnerTrash.map(t => t.originalId));

    const remainingSessions = allSessions.filter(s => {
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
    state.cycleEnd = Date.now() + CONFIG.INBOX_GLOBAL_CYCLE_MS;
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

    let trash = await db.readJSON('trash') || [];
    let ownerTrash = await db.readJSON('owner_trash') || [];

    const isExpired = (item) => {
      const at = item.deletedAt || item.timestamp;
      if (!at) return false;
      const age = nowMs - new Date(at).getTime();
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
// FIX-T3: auto-repair invalid timer before attempting cleanup
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
    const now = Date.now();

    // If invalid or past — reinitialize instead of cleanup
    if (end <= 0 || start <= 0 || end <= start) {
      await initializeGlobalTimer();
      return;
    }

    if (now < end) return; // not due yet

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
      try { data = await db.readJSON('sessions') || []; } catch (err) { return []; }
    }
    if (!data || data.length === 0) return [];
    const nowMs = Date.now();
    return data.filter(s => {
      if (!s._id) return false;
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
    grouped[ownerCode].push({ _id: s._id, isLive: s.isLive, status: s.status, lastActivity: s.lastActivity });
  }
  for (const [ownerCode, ownerSessions] of Object.entries(grouped)) {
    try {
      ioInstance.to('room_' + ownerCode).emit('sessionStatusDelta', {
        timestamp: new Date().toISOString(),
        sessions: ownerSessions,
      });
    } catch (_) {}
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

async function statusMonitor() {
  try {
    const nowMs = Date.now();
    prevStatusEvictExpired(nowMs);

    const all = await safeReadSessions();
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
  statusMonitorTimer = setInterval(statusMonitor, 3000);
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
};