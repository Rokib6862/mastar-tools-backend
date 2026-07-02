// ============================================================
// MEGA TOOLS — WEBHOOK ROUTES (CLEAN)
// ============================================================
// LOGIC: visitorId + trackingCode → Session.upsert() Gatekeeper
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
// SAVE LOG
// ============================================================

async function saveLog(type, data, ip) {
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
}

// ============================================================
// CLICK WEBHOOK — visitorId-based via Session.upsert()
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

    await saveLog('click', req.body, clientIp);

    const baseCode = linkId || (trackingCode.includes('_') ? trackingCode.split('_').pop() : trackingCode);
    const entryUrl = metadata?.url || '';
    const deviceType = (metadata?.device || 'desktop') === 'mobile' ? 'Mobile' : 'Desktop';
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
      io.emit('webhookClick', {
        trackingCode, linkId,
        source: source || 'webhook', timestamp: new Date().toISOString(),
      });
    }

    res.json({ success: true, message: 'Click tracked', isNew: isNew || false });
  } catch (err) {
    console.error('[Webhook] Click error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// FORM SUBMIT WEBHOOK — visitorId-based via Session.upsert()
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

    await saveLog('form_submit', req.body, clientIp);

    if (trackingCode) {
      const effectiveVisitorId = visitorId || clientIp || null;

      const { session } = await Session.upsert({
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
        io.emit('formSubmitted', { visitorId: session.visitorId, trackingCode, formData, timestamp: new Date().toISOString(), source: source || 'webhook' });
      }
    }

    res.json({ success: true, message: 'Form submitted' });
  } catch (err) {
    console.error('[Webhook] Form submit error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// LOGS (Admin)
// ============================================================

router.get('/logs', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (token !== CONFIG.ADMIN_API_TOKEN) return res.status(403).json({ success: false, message: 'Invalid token' });
    const logs = await db.readJSON('webhook_logs');
    const limit = parseInt(req.query.limit) || 100;
    res.json({ success: true, logs: logs.slice(-limit).reverse() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/logs', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (token !== CONFIG.ADMIN_API_TOKEN) return res.status(403).json({ success: false, message: 'Invalid token' });
    await db.writeJSON('webhook_logs', []);
    res.json({ success: true, message: 'Logs cleared' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;