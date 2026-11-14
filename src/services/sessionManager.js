// ============================================================
// MEGA TOOLS — SESSION MANAGER (v12.3 — SINGLE EMIT SOURCE)
// GLOBAL 24-HOUR INBOX LIFECYCLE + TRASH AUTO-PERMANENT-DELETE
// FIX-T1..T14, FIX-SM1..SM19: retained
//
// FIX-SM20 (v12.3 — DOUBLE-EMIT ELIMINATION):
//   Root cause of persistent flicker despite FIX-SM19:
//     statusMonitor called `Session.updatePresence` (which now
//     emits 'session:statusFlip' via Session.eventBus → server.js
//     → socket) AND THEN called `emitToOwnerRoom(changedSessions)`
//     — a SECOND `sessionStatusDelta` for the SAME flip.
//     The FE received BOTH deltas (with different transitionIds),
//     processed them twice, and the UI/handlers churned.
//
//   FIX:
//     • emitToOwnerRoom is NO LONGER called from statusMonitor.
//       Every real status flip is now emitted exactly ONCE via
//       Session.eventBus (FIX-S27) → server.js → socket.
//     • emitToOwnerRoom function is KEPT (unused) because other
//       modules may import it — no API shape break.
//     • No other behaviour touched — cleanup, trash, cycle,
//       isSocketAlive, boot sweep, computeStatus, cooldown are
//       unchanged.
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
let emptyOfflineSinceMap = new Map();

// FIX-SM19: wider timeout (60s → 90s) to survive one heartbeat miss.
const ACTIVITY_TIMEOUT_MS = parseInt(process.env.ACTIVITY_TIMEOUT_MS) || 90 * 1000;
const RECENT_WINDOW_MS = 10 * 60 * 1000;
const PREV_STATUS_TTL_MS = 10 * 60 * 1000;
const PREV_STATUS_MAX = 2000;

// FIX-SM19: anti-flicker cooldown — any flip requires 10s stable gap.
const MIN_FLIP_INTERVAL_MS = parseInt(process.env.MIN_FLIP_INTERVAL_MS) || 10 * 1000;

// FIX-SM18: faster empty purge — 120s → 90s, env-overridable.
const EMPTY_OFFLINE_GRACE_MS = parseInt(process.env.EMPTY_OFFLINE_GRACE_MS) || 90 * 1000;
const STALE_SOCKET_FORCE_DELETE_MS = 2 * ACTIVITY_TIMEOUT_MS;

// FIX-SM18: boot sweep 5min → 3min, env-overridable.
const BOOT_SWEEP_MIN_AGE_MS = parseInt(process.env.BOOT_SWEEP_MIN_AGE_MS) || 3 * 60 * 1000;

const TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;
const TRASH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const CLEANUP_IDEMPOTENCY_MS = 15 * 1000;
const GLOBAL_CLEANUP_INTERVAL_MS = 30 * 1000;
const GLOBAL_CLEANUP_BOOT_DELAY_MS = 1000;

const STATUS_INTERVAL_ACTIVE = 5000;
const STATUS_INTERVAL_IDLE   = 30000;
let currentStatusInterval = STATUS_INTERVAL_ACTIVE;

// ============================================================
// HELPERS
// ============================================================

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function normalizeSingleton(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : null;
  }
  if (typeof value === 'object') return value;
  return null;
}

async function retryWrite(fn, label) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      console.warn('[GlobalInbox] write failed (' + (i + 1) + '/3) ' + (label || '') + ':', err.message);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

function isEmptySession(s) {
  if (!s) return false;
  const subs = Array.isArray(s.submissions) ? s.submissions : [];
  if (subs.length > 0) return false;
  const fd = s.formData && typeof s.formData === 'object' ? s.formData : null;
  if (fd) {
    const keys = Object.keys(fd).filter(k => fd[k] !== undefined && fd[k] !== null && fd[k] !== '');
    if (keys.length > 0) return false;
  }
  return true;
}

function emitSessionDeleted(session) {
  if (!ioInstance || !session) return;
  const tc = session.trackingCode || '';
  if (!tc) return;
  const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
  const payload = {
    timestamp: new Date().toISOString(),
    sessionId: String(session._id),
    visitorId: session.visitorId || null,
    trackingCode: tc,
    session: {
      _id: session._id,
      visitorId: session.visitorId || null,
      trackingCode: tc,
      baseCode: session.baseCode || '',
    },
  };
  try { ioInstance.to('room_' + ownerCode).emit('sessionDeleted', payload); } catch (_) {}
  if (tc !== ownerCode) {
    try { ioInstance.to('room_' + tc).emit('sessionDeleted', payload); } catch (_) {}
  }
}

// ============================================================
// NOON-ALIGNED CYCLE
// ============================================================
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;

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
// BOOT SWEEP — FIX-SM15 + FIX-SM18 (3-min age)
// ============================================================
async function bootSweepStuckSessions() {
  try {
    const all = asArray(await db.sessions.read());
    if (all.length === 0) return { deleted: 0 };
    const nowMs = Date.now();
    let deleted = 0;
    for (const s of all) {
      if (!s || !s._id) continue;
      if (s.hiddenForAll) continue;
      if (!isEmptySession(s)) continue;
      const offlineNow = s.isLive === false || s.status === 'Offline';
      if (!offlineNow) continue;
      const lastActMs = new Date(s.lastActivity || s.timestamp || 0).getTime();
      const age = nowMs - lastActMs;
      if (age < BOOT_SWEEP_MIN_AGE_MS) continue;
      try {
        await Session.remove(s._id);
        deleted++;
        console.log('[SessionManager] BOOT-SWEEP deleted empty-offline session:', String(s._id), '| ageSec:', Math.round(age/1000));
        emitSessionDeleted(s);
      } catch (e) {
        console.error('[SessionManager] BOOT-SWEEP delete failed:', String(s._id), e.message);
      }
    }
    if (deleted > 0) {
      console.log('[SessionManager] BOOT-SWEEP completed. Total deleted:', deleted);
    }
    return { deleted };
  } catch (e) {
    console.error('[SessionManager] BOOT-SWEEP error:', e.message);
    return { deleted: 0 };
  }
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
  setTimeout(() => { bootSweepStuckSessions().catch(() => {}); }, 2000);
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

function recoverPartialState(data) {
  if (!data || typeof data !== 'object') return null;
  const end = Number(data.cycleEnd);
  if (!Number.isFinite(end) || end <= 0) return null;
  const start = Number(data.cycleStart);
  if (Number.isFinite(start) && start > 0 && end > start) return data;
  const lastCleanupMs = data.lastCleanupAt ? new Date(data.lastCleanupAt).getTime() : NaN;
  const recoveredStart = Number.isFinite(lastCleanupMs) && lastCleanupMs > 0
    ? lastCleanupMs
    : (end - CONFIG.INBOX_GLOBAL_CYCLE_MS);
  return {
    ...data,
    cycleStart: recoveredStart,
    cycleEnd: end,
    lastCleanupAt: data.lastCleanupAt || null,
    cleanupInProgress: !!data.cleanupInProgress,
  };
}

async function getGlobalTimerState() {
  try {
    const raw = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
    const data = normalizeSingleton(raw);
    if (!data) return null;
    if (isValidTimerState(data)) return data;
    const recovered = recoverPartialState(data);
    if (recovered && isValidTimerState(recovered)) {
      console.warn('[GlobalInbox] PARTIAL STATE RECOVERED:', { old: data, recovered });
      try { await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, recovered); } catch (_) {}
      return recovered;
    }
    return null;
  } catch { return null; }
}

async function initializeGlobalTimer() {
  try {
    const existing = await getGlobalTimerState();

    if (isValidTimerState(existing)) {
      const endMs = Number(existing.cycleEnd);
      const nowMs = Date.now();
      if (endMs <= nowMs) {
        console.warn('[GlobalInbox] OVERDUE — resetting cycle from', new Date(endMs).toISOString());
        const fresh = {
          cycleStart: nowMs,
          cycleEnd: getNextNoonBDMs(),
          lastCleanupAt: existing.lastCleanupAt || null,
          cleanupInProgress: false,
        };
        await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, fresh);
        return fresh;
      }
      if (!isNoonAligned(endMs)) {
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

    try {
      const verifyRaw = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
      const verify = normalizeSingleton(verifyRaw);
      if (!isValidTimerState(verify)) {
        console.warn('[GlobalInbox] ⚠ Verify FAILED — persisted state invalid:', verify);
      } else {
        console.log('[GlobalInbox] ✓ Verify OK — persisted cycleStart:', verify.cycleStart, '| cycleEnd:', verify.cycleEnd);
      }
    } catch (verifyErr) {
      console.warn('[GlobalInbox] ⚠ Verify error:', verifyErr.message);
    }

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
// PREVIOUS STATUS MAP
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
// GLOBAL CLEANUP
// ============================================================

async function globalInboxCleanup() {
  try {
    const state = await getGlobalTimerState();
    if (!state) {
      console.warn('[GlobalInbox] Cleanup aborted — no valid state');
      return;
    }
    if (state.cleanupInProgress) {
      console.warn('[GlobalInbox] Cleanup skipped — already in progress');
      return;
    }

    const end = Number(state.cycleEnd) || 0;
    if (end <= 0) {
      console.warn('[GlobalInbox] Corrupt cycleEnd — skipping cleanup');
      return;
    }
    if (end > Date.now()) {
      return;
    }

    const lastCleanupMs = state.lastCleanupAt ? new Date(state.lastCleanupAt).getTime() : 0;
    if (lastCleanupMs && (Date.now() - lastCleanupMs) < CLEANUP_IDEMPOTENCY_MS) {
      console.warn('[GlobalInbox] Cleanup skipped — ran <', Math.round(CLEANUP_IDEMPOTENCY_MS / 1000), 's ago');
      return;
    }

    state.cleanupInProgress = true;
    await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
    console.log('[GlobalInbox] Cleanup started...', {
      cycleStart: state.cycleStart,
      cycleEnd: state.cycleEnd,
      now: Date.now(),
    });

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
    await retryWrite(() => db.writeJSON('trash', [...existingTrash, ...newTrashItems]), 'trash');

    const existingOwnerTrash = asArray(await db.readJSON('owner_trash'));
    const existingOwnerIds = new Set(existingOwnerTrash.map(t => t.originalId));
    const newOwnerItems = ownerTrashItems.filter(t => !existingOwnerIds.has(t.originalId));
    await retryWrite(() => db.writeJSON('owner_trash', [...existingOwnerTrash, ...newOwnerItems]), 'owner_trash');

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

    await retryWrite(() => db.writeJSON('sessions', remainingSessions), 'sessions');
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
// TRASH CLEANUP
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
      console.warn('[GlobalInbox] No state — initializing');
      await initializeGlobalTimer();
      return;
    }

    const end = Number(state.cycleEnd) || 0;
    const start = Number(state.cycleStart) || 0;

    if (end <= 0 || start <= 0 || end <= start) {
      console.warn('[GlobalInbox] SELF-HEAL — corrupt state:', { start, end });
      await initializeGlobalTimer();
      return;
    }

    if (Date.now() < end) return;

    if (state.cleanupInProgress) return;

    console.log('[GlobalInbox] Cycle expired — firing cleanup. State:', {
      cycleStart: state.cycleStart,
      cycleEnd: state.cycleEnd,
      lastCleanupAt: state.lastCleanupAt,
      now: Date.now(),
    });
    await globalInboxCleanup();
  } catch (err) {
    console.error('[GlobalInbox] Scheduler check error:', err.message);
  }
}

async function startGlobalCleanupScheduler() {
  await initializeGlobalTimer();
  if (globalCleanupTimer) clearInterval(globalCleanupTimer);
  globalCleanupTimer = setInterval(globalCleanupCheck, GLOBAL_CLEANUP_INTERVAL_MS);
  setTimeout(() => { globalCleanupCheck().catch(() => {}); }, GLOBAL_CLEANUP_BOOT_DELAY_MS);

  const state = await getGlobalTimerState();
  if (state) {
    console.log('[GlobalInbox] Scheduler started. Cycle:', {
      cycleStartISO: new Date(state.cycleStart).toISOString(),
      cycleEndISO: new Date(state.cycleEnd).toISOString(),
      remainingMs: Math.max(0, state.cycleEnd - Date.now()),
      checkEveryMs: GLOBAL_CLEANUP_INTERVAL_MS,
      bootDelayMs: GLOBAL_CLEANUP_BOOT_DELAY_MS,
    });
  } else {
    console.error('[GlobalInbox] Scheduler started BUT state is NULL — persistence is broken');
  }
}

// ============================================================
// SAFE READ SESSIONS — FIX-SM15
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
      if (emptyOfflineSinceMap.has(s._id.toString())) return true;
      const offlineNow = s.isLive === false || s.status === 'Offline';
      if (offlineNow && isEmptySession(s)) return true;
      return false;
    });
  } catch (err) { return []; }
}

// ============================================================
// isSocketAlive — FIX-SM15 + FIX-SM16 multi-key lookup
// ============================================================
function isSocketAlive(visitorId, trackingCode, ip) {
  if (!ioInstance || !ioInstance.sockets || !ioInstance.sockets.sockets) return false;

  const checkEntry = (key) => {
    if (!key) return false;
    const sid = sessionSockets[key];
    if (!sid) return false;
    const socket = ioInstance.sockets.sockets.get(sid);
    if (socket && socket.connected === true) return true;
    try { delete sessionSockets[key]; } catch (_) {}
    return false;
  };

  if (visitorId && checkEntry(visitorId)) return true;

  if (trackingCode) {
    const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
    if (ip) {
      if (checkEntry(ownerCode + '_' + ip)) return true;
      if (checkEntry(trackingCode + '_' + ip)) return true;
    }
    if (checkEntry('tc_' + trackingCode)) return true;
    if (checkEntry('ip_' + (ip || '::1'))) return true;
  }

  return false;
}

// ============================================================
// emitToOwnerRoom — FIX-SM17
//   FIX-SM20: this function is NO LONGER called by statusMonitor
//   (single emit source now lives in Session.eventBus). The export
//   is preserved for any future caller / other modules.
// ============================================================
function emitToOwnerRoom(sessions) {
  if (!ioInstance || !sessions || sessions.length === 0) return;
  const grouped = {};
  const emitNow = Date.now();
  for (const s of sessions) {
    const tc = s.trackingCode || s.baseCode || '';
    if (!tc) continue;
    const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
    if (!grouped[ownerCode]) grouped[ownerCode] = [];

    const forceOnline = !!s.__forceOnline;
    const transitionId = s.__transitionId || `${s._id}:${emitNow}`;
    const seq = s.__seq || emitNow;

    grouped[ownerCode].push({
      _id: s._id,
      visitorId: s.visitorId,
      isLive: s.isLive,
      status: s.status,
      lastActivity: s.lastActivity,
      lastSeenAt: s.lastSeenAt,
      trackingCode: tc,
      baseCode: s.baseCode || '',
      forceOnline,
      transitionId,
      seq,
    });
  }
  for (const [ownerCode, ownerSessions] of Object.entries(grouped)) {
    try {
      ioInstance.to('room_' + ownerCode).emit('sessionStatusDelta', {
        timestamp: new Date().toISOString(),
        seq: emitNow,
        sessions: ownerSessions,
      });
    } catch (_) {}
    for (const s of ownerSessions) {
      if (s.trackingCode && s.trackingCode !== ownerCode) {
        try {
          ioInstance.to('room_' + s.trackingCode).emit('sessionStatusDelta', {
            timestamp: new Date().toISOString(),
            seq: emitNow,
            sessions: [s],
          });
        } catch (_) {}
      }
    }
  }
}

// ============================================================
// computeStatus — FIX-SM14 + FIX-SM19 (uses lastActivity OR lastSeenAt)
// ============================================================
function computeStatus(session, socketAlive, nowMs) {
  const tsRaw = session.lastActivity || session.lastSeenAt || session.timestamp || Date.now();
  const lastActivityMs = new Date(tsRaw).getTime();
  const elapsed = nowMs - lastActivityMs;

  if (session.isLive === false) return 'Offline';
  if (elapsed > ACTIVITY_TIMEOUT_MS) return 'Offline';
  return 'Online';
}

// ============================================================
// ADAPTIVE STATUS MONITOR
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

    const desiredInterval = (!all || all.length === 0) ? STATUS_INTERVAL_IDLE : STATUS_INTERVAL_ACTIVE;
    _rescheduleStatusMonitor(desiredInterval);

    if (!all || all.length === 0) return;

    const changedSessions = [];

    // FIX-SM14 + FIX-SM15 + FIX-SM18: delete empty offline sessions
    for (const session of all) {
      if (!session || !session._id) continue;
      if (session.hiddenForAll) continue;
      const sid = String(session._id);
      const socketAlive = isSocketAlive(session.visitorId, session.trackingCode, session.ip);
      const offlineNow = session.isLive === false || session.status === 'Offline';

      const lastActMs = new Date(session.lastActivity || session.timestamp || nowMs).getTime();
      const staleAge = nowMs - lastActMs;

      const shouldForceDelete = socketAlive && staleAge >= STALE_SOCKET_FORCE_DELETE_MS;

      if (!isEmptySession(session) || !offlineNow) {
        if (emptyOfflineSinceMap.has(sid)) emptyOfflineSinceMap.delete(sid);
        continue;
      }
      if (socketAlive && !shouldForceDelete) {
        if (emptyOfflineSinceMap.has(sid)) emptyOfflineSinceMap.delete(sid);
        continue;
      }

      if (!emptyOfflineSinceMap.has(sid)) {
        emptyOfflineSinceMap.set(sid, nowMs);
        if (staleAge >= STALE_SOCKET_FORCE_DELETE_MS) {
          // fall-through to delete below
        } else {
          continue;
        }
      }

      const since = emptyOfflineSinceMap.get(sid);
      if (staleAge < STALE_SOCKET_FORCE_DELETE_MS && (nowMs - since) < EMPTY_OFFLINE_GRACE_MS) continue;

      try {
        await Session.remove(sid);
        emptyOfflineSinceMap.delete(sid);
        try { previousStatusMap.delete(sid); } catch (_) {}
        console.log('[SessionManager] Deleted empty offline session:', sid, '| trackingCode:', session.trackingCode || '', '| force:', shouldForceDelete, '| staleSec:', Math.round(staleAge/1000));
        emitSessionDeleted(session);
      } catch (delErr) {
        console.error('[SessionManager] Failed to delete empty offline session:', sid, delErr.message);
      }
    }

    // Normal status transition processing
    for (const session of all) {
      if (!session._id) continue;
      if (session.hiddenForAll) continue;
      const sid = session._id.toString();
      if (emptyOfflineSinceMap.has(sid)) continue;
      const socketAlive = isSocketAlive(session.visitorId, session.trackingCode, session.ip);
      const newStatus = computeStatus(session, socketAlive, nowMs);
      const prev = previousStatusMap.get(sid);

      if (newStatus === session.status) {
        continue;
      }
      if (!prev || prev.status !== newStatus) {
        prevStatusSet(sid, newStatus, nowMs);
        continue;
      }

      const elapsedSinceFlip = nowMs - prev.changedAt;
      if (elapsedSinceFlip < MIN_FLIP_INTERVAL_MS) continue;

      if (newStatus === 'Offline' && !socketAlive && elapsedSinceFlip < 3000) continue;

      const wasOffline = session.isLive === false || session.status === 'Offline';
      const isNowOnline = newStatus === 'Online';

      session.status = newStatus;
      session.isLive = newStatus !== 'Offline';

      session.__forceOnline = wasOffline && isNowOnline;
      session.__transitionId = `${session._id}:${Date.now()}`;
      session.__seq = Date.now();

      changedSessions.push(session);
      prevStatusSet(sid, newStatus, nowMs);
      try {
        await Session.updatePresence(session._id, {
          status: session.status,
          isLive: session.isLive,
        });
      } catch (err) {}
    }

    // FIX-SM20: emitToOwnerRoom is intentionally NOT called here —
    // Session.updatePresence already emits 'session:statusFlip' via
    // Session.eventBus → server.js → socket. Calling emitToOwnerRoom
    // would double-emit and re-introduce flicker.
    if (changedSessions.length > 0) {
      try {
        console.log('[SessionManager] statusMonitor flipped', changedSessions.length, 'session(s) — single emit via Session.eventBus');
      } catch (_) {}
    }
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
  emptyOfflineSinceMap.clear();
}

function getIO() { return ioInstance; }
function getSessionSockets() { return sessionSockets; }

module.exports = {
  init,
  stop,
  statusMonitor,
  bootSweepStuckSessions,
  getIO,
  getSessionSockets,
  getRemainingTimeMs,
  initializeGlobalTimer,
  globalInboxCleanup,
  trashPermanentCleanup,
  getNextNoonBDMs,
  isNoonAligned,
  isEmptySession,
  emitSessionDeleted,
};