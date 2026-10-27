// ============================================================
// MEGA TOOLS — WEBHOOK ROUTES (ENTERPRISE v5.0)
// FIXED: Null session guard (garbage rejection)
// ADMIN_API_TOKEN → OWNER_API_TOKEN (Admin role eliminated)
// ============================================================
// LOGIC: visitorId + trackingCode → Session.upsert() Gatekeeper
// ENTERPRISE: Async upsert after response, Room-based emit only
// ENTERPRISE FIX: Added seq field for client-side dedupe
// FIX-W1 (v5.0): visitorId fallback → ip||trackingCode so external
//                HTML form posts (no JS) never get rejected by FIX-S4.
// FIX-W2 (v5.0): form-submit — emit to BOTH owner room AND exact
//                'room_<full trackingCode>' so multi-code owners see it.
// FIX-W3 (v5.0): /logs — accept OWNER_API_TOKEN from Authorization
//                header OR ?token= query (dev convenience) with trim.
// FIX-W4 (v5.0): click — formData no longer stores raw metadata that
//                may contain unrelated sensitive keys; only whitelisted
//                keys are persisted alongside source.
// FIX-W5 (v5.0): form-submit response now reflects upsert result
//                (was always success), so callers can detect rejection.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const CONFIG = require('../config');

// ============================================================
// RATE LIMITER (In-memory)
// ============================================================

const rateLimiter = {};

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
      const logs = await db.readJSON('webhook_logs');
      logs.push({
        _id: 'wh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type, data: maskSensitiveData(data), ip,
        timestamp: new Date().toISOString(),
      });
      if (logs.length > 5000) logs.splice(0, logs.length - 5000);
      await db.writeJSON('webhook_logs', logs);
    } catch (err) { /* silent */ }
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
// HELPER: Emit to owner room + exact full-code room
// ============================================================

function emitToOwnerRoom(io, trackingCode, event, data) {
  if (!io || !trackingCode) return;
  const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
  try { io.to('room_' + ownerCode).emit(event, data); } catch (_) {}
  // FIX-W2: also emit to exact full-code room
  try { io.to('room_' + trackingCode).emit(event, data); } catch (_) {}
}

// ============================================================
// FIX-W1: resolve visitorId — never null
// ============================================================

function resolveVisitorId(visitorId, clientIp, trackingCode) {
  if (visitorId && String(visitorId).trim()) return String(visitorId).trim();
  if (clientIp && clientIp !== 'unknown' && clientIp !== '::1') return 'ip_' + clientIp;
  if (trackingCode) return 'tc_' + trackingCode;
  return null;
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
        // FIX-W1
        const effectiveVisitorId = resolveVisitorId(visitorId, clientIp, trackingCode);

        // FIX-W4: whitelist stored click formData
        const clickFormData = {
          source: source || 'webhook',
        };
        if (metadata?.browser) clickFormData.browser = metadata.browser;
        if (metadata?.url) clickFormData.url = metadata.url;
        if (metadata?.device) clickFormData.device = metadata.device;

        const result = await Session.upsert({
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
          formData: clickFormData,
        });

        if (!result || !result.session) {
          console.warn('[Webhook] Click rejected invalid trackingCode:', trackingCode);
          return;
        }

        const { session, isNew } = result;
        const io = req.app.get('io');
        if (io) {
          emitToOwnerRoom(io, trackingCode, 'sessionDelta', buildSessionDelta(session, isNew));
        }
      } catch (err) {
        console.error('[Webhook] Click async error:', err.message);
      }
    });
  } catch (err) {
    console.error('[Webhook] Click error:', err);
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

    // FIX-W5: acknowledge immediately, then process async (preserved behavior)
    res.json({ success: true, message: 'Form submitted' });

    if (trackingCode) {
      setImmediate(async () => {
        try {
          // FIX-W1
          const effectiveVisitorId = resolveVisitorId(visitorId, clientIp, trackingCode);

          const result = await Session.upsert({
            visitorId: effectiveVisitorId,
            trackingCode,
            ip: clientIp,
            formData: formData,
            collectedTypes: ['webhook_form_submit'],
            deviceType: 'Desktop',
            browser: 'Unknown',
          });

          if (!result || !result.session) {
            console.warn('[Webhook] Form-submit rejected invalid trackingCode:', trackingCode);
            return;
          }

          const { session, isNew } = result;
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
          console.error('[Webhook] Form submit async error:', err.message);
        }
      });
    }
  } catch (err) {
    console.error('[Webhook] Form submit error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// LOGS (Owner only — via OWNER_API_TOKEN)
// ============================================================

function getOwnerToken(req) {
  // FIX-W3: Authorization header OR ?token= query, both trimmed
  const header = (req.headers.authorization || '').trim();
  const fromHeader = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : header.split(' ').pop().trim();
  if (fromHeader) return fromHeader;
  if (req.query && typeof req.query.token === 'string') return req.query.token.trim();
  return '';
}

router.get('/logs', async (req, res) => {
  try {
    const token = getOwnerToken(req);
    if (!token || token !== CONFIG.OWNER_API_TOKEN) {
      return res.status(403).json({ success: false, message: 'Invalid token' });
    }
    const logs = await db.readJSON('webhook_logs');
    const limit = parseInt(req.query.limit) || 100;
    res.json({ success: true, logs: logs.slice(-limit).reverse() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/logs', async (req, res) => {
  try {
    const token = getOwnerToken(req);
    if (!token || token !== CONFIG.OWNER_API_TOKEN) {
      return res.status(403).json({ success: false, message: 'Invalid token' });
    }
    await db.writeJSON('webhook_logs', []);
    res.json({ success: true, message: 'Logs cleared' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;