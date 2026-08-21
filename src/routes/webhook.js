// ============================================================
// MEGA TOOLS — WEBHOOK ROUTES (v3.0 Production Hardened)
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const CONFIG = require('../config');

// ============================================================
// RATE LIMITER (In-memory with cleanup)
// ============================================================

const rateLimiter = {};
const RATE_LIMITER_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 min

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimiter[ip]) {
    rateLimiter[ip] = { count: 1, resetAt: now + 60000 };
    return true;
  }
  const data = rateLimiter[ip];
  if (now > data.resetAt) {
    data.count = 1;
    data.resetAt = now + 60000;
    return true;
  }
  if (data.count >= CONFIG.WEBHOOK_RATE_LIMIT_MAX) return false;
  data.count++;
  return true;
}

function cleanupRateLimiter() {
  const now = Date.now();
  for (const [key, data] of Object.entries(rateLimiter)) {
    if (now > data.resetAt + 60000) delete rateLimiter[key];
  }
}

setInterval(cleanupRateLimiter, RATE_LIMITER_CLEANUP_INTERVAL);

// ============================================================
// SENSITIVE FIELD MASKING
// ============================================================

const SENSITIVE_FIELDS = ['password', 'confirmPassword', 'pass', 'pwd', 'secret', 'token', 'pin', 'cc', 'cvv', 'ssn'];
const MASK_VALUE = '***MASKED***';

function maskSensitiveData(data) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(maskSensitiveData);
  const masked = {};
  for (const key of Object.keys(data)) {
    if (SENSITIVE_FIELDS.some(f => key.toLowerCase().includes(f.toLowerCase()))) {
      masked[key] = MASK_VALUE;
    } else if (typeof data[key] === 'object' && data[key] !== null) {
      masked[key] = maskSensitiveData(data[key]);
    } else {
      masked[key] = data[key];
    }
  }
  return masked;
}

// ============================================================
// SAVE LOG — Fire-and-forget (no blocking I/O)
// ============================================================

async function saveLog(type, data, ip) {
  setImmediate(async () => {
    try {
      const logs = await db.webhook_logs.read();
      logs.push({
        _id: 'wh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type, data: maskSensitiveData(data), ip,
        timestamp: new Date().toISOString(),
      });
      if (logs.length > 5000) logs.splice(0, logs.length - 5000);
      await db.webhook_logs.write(logs);
    } catch (err) {
      if (!CONFIG.IS_PRODUCTION) console.error('[Webhook] saveLog error:', err.message);
    }
  });
}

// ============================================================
// HELPER: Detect device type
// ============================================================

function detectDeviceType(metadata) {
  const device = (metadata?.device || 'desktop').toLowerCase();
  if (device === 'tablet' || device === 'ipad') return 'Tablet';
  if (device === 'mobile' || device === 'phone') return 'Mobile';
  return 'Desktop';
}

// ============================================================
// ENTERPRISE: Event sequence counter for client-side dedupe
// ============================================================

let eventSeq = 0;
function nextSeq() { eventSeq++; return eventSeq; }

// ============================================================
// HELPER: Build sessionDelta payload
// ============================================================

function buildSessionDelta(session, isNew) {
  return {
    type: isNew ? 'new' : 'updated',
    seq: nextSeq(),
    timestamp: new Date().toISOString(),
    session: {
      _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
      isLive: session.isLive, status: session.status || 'Online', lastActivity: session.lastActivity,
      clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType,
      baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl,
      ip: session.ip, browser: session.browser, formData: session.formData,
      redirectHistory: session.redirectHistory || [],
      lockedKeys: session.lockedKeys || [],
    },
  };
}

// ============================================================
// HELPER: Emit to owner room only
// ============================================================

function emitToOwnerRoom(io, trackingCode, event, data) {
  if (!io || !trackingCode) return;
  const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
  io.to('room_' + ownerCode).emit(event, data);
}

// ============================================================
// CLICK WEBHOOK — Async upsert, Room-based emit
// ============================================================

router.post('/click', async (req, res) => {
  const clientIp = req.ip || 'unknown';

  try {
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, message: 'Too many requests.' });
    }

    const { trackingCode, visitorId, linkId, source, metadata } = req.body;
    if (!trackingCode) {
      return res.status(400).json({ success: false, message: 'trackingCode required' });
    }

    saveLog('click', req.body, clientIp);

    res.json({ success: true, message: 'Click tracked' });

    setImmediate(async () => {
      try {
        const baseCode = linkId || (trackingCode.includes('_') ? trackingCode.split('_').pop() : trackingCode);
        const entryUrl = metadata?.url || '';
        const deviceType = detectDeviceType(metadata);
        const effectiveVisitorId = visitorId || clientIp || null;

        const { session, isNew } = await Session.upsert({
          visitorId: effectiveVisitorId,
          trackingCode,
          baseCode,
          linkId,
          ip: clientIp,
          browser: metadata?.browser || 'Unknown',
          deviceType,
          entryUrl,
          currentUrl: entryUrl,
          collectedTypes: ['webhook_click'],
          formData: { source: source || 'webhook', ...(metadata || {}) },
        });

        const io = req.app.get('io');
        if (io) {
          emitToOwnerRoom(io, trackingCode, 'sessionDelta', buildSessionDelta(session, isNew));
        }
      } catch (err) {
        if (!CONFIG.IS_PRODUCTION) console.error('[Webhook] Click async error:', err.message);
      }
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Webhook] Click error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// FORM SUBMIT WEBHOOK — Async upsert, Room-based emit
// ============================================================

router.post('/form-submit', async (req, res) => {
  const clientIp = req.ip || 'unknown';

  try {
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, message: 'Too many requests.' });
    }

    const { trackingCode, visitorId, formData, source } = req.body;
    if (!formData || typeof formData !== 'object') {
      return res.status(400).json({ success: false, message: 'formData required' });
    }

    saveLog('form_submit', req.body, clientIp);

    res.json({ success: true, message: 'Form submitted' });

    if (trackingCode) {
      setImmediate(async () => {
        try {
          const effectiveVisitorId = visitorId || clientIp || null;

          const { session, isNew } = await Session.upsert({
            visitorId: effectiveVisitorId,
            trackingCode,
            ip: clientIp,
            formData: formData,
            collectedTypes: ['webhook_form_submit'],
            deviceType: 'Desktop',
            browser: 'Unknown',
          });

          const io = req.app.get('io');
          if (io) {
            emitToOwnerRoom(io, trackingCode, 'sessionDelta', buildSessionDelta(session, isNew));
            emitToOwnerRoom(io, trackingCode, 'formSubmitted', {
              visitorId: session.visitorId,
              sessionId: session._id,
              trackingCode,
              formData,
              seq: nextSeq(),
              timestamp: new Date().toISOString(),
              source: source || 'webhook',
            });
          }
        } catch (err) {
          if (!CONFIG.IS_PRODUCTION) console.error('[Webhook] Form submit async error:', err.message);
        }
      });
    }
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Webhook] Form submit error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// LOGS (API Token Protected)
// ============================================================

router.get('/logs', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (token !== CONFIG.ADMIN_API_TOKEN) return res.status(403).json({ success: false, message: 'Invalid token' });
    const logs = await db.webhook_logs.read();
    const limit = parseInt(req.query.limit) || 100;
    res.json({ success: true, logs: logs.slice(-limit).reverse() });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Webhook] Logs error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/logs', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (token !== CONFIG.ADMIN_API_TOKEN) return res.status(403).json({ success: false, message: 'Invalid token' });
    await db.webhook_logs.write([]);
    res.json({ success: true, message: 'Logs cleared' });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Webhook] Logs delete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;