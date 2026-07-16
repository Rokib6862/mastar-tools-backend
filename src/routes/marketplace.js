// ============================================================
// MEGA TOOLS — MARKETPLACE API ROUTES
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { generateId, toStringId, now } = require('../utils/helpers');

// ============================================================
// GET /api/marketplace/ads — All ads (Public)
// ============================================================
router.get('/ads', async (req, res) => {
  try {
    const ads = await db.ads.read();
    res.json({ success: true, ads });
  } catch (err) {
    console.error('[Marketplace] GET error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch ads' });
  }
});

// ============================================================
// POST /api/marketplace/ads — Create ad (Protected)
// ============================================================
router.post('/ads', authenticate, async (req, res) => {
  try {
    const { title, price, category, description, images, contactMethod, contactId } = req.body;
    
    if (!title || price === undefined) {
      return res.status(400).json({ success: false, message: 'Title and price are required' });
    }

    const ad = {
      _id: generateId('ad'),
      title,
      price: parseFloat(price) || 0,
      category: category || 'other',
      description: description || '',
      images: images || [],
      contactMethod: contactMethod || 'whatsapp',
      contactId: contactId || '',
      userId: toStringId(req.user._id),
      userName: req.user.name || req.user.username || 'Anonymous',
      created_at: now(),
      updated_at: now(),
    };

    const allAds = await db.ads.read();
    allAds.unshift(ad);
    await db.ads.write(allAds);

    res.status(201).json({ success: true, ad });
  } catch (err) {
    console.error('[Marketplace] POST error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create ad' });
  }
});

// ============================================================
// DELETE /api/marketplace/ads/:id — Delete own ad (Protected + Own)
// ============================================================
router.delete('/ads/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const ad = await db.ads.findById(id);
    
    if (!ad) {
      return res.status(404).json({ success: false, message: 'Ad not found' });
    }

    // Ownership check
    if (toStringId(ad.userId) !== toStringId(req.user._id) && req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'You can only delete your own ads' });
    }

    await db.ads.findByIdAndDelete(id);
    res.json({ success: true, message: 'Ad deleted' });
  } catch (err) {
    console.error('[Marketplace] DELETE error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete ad' });
  }
});

// ============================================================
// EXPORT
// ============================================================
module.exports = router;