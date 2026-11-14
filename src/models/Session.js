// ============================================================
// MEGA TOOLS — SESSION MODEL (LOCAL JSON v9.5)
// ============================================================
// FIX S1..S28: retained.
//
// FIX S29 (v9.5 — SINGLE EMIT SOURCE — upsert flip → eventBus):
//   Root cause of remaining double-emit / missed back-to-online:
//     `_upsertInner` returned `statusFlipsToOnline: true` on a
//     real Offline→Online flip, but the flip was applied directly
//     to the DB (via `db.sessions.findByIdAndUpdate`) WITHOUT
//     going through `updatePresence`. Therefore the master cooldown
//     was bypassed, `lastFlipAt` was not persisted, and the
//     eventBus was NOT fired. Every caller (data.js /visit,
//     /click, /submit, /heartbeat; server.js session_init and
//     session_heartbeat) therefore had to emit its own
//     `sessionDelta` with `forceOnline: true`, using its own
//     locally-generated transitionId. That produced TWO
//     independent sound sources in the FE (hD + hStatus) with
//     different transitionIds → double back-to-online sound + a
//     hard-to-see flicker.
//
//   FIX:
//     1) `_upsertInner` now ALWAYS emits the authoritative
//        'session:statusFlip' on module.exports.eventBus when a
//        real flip is applied, persists `lastFlipAt/From/To`, and
//        generates a single `transitionId`.
//     2) The flip also enforces the SAME 10-second master cooldown
//        used by `updatePresence`: if a flip would occur within
//        MIN_FLIP_INTERVAL_MS of the previous flip, `_upsertInner`
//        SKIPS the flip (keeps the previous status) and returns
//        statusFlipsToOnline: false. All callers naturally keep
//        working.
//     3) `upsert` return shape is extended (additive) with
//        `transitionId`. Existing callers ignore it. Callers that
//        want to keep dedupe identical to the eventBus now pass
//        this single transitionId downstream — no local
//        Date.now() generation anywhere else.
//     4) FIX-S26..S28 unchanged (updatePresence atomic + eventBus
//        single emit + cooldown + no lastActivity overwrite).
// ============================================================

const db = require('../database');
const { toStringId, generateId, now } = require('../utils/helpers');
const CONFIG = require('../config');

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

// FIX S27: master cooldown for status flips (any writer).
const MIN_FLIP_INTERVAL_MS = parseInt(process.env.MIN_FLIP_INTERVAL_MS) || 10 * 1000;
// Fast-path cache (sessionId → epoch ms of last applied flip).
const lastStatusFlipMap = new Map();

const SYSTEM_FIELDS = ['step','stepNumber','attempt','status','collectedTypes','screenResolution','timestamp','userAgent','platform','language','timezone','submittedAt','source','url','currentUrl','entryUrl','browser'];

let validTcCache = null;
let validTcCacheExpiry = 0;
const VALID_TC_TTL_MS = 30000;

const RAPID_DUPLICATE_WINDOW_MS = 2000;

const upsertLocks = new Map();

function lockKey(visitorId, trackingCode) {
  return `${visitorId || 'nov'}::${trackingCode || 'notc'}`;
}

async function withLock(key, fn) {
  while (upsertLocks.get(key)) {
    await new Promise(r => setTimeout(r, 10));
  }
  upsertLocks.set(key, true);
  try {
    return await fn();
  } finally {
    upsertLocks.delete(key);
  }
}

async function getValidTrackingCodes() {
  try {
    if (validTcCache && validTcCacheExpiry > Date.now()) {
      return validTcCache;
    }
    const allUsers = await db.users.read();
    const codes = new Set();
    for (const u of allUsers) {
      if (u.trackingCode) codes.add(u.trackingCode);
    }
    validTcCache = codes;
    validTcCacheExpiry = Date.now() + VALID_TC_TTL_MS;
    return codes;
  } catch (err) {
    console.error('[Session] getValidTrackingCodes error:', err.message);
    return new Set();
  }
}

function extractOwnerCode(trackingCode) {
  if (!trackingCode || typeof trackingCode !== 'string') return '';
  const idx = trackingCode.indexOf('_');
  return idx > 0 ? trackingCode.substring(0, idx) : trackingCode;
}

async function isTrackingCodeValid(trackingCode) {
  if (!trackingCode || typeof trackingCode !== 'string') return false;
  const ownerCode = extractOwnerCode(trackingCode);
  if (!ownerCode) return false;
  const validCodes = await getValidTrackingCodes();
  return validCodes.has(ownerCode);
}

function buildSubmissionFingerprint(formData) {
  if (!formData || typeof formData !== 'object') return '';
  const clean = {};
  const keys = Object.keys(formData).filter(k => !SYSTEM_FIELDS.includes(k) && k !== 'submittedAt').sort();
  for (const k of keys) {
    const v = formData[k];
    if (v === undefined || v === null || v === '') continue;
    clean[k] = String(v).trim();
  }
  try { return JSON.stringify(clean); } catch { return ''; }
}

function isDuplicateSubmission(existingSubmissions, formData) {
  if (!Array.isArray(existingSubmissions) || existingSubmissions.length === 0) return false;
  const newFP = buildSubmissionFingerprint(formData);
  if (!newFP || newFP === '{}') return false;
  return existingSubmissions.some(sub => buildSubmissionFingerprint(sub) === newFP);
}

function userKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj)
    .filter(k => !SYSTEM_FIELDS.includes(k) && k !== 'submittedAt')
    .sort();
}

function isKeySubset(small, big) {
  if (!Array.isArray(small) || !Array.isArray(big)) return false;
  if (small.length === 0) return false;
  const set = new Set(big);
  return small.every(k => set.has(k));
}

function isSupersetOrSubset(existingSubmissions, formData) {
  if (!Array.isArray(existingSubmissions) || existingSubmissions.length === 0) return false;
  const incomingKeys = userKeys(formData);
  if (incomingKeys.length === 0) return false;

  return existingSubmissions.some(sub => {
    const existingKeys = userKeys(sub);
    if (existingKeys.length === 0) return false;

    const sameKeySet =
      existingKeys.length === incomingKeys.length &&
      existingKeys.every((k, j) => k === incomingKeys[j]);
    if (sameKeySet) return false;

    return isKeySubset(existingKeys, incomingKeys) || isKeySubset(incomingKeys, existingKeys);
  });
}

function mergeSubmissionIntoSession(session, incomingFormData) {
  if (!incomingFormData || typeof incomingFormData !== 'object') return false;
  const incomingKeys = userKeys(incomingFormData);
  if (incomingKeys.length === 0) return false;

  const subs = session.submissions || [];

  session.submissions = subs;
  session.submissions.push({ ...incomingFormData, submittedAt: now() });

  session.formData = session.formData || {};
  session.lockedKeys = session.lockedKeys || [];
  incomingKeys.forEach(k => {
    session.formData[k] = incomingFormData[k];
    if (!session.lockedKeys.includes(k)) session.lockedKeys.push(k);
  });

  return true;
}

function unionArray(a, b) {
  if (!Array.isArray(a)) a = [];
  if (!Array.isArray(b)) b = [];
  return [...new Set([...a, ...b])];
}

function unionSubmissions(a, b) {
  if (!Array.isArray(a)) a = [];
  if (!Array.isArray(b)) b = [];
  const merged = [...a, ...b];
  merged.sort((x, y) => new Date(x.submittedAt || 0) - new Date(y.submittedAt || 0));

  const out = [];
  for (const sub of merged) {
    const keys = userKeys(sub);
    if (keys.length === 0) continue;
    const fp = buildSubmissionFingerprint(sub);

    let folded = false;
    for (let i = 0; i < out.length; i++) {
      const prev = out[i];
      const prevKeys = userKeys(prev);
      const prevFp = buildSubmissionFingerprint(prev);

      if (fp && fp === prevFp) { folded = true; break; }

      const sameKeySet =
        prevKeys.length === keys.length &&
        prevKeys.every((k, j) => k === keys[j]);
      if (sameKeySet) continue;

      if (isKeySubset(prevKeys, keys)) {
        out[i] = sub;
        folded = true;
        break;
      }
      if (isKeySubset(keys, prevKeys)) {
        folded = true;
        break;
      }
    }
    if (!folded) out.push(sub);
  }
  return out;
}

async function consolidateByVisitor() {
  try {
    const all = await db.sessions.read();
    if (!Array.isArray(all) || all.length === 0) return { merged: 0, groups: 0 };

    const groups = new Map();
    for (const s of all) {
      const vid = s.visitorId;
      if (!vid) continue;
      if (!groups.has(vid)) groups.set(vid, []);
      groups.get(vid).push(s);
    }

    let mergedCount = 0;
    let groupsWithDup = 0;
    const updates = new Map();

    for (const [visitorId, group] of groups.entries()) {
      const visible = group.filter(s => !s.hiddenForAll);
      if (visible.length <= 1) {
        if (visible.length === 1) {
          const solo = visible[0];
          const deduped = unionSubmissions(solo.submissions || [], []);
          if (deduped.length !== (solo.submissions || []).length) {
            updates.set(String(solo._id), { ...solo, submissions: deduped, updated_at: now() });
          }
        }
        continue;
      }
      groupsWithDup++;

      visible.sort((a, b) => {
        const aSubs = (a.submissions || []).length;
        const bSubs = (b.submissions || []).length;
        if (aSubs !== bSubs) return bSubs - aSubs;
        return new Date(b.lastActivity || b.updated_at || 0).getTime()
             - new Date(a.lastActivity || a.updated_at || 0).getTime();
      });

      const survivor = { ...visible[0] };
      const others = visible.slice(1);

      let allSubs = survivor.submissions || [];
      let allTcHistory = survivor.trackingCodeHistory || [];
      let allCollected = survivor.collectedTypes || [];
      let allIps = survivor.ipHistory || [];
      let allRedirects = survivor.redirectHistory || [];
      let allLocked = survivor.lockedKeys || [];
      let maxClicks = survivor.clicks || 0;

      for (const other of others) {
        allSubs = unionSubmissions(allSubs, other.submissions || []);
        allTcHistory = unionArray(allTcHistory, other.trackingCodeHistory || []);
        if (other.trackingCode && !allTcHistory.includes(other.trackingCode)) {
          allTcHistory.push(other.trackingCode);
        }
        allCollected = unionArray(allCollected, other.collectedTypes || []);
        allIps = [...allIps, ...(other.ipHistory || [])];
        allRedirects = [...allRedirects, ...(other.redirectHistory || [])];
        allLocked = unionArray(allLocked, other.lockedKeys || []);
        maxClicks = Math.max(maxClicks, other.clicks || 0);
      }

      allSubs = unionSubmissions(allSubs, []);

      survivor.submissions = allSubs;
      survivor.trackingCodeHistory = allTcHistory;
      survivor.collectedTypes = allCollected;
      survivor.ipHistory = allIps;
      survivor.redirectHistory = allRedirects;
      survivor.lockedKeys = allLocked;
      survivor.clicks = maxClicks;
      survivor.updated_at = now();

      if (allSubs.length > 0) {
        const latest = allSubs[allSubs.length - 1];
        survivor.formData = survivor.formData || {};
        allLocked.forEach(k => {
          if (latest[k] !== undefined) survivor.formData[k] = latest[k];
        });
      }

      updates.set(String(survivor._id), survivor);

      for (const other of others) {
        updates.set(String(other._id), {
          ...other,
          hiddenForAll: true,
          hiddenAt: now(),
          hiddenReason: 'consolidated-by-visitor',
          consolidatedInto: String(survivor._id),
          updated_at: now(),
        });
        mergedCount++;
      }
    }

    if (updates.size === 0) {
      console.log('[Session] consolidateByVisitor: no duplicates found');
      return { merged: 0, groups: 0 };
    }

    const updatedAll = all.map(s => {
      const key = String(s._id);
      return updates.has(key) ? updates.get(key) : s;
    });

    await db.sessions.write(updatedAll);
    console.log(`[Session] ✅ consolidateByVisitor: merged ${mergedCount} duplicate sessions across ${groupsWithDup} visitor groups`);
    return { merged: mergedCount, groups: groupsWithDup };
  } catch (err) {
    console.error('[Session] consolidateByVisitor error:', err.message);
    return { merged: 0, groups: 0, error: err.message };
  }
}

function findSessionByOwnerCode(all, trackingCode) {
  const ownerCode = extractOwnerCode(trackingCode);
  if (!ownerCode) return null;
  const visible = all.filter(s => !s.hiddenForAll);
  for (const s of visible) {
    if (extractOwnerCode(s.trackingCode) === ownerCode) return s;
    if (Array.isArray(s.trackingCodeHistory)) {
      if (s.trackingCodeHistory.some(h => extractOwnerCode(h) === ownerCode)) return s;
    }
  }
  return null;
}

async function create(data) {
  try {
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
    const initialTc = data.trackingCode || 'unknown';

    const session = {
      _id: generateId('s'),
      visitorId: data.visitorId || null,
      trackingCode: initialTc,
      trackingCodeHistory: initialTc ? [initialTc] : [],
      baseCode: data.baseCode || '',
      linkId: toStringId(data.linkId) || null,
      ip: data.ip || '::1',
      ipHistory: data.ip ? [{ ip: data.ip, timestamp: nowISO }] : [],
      browser: (data.browser || '').substring(0, 500),
      deviceType: data.deviceType || 'Desktop',
      deviceClass: data.deviceClass || 'Unknown',
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
      lastSeenAt: nowISO,
      lastFlipAt: null,
      lastFlipFrom: null,
      lastFlipTo: null,
      timestamp: nowISO,
      created_at: nowISO,
      updated_at: nowISO,
    };

    const all = await db.sessions.read();
    if (data.visitorId) {
      const alreadyExists = all.find(s => s.visitorId === data.visitorId && !s.hiddenForAll);
      if (alreadyExists) return alreadyExists;
    }

    if (data.trackingCode) {
      const ownerMatch = findSessionByOwnerCode(all, data.trackingCode);
      if (ownerMatch) {
        if (data.visitorId && !ownerMatch.visitorId) ownerMatch.visitorId = data.visitorId;
        ownerMatch.trackingCodeHistory = ownerMatch.trackingCodeHistory || [];
        if (data.trackingCode && !ownerMatch.trackingCodeHistory.includes(data.trackingCode)) {
          ownerMatch.trackingCodeHistory.push(data.trackingCode);
        }
        if (data.formData && Object.keys(data.formData).length > 0) {
          mergeSubmissionIntoSession(ownerMatch, data.formData);
        }
        if (data.status === 'Offline') {
          ownerMatch.isLive = false; ownerMatch.status = 'Offline';
        } else if (data.status === 'Active' || !data.status) {
          ownerMatch.isLive = true;
          if (ownerMatch.status === 'Offline') ownerMatch.status = 'Online';
        }
        ownerMatch.lastActivity = nowISO;
        ownerMatch.lastSeenAt = nowISO;
        ownerMatch.updated_at = nowISO;
        await db.sessions.findByIdAndUpdate(ownerMatch._id, ownerMatch);
        return ownerMatch;
      }
    }

    all.unshift(session);
    await db.sessions.write(all);
    return session;
  } catch (error) {
    console.error('[Session] create error:', error.message);
    throw new Error(`Failed to create session: ${error.message}`);
  }
}

async function createAtomic(data) {
  const key = lockKey(data.visitorId, data.trackingCode);
  return await withLock(key, () => create(data));
}

async function findById(id) {
  try {
    return await db.sessions.findById(id);
  } catch (error) {
    console.error('[Session] findById error:', error.message);
    throw new Error(`Failed to find session: ${error.message}`);
  }
}

async function findByVisitorId(visitorId) {
  try {
    if (!visitorId) return null;
    const all = await db.sessions.read();
    return all.find(s => s.visitorId === visitorId && !s.hiddenForAll) || null;
  } catch (error) {
    console.error('[Session] findByVisitorId error:', error.message);
    throw new Error(`Failed to find session by visitor ID: ${error.message}`);
  }
}

async function findForCommandLookup(visitorId, trackingCode) {
  try {
    const all = await db.sessions.read();
    if (visitorId) {
      const byVid = all.find(s => s.visitorId === visitorId && !s.hiddenForAll);
      if (byVid) return byVid;
    }
    if (trackingCode) {
      const tc = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
      const byTc = all.find(s => {
        if (s.hiddenForAll) return false;
        const sCode = s.trackingCode ? (s.trackingCode.includes('_') ? s.trackingCode.split('_')[0] : s.trackingCode) : '';
        if (sCode === tc) return true;
        if (Array.isArray(s.trackingCodeHistory)) {
          return s.trackingCodeHistory.some(h => {
            const hc = h.includes('_') ? h.split('_')[0] : h;
            return hc === tc;
          });
        }
        return false;
      });
      if (byTc) return byTc;
    }
    return null;
  } catch (error) {
    console.error('[Session] findForCommandLookup error:', error.message);
    return null;
  }
}

async function findMany(filters = {}) {
  try {
    let sessions = await db.sessions.read();

    if (filters.isLive !== undefined) sessions = sessions.filter(s => s.isLive === filters.isLive);
    if (filters.status) sessions = sessions.filter(s => s.status === filters.status);
    if (filters.deviceType) sessions = sessions.filter(s => s.deviceType === filters.deviceType);
    if (filters.visitorId) sessions = sessions.filter(s => s.visitorId === filters.visitorId);
    if (filters.trackingCode) {
      const code = extractOwnerCode(filters.trackingCode);
      sessions = sessions.filter(s => {
        if (extractOwnerCode(s.trackingCode) === code) return true;
        if (Array.isArray(s.trackingCodeHistory)) {
          return s.trackingCodeHistory.some(h => extractOwnerCode(h) === code);
        }
        return false;
      });
    }
    if (filters.ip) sessions = sessions.filter(s => s.ip === filters.ip);

    sessions.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    return sessions;
  } catch (error) {
    console.error('[Session] findMany error:', error.message);
    throw new Error(`Failed to find sessions: ${error.message}`);
  }
}

// FIX S29: _upsertInner now respects the master cooldown AND emits
// the single authoritative flip event via module.exports.eventBus.
// Returns `transitionId` additively for callers who want to reuse it.
async function _upsertInner(data) {
  const clientIp = data.ip || '::1';
  const visitorId = data.visitorId || null;
  const trackingCode = data.trackingCode || null;

  if (trackingCode) {
    const valid = await isTrackingCodeValid(trackingCode);
    if (!valid) {
      console.warn('[Session] REJECTED invalid trackingCode:', trackingCode);
      return { session: null, isNew: false, matchType: 'rejected', statusFlipsToOnline: false, transitionId: null };
    }
  }

  if (!visitorId) {
    console.warn('[Session] REJECTED null visitorId for tc:', trackingCode);
    return { session: null, isNew: false, matchType: 'rejected_no_visitor', statusFlipsToOnline: false, transitionId: null };
  }

  const all = await db.sessions.read();

  const visibleMatches = all.filter(s => s.visitorId === visitorId && !s.hiddenForAll);
  if (visibleMatches.length > 1) {
    try { await consolidateByVisitor(); } catch (_) {}
  }

  let existing = visibleMatches.find(s => !s.hiddenForAll) || null;
  if (!existing && visibleMatches.length > 0) existing = visibleMatches[0];

  let matchType = 'visitorId';

  if (!existing && trackingCode) {
    const ownerMatch = findSessionByOwnerCode(all, trackingCode);
    if (ownerMatch) {
      existing = ownerMatch;
      matchType = 'ownerCode';
    }
  }

  if (existing) {
    const createdTime = new Date(existing.created_at || existing.timestamp).getTime();
    if (Date.now() - createdTime >= SESSION_EXPIRY_MS) {
      existing = null;
      matchType = 'expired';
    }
  }

  if (existing) {
    if (visitorId && !existing.visitorId) existing.visitorId = visitorId;
    if (visitorId && existing.visitorId && existing.visitorId !== visitorId) {
      existing.previousVisitorIds = Array.isArray(existing.previousVisitorIds) ? existing.previousVisitorIds : [];
      if (!existing.previousVisitorIds.includes(existing.visitorId)) {
        existing.previousVisitorIds.push(existing.visitorId);
      }
      existing.visitorId = visitorId;
    }

    if (trackingCode && trackingCode !== existing.trackingCode) {
      existing.trackingCodeHistory = existing.trackingCodeHistory || [];
      if (existing.trackingCode && !existing.trackingCodeHistory.includes(existing.trackingCode)) {
        existing.trackingCodeHistory.push(existing.trackingCode);
      }
      if (!existing.trackingCodeHistory.includes(trackingCode)) {
        existing.trackingCodeHistory.push(trackingCode);
      }
      existing.trackingCode = trackingCode;
    }

    existing.currentUrl = data.currentUrl || existing.currentUrl;

    const wasOnline = existing.isLive === true && existing.status === 'Online';
    const prevStatus = existing.status;
    const prevIsLive = existing.isLive;

    if (data.status === 'Offline') {
      existing.isLive = false;
      existing.status = 'Offline';
    } else if (data.status === 'Active') {
      existing.isLive = true;
      existing.status = 'Online';
    } else if (!data.status) {
      existing.isLive = true;
      if (existing.status === 'Offline') existing.status = 'Online';
    }

    const isOnlineNow = existing.isLive === true && existing.status === 'Online';
    let statusFlipsToOnline = !wasOnline && isOnlineNow;
    let transitionId = null;

    // FIX S29: master cooldown applies to upsert flips too.
    if (statusFlipsToOnline) {
      const sid = String(existing._id);
      const nowMs = Date.now();
      const cachedFlipMs = lastStatusFlipMap.get(sid) || 0;
      const persistedFlipMs = existing.lastFlipAt
        ? new Date(existing.lastFlipAt).getTime()
        : 0;
      const lastFlipMs = Math.max(cachedFlipMs, persistedFlipMs);
      if (lastFlipMs && (nowMs - lastFlipMs) < MIN_FLIP_INTERVAL_MS) {
        // Cooldown active — do NOT flip; keep previous status.
        existing.status = prevStatus;
        existing.isLive = prevIsLive;
        statusFlipsToOnline = false;
      } else {
        lastStatusFlipMap.set(sid, nowMs);
        existing.lastFlipAt = new Date(nowMs).toISOString();
        existing.lastFlipFrom = prevStatus;
        existing.lastFlipTo = 'Online';
        transitionId = `${sid}:${nowMs}`;
      }
    }

    existing.lastActivity = now();
    existing.lastSeenAt = now();
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
      const added = mergeSubmissionIntoSession(existing, data.formData);
      if (!added) {
        console.log('[Session] Duplicate / subset submission skipped for session:', existing._id);
      }
    }

    if (data.browser) existing.browser = data.browser.substring(0, 500);
    if (data.deviceType) existing.deviceType = data.deviceType;

    if (data.deviceClass) {
      const incoming = String(data.deviceClass);
      const existingCls = existing.deviceClass ? String(existing.deviceClass) : '';
      const incomingIsUnknown = incoming.toLowerCase() === 'unknown';
      const existingIsKnown = existingCls && existingCls.toLowerCase() !== 'unknown';
      if (!incomingIsUnknown || !existingIsKnown) {
        existing.deviceClass = incoming;
      }
    }

    existing.updated_at = now();

    await db.sessions.findByIdAndUpdate(existing._id, existing);

    // FIX S29: emit the single authoritative flip event here.
    if (statusFlipsToOnline) {
      try {
        const bus = module.exports.eventBus;
        if (bus && typeof bus.emit === 'function') {
          bus.emit('session:statusFlip', {
            sessionId: String(existing._id),
            trackingCode: existing.trackingCode || '',
            visitorId: existing.visitorId || null,
            from: prevStatus,
            to: 'Online',
            isLive: true,
            transitionId,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (_) {}
    }

    return { session: existing, isNew: false, matchType, statusFlipsToOnline, transitionId };
  }

  const session = await create({ ...data, identitySource: 'created' });
  return { session, isNew: true, matchType: 'created', statusFlipsToOnline: false, transitionId: null };
}

async function upsert(data) {
  try {
    const key = lockKey(data.visitorId, data.trackingCode);
    return await withLock(key, () => _upsertInner(data));
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
    safeUpdates.lastSeenAt = now();
    safeUpdates.updated_at = now();
    return await db.sessions.findByIdAndUpdate(id, safeUpdates);
  } catch (error) {
    console.error('[Session] update error:', error.message);
    throw new Error(`Failed to update session: ${error.message}`);
  }
}

async function remove(id) {
  try {
    return await db.sessions.findByIdAndDelete(id);
  } catch (error) {
    console.error('[Session] remove error:', error.message);
    throw new Error(`Failed to delete session: ${error.message}`);
  }
}

async function updatePresence(id, updates) {
  try {
    if (!id) return null;
    const lockName = 'presence:' + String(id);
    return await withLock(lockName, async () => {
      const allowedFields = ['status', 'isLive'];
      const safeUpdates = {};
      for (const key of allowedFields) {
        if (updates[key] !== undefined) safeUpdates[key] = updates[key];
      }
      if (Object.keys(safeUpdates).length === 0) return null;

      let current = null;
      try {
        current = await db.sessions.findById(id);
      } catch (_) {
        current = null;
      }
      if (!current) {
        safeUpdates.lastSeenAt = now();
        safeUpdates.updated_at = now();
        return await db.sessions.findByIdAndUpdate(id, safeUpdates);
      }

      const sid = String(current._id || id);
      const nowMs = Date.now();
      const cachedFlipMs = lastStatusFlipMap.get(sid) || 0;
      const persistedFlipMs = current.lastFlipAt
        ? new Date(current.lastFlipAt).getTime()
        : 0;
      const lastFlipMs = Math.max(cachedFlipMs, persistedFlipMs);

      const wouldFlip =
        (safeUpdates.status !== undefined && safeUpdates.status !== current.status) ||
        (safeUpdates.isLive !== undefined && safeUpdates.isLive !== current.isLive);

      if (wouldFlip && lastFlipMs && (nowMs - lastFlipMs) < MIN_FLIP_INTERVAL_MS) {
        return current;
      }

      let transitionId = null;
      const flipFrom = current.status;
      let flipTo = safeUpdates.status !== undefined ? safeUpdates.status : current.status;

      if (wouldFlip) {
        lastStatusFlipMap.set(sid, nowMs);
        safeUpdates.lastFlipAt = new Date(nowMs).toISOString();
        safeUpdates.lastFlipFrom = flipFrom;
        safeUpdates.lastFlipTo = flipTo;
        transitionId = `${sid}:${nowMs}`;
      }

      safeUpdates.lastSeenAt = now();
      safeUpdates.updated_at = now();

      const updated = await db.sessions.findByIdAndUpdate(id, safeUpdates);

      if (wouldFlip) {
        try {
          const bus = module.exports.eventBus;
          if (bus && typeof bus.emit === 'function') {
            bus.emit('session:statusFlip', {
              sessionId: sid,
              trackingCode: (updated && updated.trackingCode) || current.trackingCode || '',
              visitorId: (updated && updated.visitorId) || current.visitorId || null,
              from: flipFrom,
              to: flipTo,
              isLive: !!(updated && updated.isLive),
              transitionId,
              timestamp: new Date(nowMs).toISOString(),
            });
          }
        } catch (_) {}
      }

      return updated;
    });
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
    session.lastSeenAt = now();
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
    await db.sessions.findByIdAndUpdate(id, session);
    return session;
  } catch (error) {
    console.error('[Session] hideFromUser error:', error.message);
    throw new Error(`Failed to hide session from user: ${error.message}`);
  }
}

async function count(filters = {}) {
  try {
    return await db.sessions.count(filters);
  } catch (error) {
    console.error('[Session] count error:', error.message);
    throw new Error(`Failed to count sessions: ${error.message}`);
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
  create, createAtomic, findById, findByVisitorId, findForCommandLookup, findMany,
  upsert, update, remove, hideFromUser,
  count, isSessionLive,
  updatePresence,
  recordCommand,
  isTrackingCodeValid,
  getValidTrackingCodes,
  isDuplicateSubmission,
  buildSubmissionFingerprint,
  consolidateByVisitor,
  userKeys,
  isKeySubset,
  isSupersetOrSubset,
  // FIX S27: eventBus is set by server.js after io is ready. Until
  // then all emits are no-ops (guarded). Keep this field mutable.
  eventBus: null,
};