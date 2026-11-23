// ============================================================
// MEGA TOOLS — SESSION MANAGER (v16.0 — 24H PERMANENT PURGE)
// GLOBAL 24-HOUR INBOX LIFECYCLE
// FIX-T1..T14, FIX-SM1..SM32: retained
//
// v16.0 (FIX-SM33 — 24H AUTO PURGE + TRASH CLEANUP):
//   User requirement (user-confirmed):
//     • 24h পর session সম্পূর্ণ permanent delete — sessions,
//       trash, owner_trash — তিন জায়গা থেকেই।
//     • Manual delete → per-user hide + trash snapshot → সেই
//       user-এর জন্যই permanent না হওয়া পর্যন্ত অদৃশ্য।
//     • Restore কখনোই সম্ভব নয় (permanent delete শেষ)।
//     • Noon-12 BD cycle অপরিবর্তিত।
//   Changes in this file (FIX-SM33):
//     • trashPermanentCleanup(): RE-ENABLED. 24h+ বয়সী trash
//       entries permanent delete (trash + owner_trash)।
//     • startTrashCleanupScheduler(): boot + প্রতি 1 ঘণ্টায়
//       permanent purge tick।
//     • globalInboxCleanup(): 24h cycle-এ session-কে trash-এ
//       push করার পর scheduled tick-এ permanent delete হবে —
//       double safety, reappear বন্ধ।
//     • bootSweepStuckSessions(): 24h+ পুরনো empty+offline
//       session-কে boot-এ permanent delete (catch-up)।
//     • emitSessionDeleted(): per-user deletedBy respect।
//   Preserved:
//     • 2-min offline, 3-min empty delete, data-bearing protection,
//       Noon-12 BD cycle, isEmptySession, socket events, exports
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

// FIX-SM32: 2-minute inactivity window (was 3 min).
const ACTIVITY_TIMEOUT_MS = parseInt(process.env.ACTIVITY_TIMEOUT_MS) || 120 * 1000;
const RECENT_WINDOW_MS = 10 * 60 * 1000;
const PREV_STATUS_TTL_MS = 10 * 60 * 1000;
const PREV_STATUS_MAX = 2000;

// FIX-SM19: anti-flicker cooldown — any flip requires 10s stable gap.
const MIN_FLIP_INTERVAL_MS = parseInt(process.env.MIN_FLIP_INTERVAL_MS) || 10 * 1000;

// FIX-SM30: empty-offline grace — 3 min.
const EMPTY_OFFLINE_GRACE_MS = parseInt(process.env.EMPTY_OFFLINE_GRACE_MS) || 180 * 1000;
const STALE_SOCKET_FORCE_DELETE_MS = 2 * ACTIVITY_TIMEOUT_MS;

// FIX-SM18: boot sweep 3min, env-overridable.
const BOOT_SWEEP_MIN_AGE_MS = parseInt(process.env.BOOT_SWEEP_MIN_AGE_MS) || 3 * 60 * 1000;

// 24h hard-lock for data-bearing sessions.
const MIN_SESSION_AGE_MS = parseInt(process.env.MIN_SESSION_AGE_MS) || 24 * 60 * 60 * 1000;

// FIX-SM33: TRASH_RETENTION_MS is now ACTIVE (was disabled in v15.x).
// Trash entries older than this → permanent delete.
const TRASH_RETENTION_MS = parseInt(process.env.TRASH_RETENTION_MS) || 24 * 60 * 60 * 1000;
const TRASH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const CLEANUP_IDEMPOTENCY_MS = 15 * 1000;
const RESET_IDEMPOTENCY_MS = 1 * 1000;
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

function getSessionAgeMs(s) {
  if (!s) return Infinity;
  const raw =
    s.created_at ||
    s.createdAt ||
    s.timestamp ||
    s.lastActivity ||
    s.lastSeenAt;
  const t = new Date(raw || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return Infinity;
  return Date.now() - t;
}

function isYoungerThan24h(s) {
  return getSessionAgeMs(s) < MIN_SESSION_AGE_MS;
}

// Per-user aware emit — respects callerId so only the deleter's UI clears.
function emitSessionDeleted(session, deletedBy) {
  if (!ioInstance || !session) return;
  const tc = session.trackingCode || '';
  if (!tc) return;
  const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
  const payload = {
    timestamp: new Date().toISOString(),
    sessionId: String(session._id),
    visitorId: session.visitorId || null,
    trackingCode: tc,
    deletedBy: deletedBy || null,
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
  if (deletedBy) {
    try { ioInstance.to('user_' + String(deletedBy)).emit('sessionDeleted', payload); } catch (_) {}
  }
}

function isSessionForAnyCode(session, codes) {
  if (!session || !Array.isArray(codes) || codes.length === 0) return false;
  const tc = session.trackingCode || '';
  if (!tc) return false;
  for (const code of codes) {
    if (!code) continue;
    if (tc === code) return true;
    if (tc.startsWith(code + '_')) return true;
  }
  return false;
}

function findMatchedUser(allUsers, sessionTC) {
  if (!sessionTC || !Array.isArray(allUsers) || allUsers.length === 0) return null;
  let best = null;
  let bestLen = 0;
  for (const u of allUsers) {
    const utc = u && u.trackingCode;
    if (!utc) continue;
    if (sessionTC === utc || sessionTC.startsWith(utc + '_')) {
      if (utc.length > bestLen) { best = u; bestLen = utc.length; }
    }
  }
  return best;
}

function buildResetKey(scopeTrackingCodes) {
  if (!Array.isArray(scopeTrackingCodes) || scopeTrackingCodes.length === 0) return 'global';
  const sorted = [...new Set(scopeTrackingCodes.filter(Boolean).map(String))].sort();
  return 'scoped:' + sorted.join(',');
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
// BOOT SWEEP — FIX-SM32 + FIX-SM33 (24h purge catch-up)
// ============================================================
async function bootSweepStuckSessions() {
  try {
    const all = asArray(await db.sessions.read());
    if (all.length === 0) return { deleted: 0, offlined: 0, purged: 0 };
    const nowMs = Date.now();
    let deleted = 0;
    let offlined = 0;
    let purged = 0;
    let skippedDataBearing = 0;

    for (const s of all) {
      if (!s || !s._id) continue;
      if (s.hiddenForAll) continue;

      // STEP 1: stale-Online correction
      const lastActMs = new Date(s.lastActivity || s.timestamp || 0).getTime();
      const staleAge = Number.isFinite(lastActMs) ? (nowMs - lastActMs) : Infinity;
      const curStatus = s.isLive === false || s.status === 'Offline' ? 'Offline' : 'Online';
      if (curStatus === 'Online' && staleAge > ACTIVITY_TIMEOUT_MS) {
        try {
          await Session.updatePresence(s._id, {
            status: 'Offline',
            isLive: false,
            offlineSince: new Date(nowMs).toISOString(),
          });
          s.status = 'Offline';
          s.isLive = false;
          s.offlineSince = new Date(nowMs).toISOString();
          offlined++;
        } catch (e) {
          console.error('[SessionManager] BOOT-SWEEP offline-flip failed:', String(s._id), e.message);
        }
      }

      // FIX-SM33: 24h+ old sessions → permanent purge (catch-up).
      const sessionAge = getSessionAgeMs(s);
      if (sessionAge >= MIN_SESSION_AGE_MS) {
        try {
          await Session.remove(s._id);
          purged++;
          console.log('[SessionManager] BOOT-SWEEP 24h+ PURGED:', String(s._id), '| ageHr:', Math.round(sessionAge / 3600000));
          emitSessionDeleted(s);
        } catch (e) {
          console.error('[SessionManager] BOOT-SWEEP purge failed:', String(s._id), e.message);
        }
        continue;
      }

      // STEP 2: only empty+offline eligible for immediate delete
      if (!isEmptySession(s)) {
        skippedDataBearing++;
        continue;
      }
      const offlineNow = s.isLive === false || s.status === 'Offline';
      if (!offlineNow) continue;
      if (staleAge < BOOT_SWEEP_MIN_AGE_MS) continue;

      try {
        await Session.remove(s._id);
        deleted++;
        console.log('[SessionManager] BOOT-SWEEP deleted empty-offline session:', String(s._id), '| ageSec:', Math.round(staleAge / 1000));
        emitSessionDeleted(s);
      } catch (e) {
        console.error('[SessionManager] BOOT-SWEEP delete failed:', String(s._id), e.message);
      }
    }

    if (deleted > 0 || offlined > 0 || purged > 0) {
      console.log('[SessionManager] BOOT-SWEEP completed. deleted:', deleted, '| offlined:', offlined, '| purged:', purged, '| dataBearingSkipped:', skippedDataBearing);
    }
    return { deleted, offlined, purged };
  } catch (e) {
    console.error('[SessionManager] BOOT-SWEEP error:', e.message);
    return { deleted: 0, offlined: 0, purged: 0 };
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
// GLOBAL CLEANUP — 24h cycle → trash, then permanent purge later
// ============================================================
async function globalInboxCleanup(opts = {}) {
  const skipCycleReset = !!opts.skipCycleReset;
  const scopeTrackingCodes = Array.isArray(opts.scopeTrackingCodes)
    ? opts.scopeTrackingCodes.filter(Boolean).map(String)
    : [];
  const isScoped = scopeTrackingCodes.length > 0;
  const resetKey = buildResetKey(scopeTrackingCodes);

  const result = {
    ok: false,
    skipped: false,
    reason: '',
    archived: 0,
    ownerArchived: 0,
    remaining: 0,
    skippedYoung: 0,
    skipCycleReset,
    scopeType: isScoped ? 'scoped' : 'global',
    trackingCodes: scopeTrackingCodes,
  };

  try {
    let state = await getGlobalTimerState();
    if (!state && skipCycleReset) {
      state = {
        cycleStart: 0, cycleEnd: 0,
        lastCleanupAt: null, lastResetAt: null,
        lastResetKey: null, cleanupInProgress: false,
        __synthetic: true,
      };
    }
    if (!state) {
      result.reason = 'no_state';
      return result;
    }
    if (state.cleanupInProgress) {
      result.skipped = true;
      result.reason = 'in_progress';
      return result;
    }

    if (!skipCycleReset) {
      const end = Number(state.cycleEnd) || 0;
      if (end <= 0) {
        result.skipped = true;
        result.reason = 'corrupt_cycle_end';
        return result;
      }
      if (end > Date.now()) {
        result.skipped = true;
        result.reason = 'cycle_not_expired';
        return result;
      }

      const lastCleanupMs = state.lastCleanupAt ? new Date(state.lastCleanupAt).getTime() : 0;
      if (lastCleanupMs && (Date.now() - lastCleanupMs) < CLEANUP_IDEMPOTENCY_MS) {
        result.skipped = true;
        result.reason = 'cleanup_idempotency';
        return result;
      }

      const lastResetMs = state.lastResetAt ? new Date(state.lastResetAt).getTime() : 0;
      const lastKey = state.lastResetKey || '';
      if (lastResetMs && lastKey === 'global' && (Date.now() - lastResetMs) < RESET_IDEMPOTENCY_MS) {
        result.skipped = true;
        result.reason = 'reset_idempotency';
        return result;
      }
    } else {
      const lastResetMs = state.lastResetAt ? new Date(state.lastResetAt).getTime() : 0;
      const lastKey = state.lastResetKey || '';
      if (lastResetMs && lastKey === resetKey && (Date.now() - lastResetMs) < RESET_IDEMPOTENCY_MS) {
        result.skipped = true;
        result.reason = 'reset_idempotency';
        return result;
      }
    }

    state.cleanupInProgress = true;
    if (!state.__synthetic) {
      await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
    }
    console.log('[GlobalInbox] Cleanup started...', {
      skipCycleReset, isScoped, scopeCount: scopeTrackingCodes.length,
      cycleStart: state.cycleStart, cycleEnd: state.cycleEnd, now: Date.now(),
    });

    const allSessions = asArray(await db.readJSON('sessions'));
    const allUsers = asArray(await db.readJSON('users'));

    const owner = allUsers.find(u => u.role === 'owner');
    const ownerId = owner ? owner._id.toString() : null;
    const ownerTC = owner ? (owner.trackingCode || '') : '';
    const now = new Date().toISOString();

    const scopedSessions = isScoped
      ? allSessions.filter(s => s && s._id && isSessionForAnyCode(s, scopeTrackingCodes))
      : allSessions.filter(s => s && s._id);

    const targetedSessions = [];
    let skippedYoung = 0;
    for (const s of scopedSessions) {
      if (isYoungerThan24h(s)) {
        skippedYoung++;
        continue;
      }
      targetedSessions.push(s);
    }
    result.skippedYoung = skippedYoung;

    if (targetedSessions.length === 0) {
      state.cleanupInProgress = false;
      if (!state.__synthetic) {
        if (!skipCycleReset) {
          state.cycleStart = Date.now();
          state.cycleEnd = getNextNoonBDMs();
          state.lastCleanupAt = now;
        } else {
          state.lastResetAt = now;
          state.lastResetKey = resetKey;
        }
        await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
      }

      _emitResetEvent({
        isScoped, scopeTrackingCodes, ownerTC,
        count: 0, ownerCount: 0,
        remaining: scopedSessions.length,
        skippedYoung, timestamp: now,
      });

      result.ok = true;
      result.remaining = scopedSessions.length;
      return result;
    }

    const trashItems = [];
    const ownerTrashItems = [];

    for (const session of targetedSessions) {
      const sid = session._id.toString();
      const tc = session.trackingCode || '';
      const matchedUser = findMatchedUser(allUsers, tc);
      const matchedUserId = matchedUser ? matchedUser._id.toString() : null;

      trashItems.push({
        ...session,
        _id: 'trash_' + sid + '_' + (matchedUserId || 'unknown'),
        originalId: sid,
        deletedBy: matchedUserId || 'unknown',
        deletedAt: now,
        permanentlyDeleted: false,
      });

      const isOwnerOwnSession = ownerId && (
        matchedUserId === ownerId ||
        (ownerTC && (tc === ownerTC || tc.startsWith(ownerTC + '_')))
      );
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
      if (isScoped && !isSessionForAnyCode(s, scopeTrackingCodes)) return true;
      if (isYoungerThan24h(s)) return true;
      const matchedUser = findMatchedUser(allUsers, tc);
      const matchedUserId = matchedUser ? matchedUser._id.toString() : null;
      const isOwnerOwnSession = ownerId && (
        matchedUserId === ownerId ||
        (ownerTC && (tc === ownerTC || tc.startsWith(ownerTC + '_')))
      );
      const inUserTrash = verifiedTrashIds.has(sid);
      const inOwnerTrash = verifiedOwnerIds.has(sid);
      if (isOwnerOwnSession) return !inUserTrash;
      return !(inUserTrash && inOwnerTrash);
    });

    await retryWrite(() => db.writeJSON('sessions', remainingSessions), 'sessions');

    state.cleanupInProgress = false;
    if (!state.__synthetic) {
      if (!skipCycleReset) {
        state.cycleStart = Date.now();
        state.cycleEnd = getNextNoonBDMs();
        state.lastCleanupAt = now;
      } else {
        state.lastResetAt = now;
        state.lastResetKey = resetKey;
      }
      await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
    }

    _emitResetEvent({
      isScoped, scopeTrackingCodes, ownerTC,
      count: newTrashItems.length, ownerCount: newOwnerItems.length,
      remaining: remainingSessions.length,
      skippedYoung, timestamp: now,
    });

    result.ok = true;
    result.archived = newTrashItems.length;
    result.ownerArchived = newOwnerItems.length;
    result.remaining = remainingSessions.length;
    return result;
  } catch (err) {
    console.error('[GlobalInbox] Cleanup error:', err.message);
    result.reason = 'error: ' + (err.message || 'unknown');
    try {
      const state = await getGlobalTimerState();
      if (state) {
        state.cleanupInProgress = false;
        await db.writeJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE, state);
      }
    } catch (_) {}
    return result;
  }
}

function _emitResetEvent({ isScoped, scopeTrackingCodes, ownerTC, count, ownerCount, remaining, skippedYoung, timestamp }) {
  if (!ioInstance) return;
  const payload = {
    count: count || 0,
    ownerCount: ownerCount || 0,
    remaining: remaining || 0,
    skippedYoung: skippedYoung || 0,
    timestamp,
    skipCycleReset: true,
    scopeType: isScoped ? 'scoped' : 'global',
    trackingCodes: isScoped ? scopeTrackingCodes.slice() : [],
  };
  try {
    if (!isScoped) {
      ioInstance.emit('inboxReset', payload);
      return;
    }
    const rooms = new Set();
    for (const code of scopeTrackingCodes) {
      if (code) rooms.add('room_' + code);
      const ownerCode = code && code.includes('_') ? code.split('_')[0] : code;
      if (ownerCode) rooms.add('room_' + ownerCode);
    }
    if (ownerTC) rooms.add('room_' + ownerTC);
    for (const room of rooms) {
      try { ioInstance.to(room).emit('inboxReset', payload); } catch (_) {}
    }
  } catch (_) {}
}

// ============================================================
// TRASH CLEANUP — FIX-SM33 (PERMANENT PURGE AFTER 24H)
//   • Any trash entry whose deletedAt is ≥ TRASH_RETENTION_MS
//     old is permanently deleted from trash + owner_trash.
//   • This is the FINAL step for manual-delete + 24h cycle items.
//   • Restore is impossible after this point.
// ============================================================
async function trashPermanentCleanup() {
  try {
    const nowMs = Date.now();
    const retentionMs = TRASH_RETENTION_MS;

    const allTrash = asArray(await db.readJSON('trash'));
    const allOwnerTrash = asArray(await db.readJSON('owner_trash'));

    let removedTrash = 0;
    let removedOwner = 0;
    const purgedOriginalIds = new Set();

    const survivingTrash = [];
    for (const t of allTrash) {
      if (!t) continue;
      const deletedAtMs = new Date(t.deletedAt || t.timestamp || 0).getTime();
      const ageMs = Number.isFinite(deletedAtMs) && deletedAtMs > 0 ? (nowMs - deletedAtMs) : Infinity;
      if (ageMs >= retentionMs) {
        removedTrash++;
        if (t.originalId) purgedOriginalIds.add(String(t.originalId));
        if (t.sessionId) purgedOriginalIds.add(String(t.sessionId));
        if (t.id) purgedOriginalIds.add(String(t.id));
        continue;
      }
      survivingTrash.push(t);
    }

    const survivingOwner = [];
    for (const t of allOwnerTrash) {
      if (!t) continue;
      const deletedAtMs = new Date(t.deletedAt || t.timestamp || 0).getTime();
      const ageMs = Number.isFinite(deletedAtMs) && deletedAtMs > 0 ? (nowMs - deletedAtMs) : Infinity;
      if (ageMs >= retentionMs) {
        removedOwner++;
        if (t.originalId) purgedOriginalIds.add(String(t.originalId));
        continue;
      }
      survivingOwner.push(t);
    }

    if (removedTrash > 0) {
      await retryWrite(() => db.writeJSON('trash', survivingTrash), 'trash');
    }
    if (removedOwner > 0) {
      await retryWrite(() => db.writeJSON('owner_trash', survivingOwner), 'owner_trash');
    }

    // Safety: also purge any session whose ID is in purgedOriginalIds
    if (purgedOriginalIds.size > 0) {
      try {
        const allSessions = asArray(await db.readJSON('sessions'));
        const remaining = allSessions.filter(s => {
          if (!s || !s._id) return false;
          const sid = String(s._id);
          return !purgedOriginalIds.has(sid);
        });
        if (remaining.length !== allSessions.length) {
          await retryWrite(() => db.writeJSON('sessions', remaining), 'sessions');
          console.log('[TrashCleanup] Orphan sessions purged:', allSessions.length - remaining.length);
        }
      } catch (e) {
        console.warn('[TrashCleanup] orphan session purge failed:', e.message);
      }
    }

    if (removedTrash > 0 || removedOwner > 0) {
      console.log('[TrashCleanup] Permanent purge:', { removedTrash, removedOwner, purgedOriginalIds: purgedOriginalIds.size });
    }
    return { removedTrash, removedOwner, purgedOriginalIds: purgedOriginalIds.size };
  } catch (err) {
    console.error('[TrashCleanup] error:', err.message);
    return { removedTrash: 0, removedOwner: 0, error: err.message };
  }
}

async function startTrashCleanupScheduler() {
  if (trashCleanupTimer) clearInterval(trashCleanupTimer);
  trashCleanupTimer = setInterval(() => { trashPermanentCleanup().catch(() => {}); }, TRASH_CLEANUP_INTERVAL_MS);
  setTimeout(() => { trashPermanentCleanup().catch(() => {}); }, 10000);
  console.log('[TrashCleanup] Scheduler started — permanent purge after', TRASH_RETENTION_MS / 3600000, 'h (retention).');
}

// ============================================================
// GLOBAL SCHEDULER
// ============================================================

async function globalCleanupCheck() {
  try {
    let state = await getGlobalTimerState();

    if (!state) {
      await initializeGlobalTimer();
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

    const lastResetMs = state.lastResetAt ? new Date(state.lastResetAt).getTime() : 0;
    const lastKey = state.lastResetKey || '';
    if (lastResetMs && lastKey === 'global' && (Date.now() - lastResetMs) < RESET_IDEMPOTENCY_MS) {
      return;
    }

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
    });
  }
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
      if (emptyOfflineSinceMap.has(s._id.toString())) return true;
      const offlineNow = s.isLive === false || s.status === 'Offline';
      if (offlineNow && isEmptySession(s)) return true;
      return false;
    });
  } catch (err) { return []; }
}

// ============================================================
// isSocketAlive
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
// computeStatus
// ============================================================
function computeStatus(session, socketAlive, nowMs) {
  if (!session) return 'Offline';
  if (session.isLive === false) return 'Offline';

  const actRaw = session.lastActivity || session.lastSeenAt || session.timestamp || nowMs;
  const actMs = new Date(actRaw).getTime();
  const actSafe = Number.isFinite(actMs) && actMs > 0 ? actMs : nowMs;

  let refMs = actSafe;
  if (session.lastSubmissionAt) {
    const subMs = new Date(session.lastSubmissionAt).getTime();
    if (Number.isFinite(subMs) && subMs > refMs) refMs = subMs;
  }

  const elapsed = nowMs - refMs;
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

    for (const session of all) {
      if (!session || !session._id) continue;
      if (session.hiddenForAll) continue;
      const sid = String(session._id);
      const socketAlive = isSocketAlive(session.visitorId, session.trackingCode, session.ip);
      const offlineNow = session.isLive === false || session.status === 'Offline';

      const lastActMs = new Date(session.lastActivity || session.timestamp || nowMs).getTime();
      const staleAge = nowMs - lastActMs;

      const tooYoung = isYoungerThan24h(session);
      const shouldForceDelete = socketAlive && staleAge >= STALE_SOCKET_FORCE_DELETE_MS && !tooYoung;

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
          // fall-through
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
        emitSessionDeleted(session);
      } catch (delErr) {
        console.error('[SessionManager] Failed to delete empty offline session:', sid, delErr.message);
      }
    }

    for (const session of all) {
      if (!session._id) continue;
      if (session.hiddenForAll) continue;
      const sid = session._id.toString();
      if (emptyOfflineSinceMap.has(sid)) continue;
      const socketAlive = isSocketAlive(session.visitorId, session.trackingCode, session.ip);
      const newStatus = computeStatus(session, socketAlive, nowMs);
      const prev = previousStatusMap.get(sid);

      if (newStatus === session.status) continue;
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
          offlineSince: newStatus === 'Offline' ? new Date(nowMs).toISOString() : null,
        });
      } catch (err) {}
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
  isSessionForAnyCode,
  findMatchedUser,
  isYoungerThan24h,
  getSessionAgeMs,
  MIN_SESSION_AGE_MS,
  computeStatus,
  ACTIVITY_TIMEOUT_MS,
  TRASH_RETENTION_MS,
};