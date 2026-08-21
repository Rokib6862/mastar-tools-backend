// ============================================================
// MEGA TOOLS — TRUST ROUTES (v4.0 Production Hardened)
// Owner Trust + User Trust — Complete Isolation
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { ROLES } = require('../models/roles');
const { authenticate } = require('../middleware/auth');
const { toStringId } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// OWNER TRUST
// ============================================================

// GET — Owner Trust List (Owner Only)
router.get('/owner', authenticate, async (req, res) => {
  try {
    if (req.user.role !== ROLES.OWNER) return res.status(403).json({ success: false, message: 'Owner only' });
    const allTrust = await db.owner_trust.read();
    res.json({ success: true, trust: allTrust });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Trust] Owner GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE — Owner Trust Delete Single (Owner Only)
router.delete('/owner/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== ROLES.OWNER) return res.status(403).json({ success: false, message: 'Owner only' });
    const { id } = req.params;
    const allTrust = await db.owner_trust.read();
    const filtered = allTrust.filter(t => t._id !== id);
    await db.owner_trust.write(filtered);
    res.json({ success: true, message: 'Deleted from owner trust' });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Trust] Owner DELETE error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST — Owner Trust Clear All (Owner Only)
router.post('/owner/clear-all', authenticate, async (req, res) => {
  try {
    if (req.user.role !== ROLES.OWNER) return res.status(403).json({ success: false, message: 'Owner only' });
    const allTrust = await db.owner_trust.read();
    const deletedCount = allTrust.length;
    await db.owner_trust.write([]);
    res.json({ success: true, message: 'Owner Trust archive cleared', deletedCount });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Trust] Owner clear-all error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// USER TRUST
// ============================================================

// GET — User Trust List (Own data only)
router.get('/user', authenticate, async (req, res) => {
  try {
    const userId = toStringId(req.user._id);
    const allTrust = await db.user_trust.read();
    const userTrust = allTrust.filter(t =>
      toStringId(t.ownerId) === userId ||
      toStringId(t.userId) === userId ||
      toStringId(t.deletedBy) === userId
    );
    res.json({ success: true, trust: userTrust });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Trust] User GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE — User Trust Delete Single (Own data only)
router.delete('/user/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = toStringId(req.user._id);
    const allTrust = await db.user_trust.read();
    const filtered = allTrust.filter(t =>
      !(t._id === id && (
        toStringId(t.ownerId) === userId ||
        toStringId(t.userId) === userId ||
        toStringId(t.deletedBy) === userId
      ))
    );
    await db.user_trust.write(filtered);
    res.json({ success: true, message: 'Deleted from user trust' });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Trust] User DELETE error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST — User Trust Clear All (Own data only)
router.post('/user/clear-all', authenticate, async (req, res) => {
  try {
    const userId = toStringId(req.user._id);
    const allTrust = await db.user_trust.read();
    const remaining = allTrust.filter(t =>
      !(toStringId(t.ownerId) === userId ||
        toStringId(t.userId) === userId ||
        toStringId(t.deletedBy) === userId)
    );
    const deletedCount = allTrust.length - remaining.length;
    await db.user_trust.write(remaining);
    res.json({ success: true, message: 'User Trust archive cleared', deletedCount });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Trust] User clear-all error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;