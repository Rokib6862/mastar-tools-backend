// ============================================================
// MEGA TOOLS — SESSION MANAGER (ENTERPRISE v11.0 NO-GRACE)
// v11.0: Grace period REMOVED — direct Online/Offline determination
// ============================================================

const db = require('../database');
const CONFIG = require('../config');
const Session = require('../models/Session');

let ioInstance = null;
let sessionSockets = {};
let statusMonitorTimer = null;
let globalCleanupTimer = null;
const RECENT_WINDOW_MS = 10 * 60 * 1000;

const evidenceMap = new Map();

// ============================================================
// v11.0: STATUS STATE TRACKING (Anti-Flicker Broadcast Only)
// ============================================================
const statusStateMap = new Map();
// key: sessionId → { lastBroadcastTime, lastBroadcastStatus }

function getStatusState(sessionId) {
  const key = sessionId.toString();
  if (!statusStateMap.has(key)) {
    statusStateMap.set(key, {
      lastBroadcastTime: 0,
      lastBroadcastStatus: null,
    });
  }
  return statusStateMap.get(key);
}

function removeStatusState(sessionId) {
  statusStateMap.delete(sessionId.toString());
}

// ============================================================
// v11.0: ANTI-FLICKER BROADCAST — Same status skip, 8s gap
// ============================================================
function shouldBroadcastStatus(sessionId, newStatus, nowMs) {
  const state = getStatusState(sessionId);
  
  // First broadcast always allowed
  if (state.lastBroadcastStatus === null) {
    return true;
  }
  
  // Same status — no broadcast (anti-flicker)
  if (state.lastBroadcastStatus === newStatus) {
    return false;
  }
  
  // Status changed but check minimum gap
  const gap = nowMs - state.lastBroadcastTime;
  if (gap < CONFIG.STATUS_BROADCAST_MIN_GAP_MS) {
    return false; // Too soon, skip
  }
  
  return true;
}

function recordBroadcast(sessionId, newStatus, nowMs) {
  const state = getStatusState(sessionId);
  state.lastBroadcastStatus = newStatus;
  state.lastBroadcastTime = nowMs;
}

function init(io, sockets) {
  ioInstance = io;
  sessionSockets = sockets || {};
  cleanupStaleSessionsOnBoot();
  startStatusMonitor();
  startGlobalCleanupScheduler();
}

async function cleanupStaleSessionsOnBoot() {
  try {
    const liveSessions = await db.sessions.find({ isLive: true, hiddenForAll: false }, { limit: 10000 });
    const nowMs = Date.now();
    let changed = 0;
    for (const s of liveSessions) {
      if (!s._id) continue;
      const lastActivityMs = new Date(s.lastActivity || s.timestamp || 0).getTime();
      const elapsed = nowMs - lastActivityMs;
      const sessionAge = nowMs - new Date(s.created_at || s.timestamp || 0).getTime();
      if (elapsed > CONFIG.SESSION_TIMEOUT_MS || sessionAge > CONFIG.MAX_SESSION_DURATION_MS) {
        await Session.updatePresence(s._id, { isLive: false, status: 'Offline' });
        removeStatusState(s._id);
        changed++;
      }
    }
    if (changed > 0) console.log(`[StatusMonitor] Boot cleanup: ${changed} stale sessions set to Offline`);
  } catch (err) {
    console.error('[StatusMonitor] Boot cleanup error:', err.message);
  }
}

// ============================================================
// v11.0: updateEvidence — NO grace period, just evidence tracking
// ============================================================
function updateEvidence(sessionId, evidenceType, data = {}) {
  const key = sessionId.toString();
  if (!evidenceMap.has(key)) {
    evidenceMap.set(key, { lastHeartbeat: 0, lastPolling: 0, lastUserActivity: 0, socketAlive: false, socketId: null });
  }
  const evidence = evidenceMap.get(key);
  const nowMs = Date.now();
  switch (evidenceType) {
    case 'socket_connect': 
      evidence.socketAlive = true; 
      evidence.socketId = data.socketId || null; 
      evidence.lastUserActivity = nowMs; 
      break;
    case 'socket_disconnect': 
      evidence.socketAlive = false; 
      evidence.socketId = null; 
      // v11.0: socket disconnect হলে সরাসরি heartbeat/polling evidence clear
      evidence.lastHeartbeat = 0;
      evidence.lastPolling = 0;
      break;
    case 'heartbeat': 
      evidence.lastHeartbeat = nowMs; 
      evidence.lastUserActivity = nowMs;
      break;
    case 'polling': 
      evidence.lastPolling = nowMs;
      evidence.lastUserActivity = nowMs;
      break;
    case 'user_activity': 
      evidence.lastUserActivity = nowMs;
      break;
  }
}

function removeEvidence(sessionId) {
  const key = sessionId.toString();
  evidenceMap.delete(key);
  removeStatusState(sessionId);
}

// ============================================================
// ✅ v9.3: GLOBAL TIMER — reads from JSON array or object
// ============================================================
async function getGlobalTimerState() {
  try {
    const data = await db.globalTimer.read();
    if (Array.isArray(data) && data.length > 0 && data[0]?.cycleStart) return data[0];
    if (data && !Array.isArray(data) && data.cycleStart) return data;
    return await initializeGlobalTimer();
  } catch {
    return await initializeGlobalTimer();
  }
}

async function initializeGlobalTimer() {
  try {
    const existing = await db.globalTimer.findOne({ _id: 'global_timer' });
    const nowMs = Date.now();

    if (existing && existing.cycleStart && existing.cycleEnd && nowMs < existing.cycleEnd) {
      return existing;
    }

    const state = {
      _id: 'global_timer',
      cycleStart: nowMs,
      cycleEnd: nowMs + CONFIG.INBOX_GLOBAL_CYCLE_MS,
      lastCleanupAt: existing?.lastCleanupAt || null,
      cleanupInProgress: false
    };

    await db.globalTimer.deleteOne('global_timer').catch(() => {});
    await db.globalTimer.insertOne(state);

    console.log('[GlobalInbox] Timer initialized (fresh 24h cycle):', new Date(state.cycleEnd).toISOString());
    return state;
  } catch (err) {
    console.error('[GlobalInbox] Timer init error:', err.message);
    return null;
  }
}

async function getRemainingTimeMs() {
  const state = await getGlobalTimerState();
  if (!state || !state.cycleEnd) return CONFIG.INBOX_GLOBAL_CYCLE_MS;
  return Math.max(0, state.cycleEnd - Date.now());
}

// ============================================================
// ✅ v9.3: 100% INBOX CLEANUP — ALL sessions transfer
// ============================================================

async function globalInboxCleanup() {
  try {
    const state = await getGlobalTimerState();
    if (!state) return { success: false, transferred: 0, failed: 0, message: 'No timer state' };
    if (state.cleanupInProgress) return { success: false, transferred: 0, failed: 0, message: 'Cleanup already in progress' };

    await db.globalTimer.deleteOne('global_timer').catch(() => {});
    await db.globalTimer.insertOne({ ...state, cleanupInProgress: true });
    console.log('[GlobalInbox] Cleanup started...');

    const now = new Date().toISOString();
    const nowMs = Date.now();

    const allSessions = await db.sessions.find({}, { limit: 100000 });
    const allUsers = await db.users.read();
    const owner = allUsers.find(u => u.role === 'owner');

    let transferredCount = 0;
    let failedCount = 0;
    const failedSessions = [];

    console.log(`[GlobalInbox] Processing ${allSessions.length} sessions...`);

    for (const session of allSessions) {
      if (!session || !session._id) continue;
      const sid = session._id.toString();

      const tc = session.trackingCode || '';
      const user = allUsers.find(u => u.trackingCode && tc.startsWith(u.trackingCode));

      const trashItem = {
        ...session,
        _id: 'trash_' + sid + '_' + (user ? user._id.toString() : 'unknown'),
        originalId: sid,
        deletedBy: user ? user._id.toString() : 'unknown',
        deletedAt: now,
        permanentlyDeleted: false,
      };

      let trashVerified = false;
      let ownerTrashVerified = false;

      try {
        const trashInserted = await db.trash.insertOne(trashItem);
        if (trashInserted) {
          const verifyTrash = await db.trash.findOne({ originalId: sid });
          trashVerified = !!verifyTrash;
        }

        if (owner) {
          const ownerTrashItem = {
            ...session,
            _id: 'owner_trash_' + sid + '_' + owner._id.toString(),
            originalId: sid,
            deletedBy: owner._id.toString(),
            deletedAt: now,
            permanentlyDeleted: false,
          };
          const ownerInserted = await db.owner_trash.insertOne(ownerTrashItem);
          if (ownerInserted) {
            const verifyOwner = await db.owner_trash.findOne({ originalId: sid });
            ownerTrashVerified = !!verifyOwner;
          }
        } else {
          ownerTrashVerified = true;
        }

        if (trashVerified && ownerTrashVerified) {
          await db.sessions.deleteOne(sid);
          removeEvidence(sid);
          transferredCount++;
          console.log(`[Cleanup] Transferred: ${sid}`);
        } else {
          failedCount++;
          failedSessions.push(sid);
          console.error(`[Cleanup] Verification failed — kept in inbox: ${sid}`);
        }
      } catch (err) {
        failedCount++;
        failedSessions.push(sid);
        console.error(`[Cleanup] Error processing ${sid}: ${err.message}`);
      }
    }

    const newState = {
      _id: 'global_timer',
      cleanupInProgress: false,
      lastCleanupAt: now,
      cycleStart: nowMs,
      cycleEnd: nowMs + CONFIG.INBOX_GLOBAL_CYCLE_MS,
    };
    await db.globalTimer.deleteOne('global_timer').catch(() => {});
    await db.globalTimer.insertOne(newState);

    console.log(`[GlobalInbox] Cleanup complete. Transferred: ${transferredCount}, Failed: ${failedCount}`);
    console.log('[GlobalInbox] Timer reset — next cycle:', new Date(newState.cycleEnd).toISOString());

    if (ioInstance && transferredCount > 0) {
      ioInstance.emit('globalInboxCleared', { count: transferredCount, timestamp: now });
    }

    return { success: true, transferred: transferredCount, failed: failedCount, failedSessions };
  } catch (err) {
    console.error('[GlobalInbox] Cleanup error:', err.message);
    await db.globalTimer.deleteOne('global_timer').catch(() => {});
    await db.globalTimer.insertOne({ _id: 'global_timer', cleanupInProgress: false, cycleStart: Date.now(), cycleEnd: Date.now() + CONFIG.INBOX_GLOBAL_CYCLE_MS, lastCleanupAt: null }).catch(() => {});
    return { success: false, transferred: 0, failed: 0, message: err.message };
  }
}

async function globalCleanupCheck() {
  try {
    const state = await getGlobalTimerState();
    if (!state) return;
    if (!state.cycleEnd || state.cycleEnd - Date.now() <= 0) {
      if (!state.cleanupInProgress) {
        console.log('[GlobalInbox] Cycle expired — starting cleanup');
        await globalInboxCleanup();
      }
    }
  } catch (err) {
    console.error('[GlobalInbox] Scheduler check error:', err.message);
  }
}

function startGlobalCleanupScheduler() {
  initializeGlobalTimer();
  if (globalCleanupTimer) clearInterval(globalCleanupTimer);
  globalCleanupTimer = setInterval(globalCleanupCheck, 60000);
  setTimeout(globalCleanupCheck, 5000);
}

async function safeReadSessions() {
  try { return await db.sessions.find({ hiddenForAll: false }, { limit: 10000 }); }
  catch (err) { return []; }
}

function hasValidEvidence(sessionId, nowMs) {
  const key = sessionId.toString();
  const evidence = evidenceMap.get(key);
  if (!evidence) return false;
  const windowMs = CONFIG.STATUS_DETECTION_WINDOW_MS;
  if (evidence.socketAlive === true) return true;
  if (nowMs - evidence.lastHeartbeat <= windowMs) return true;
  if (nowMs - evidence.lastPolling <= windowMs) return true;
  if (nowMs - evidence.lastUserActivity <= windowMs) return true;
  return false;
}

function isStaleByData(session, nowMs) {
  if (!session || !session.lastActivity) return true;
  const elapsed = nowMs - new Date(session.lastActivity).getTime();
  const maxSilence = CONFIG.STATUS_DETECTION_WINDOW_MS + (CONFIG.HEARTBEAT_INTERVAL_MS * 3);
  return elapsed > maxSilence;
}

function isSessionExpired(session, nowMs) {
  if (!session || !session.created_at && !session.timestamp) return false;
  const createdTime = new Date(session.created_at || session.timestamp).getTime();
  return (nowMs - createdTime) > CONFIG.MAX_SESSION_DURATION_MS;
}

function emitToOwnerRoom(sessions, nowMs) {
  if (!ioInstance || !sessions || sessions.length === 0) return;
  const grouped = {};
  for (const s of sessions) {
    const sid = s._id.toString();
    
    if (!shouldBroadcastStatus(sid, s.status, nowMs)) {
      continue;
    }
    
    recordBroadcast(sid, s.status, nowMs);
    
    const tc = s.trackingCode || '';
    if (!tc) continue;
    const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
    if (!grouped[ownerCode]) grouped[ownerCode] = [];
    grouped[ownerCode].push({ _id: s._id, isLive: s.isLive, status: s.status, lastActivity: s.lastActivity, visitorId: s.visitorId, trackingCode: s.trackingCode });
  }
  
  for (const [ownerCode, ownerSessions] of Object.entries(grouped)) {
    ioInstance.to('room_' + ownerCode).emit('sessionStatusDelta', { timestamp: new Date().toISOString(), sessions: ownerSessions });
  }
}

// ============================================================
// v11.0: statusMonitor — NO grace period, direct evidence check
// ============================================================
async function statusMonitor() {
  try {
    const all = await safeReadSessions();
    if (!all || all.length === 0) return;
    const nowMs = Date.now();
    const changedSessions = [];
    
    for (const session of all) {
      if (!session._id) continue;
      const sid = session._id.toString();
      
      let shouldBeOnline = hasValidEvidence(sid, nowMs);
      if (shouldBeOnline && isStaleByData(session, nowMs)) shouldBeOnline = false;
      if (shouldBeOnline && isSessionExpired(session, nowMs)) shouldBeOnline = false;
      
      const newStatus = shouldBeOnline ? 'Online' : 'Offline';
      
      if (newStatus !== session.status || (session.isLive !== shouldBeOnline)) {
        await Session.updatePresence(session._id, { status: newStatus, isLive: shouldBeOnline });
        session.status = newStatus;
        session.isLive = shouldBeOnline;
        changedSessions.push(session);
      }
    }
    
    if (changedSessions.length > 0) {
      emitToOwnerRoom(changedSessions, nowMs);
      console.log('[StatusMonitor] Status changed:', changedSessions.map(s => s._id + '=' + s.status).join(', '));
    }
  } catch (err) {
    console.error('[StatusMonitor] Error:', err.message);
  }
}

function startStatusMonitor() {
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  statusMonitorTimer = setInterval(statusMonitor, CONFIG.STATUS_MONITOR_INTERVAL_MS);
  setTimeout(statusMonitor, 1000);
}

function stop() {
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  if (globalCleanupTimer) clearInterval(globalCleanupTimer);
  evidenceMap.clear();
  statusStateMap.clear();
}

function getIO() { return ioInstance; }
function getSessionSockets() { return sessionSockets; }

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

module.exports = {
  init, stop, statusMonitor, getIO, getSessionSockets, getRemainingTimeMs, globalInboxCleanup,
  globalCleanupCheck, updateEvidence, removeEvidence, isSocketAlive,
  getGlobalTimerState, initializeGlobalTimer
};