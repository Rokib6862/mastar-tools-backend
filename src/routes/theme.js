// ============================================================
// MEGA TOOLS — THEME ROUTES
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate, isAdmin } = require('../middleware/auth');
const { toStringId } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// CACHE
// ============================================================

let themeCache = null;
let cacheExpiry = 0;

async function getCachedThemes() {
  if (themeCache && cacheExpiry > Date.now()) return themeCache;
  const themes = await db.readJSON('themes');
  themeCache = themes;
  cacheExpiry = Date.now() + CONFIG.CACHE_TTL;
  return themes;
}

function clearCache() {
  themeCache = null;
  cacheExpiry = 0;
}

// ============================================================
// VALIDATION
// ============================================================

function validateTheme(data) {
  const errors = [];
  if (!data.code?.trim()) errors.push('Code is required');
  if (!data.name?.trim()) errors.push('Name is required');
  if (data.code && !/^[a-z0-9_-]+$/.test(data.code)) {
    errors.push('Code must contain only lowercase letters, numbers, underscores, and hyphens');
  }
  return errors;
}

// ============================================================
// GET ALL THEMES
// ============================================================

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    let themes = await getCachedThemes();

    if (search) {
      const q = search.toLowerCase();
      themes = themes.filter(t =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.code || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q)
      );
    }

    themes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const start = (pageNum - 1) * limitNum;
    const total = themes.length;

    res.json({
      themes: themes.slice(start, start + limitNum),
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      hasMore: start + limitNum < total,
    });
  } catch (err) {
    console.error('[Theme] GET error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GET SINGLE THEME
// ============================================================

router.get('/:code', async (req, res) => {
  try {
    const themes = await getCachedThemes();
    const theme = themes.find(t => t.code === req.params.code);
    if (!theme) return res.status(404).json({ message: 'Theme not found' });
    res.json(theme);
  } catch (err) {
    console.error('[Theme] Get single error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// CREATE THEME
// ============================================================

router.post('/', authenticate, isAdmin, async (req, res) => {
  try {
    const { code, name, description, colors, fonts, layout, css } = req.body;
    const errors = validateTheme({ code, name });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    const themes = await db.readJSON('themes');
    if (themes.find(t => t.code === code)) {
      return res.status(400).json({ success: false, message: `Theme '${code}' already exists` });
    }

    const theme = {
      _id: 'th_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      code: code.trim(),
      name: name.trim(),
      description: description || '',
      colors: colors || {},
      fonts: fonts || {},
      layout: layout || {},
      css: css || '',
      isDefault: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      createdBy: toStringId(req.user._id),
      createdByName: req.user.name || req.user.username || 'Admin',
    };

    themes.push(theme);
    await db.writeJSON('themes', themes);
    clearCache();

    const io = req.app.get('io');
    if (io) io.emit('themeCreated', { themeId: theme._id, code: theme.code, name: theme.name });

    res.status(201).json({ success: true, message: 'Theme created', theme });
  } catch (err) {
    console.error('[Theme] Create error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// UPDATE THEME
// ============================================================

router.put('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const themes = await db.readJSON('themes');
    const idx = themes.findIndex(t => t._id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Theme not found' });

    if (themes[idx].isDefault) {
      return res.status(403).json({ success: false, message: 'Default theme cannot be modified' });
    }

    if (req.body.code && req.body.code !== themes[idx].code) {
      if (!/^[a-z0-9_-]+$/.test(req.body.code)) {
        return res.status(400).json({ success: false, message: 'Invalid code format' });
      }
      if (themes.find(t => t.code === req.body.code && t._id !== req.params.id)) {
        return res.status(400).json({ success: false, message: `Theme '${req.body.code}' already exists` });
      }
    }

    const updated = {
      ...themes[idx],
      ...req.body,
      updated_at: new Date().toISOString(),
      updatedBy: toStringId(req.user._id),
      updatedByName: req.user.name || req.user.username || 'Admin',
    };

    themes[idx] = updated;
    await db.writeJSON('themes', themes);
    clearCache();

    const io = req.app.get('io');
    if (io) io.emit('themeUpdated', { themeId: updated._id, code: updated.code, name: updated.name });

    res.json({ success: true, message: 'Theme updated', theme: updated });
  } catch (err) {
    console.error('[Theme] Update error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// DELETE THEME
// ============================================================

router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const themes = await db.readJSON('themes');
    const idx = themes.findIndex(t => t._id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Theme not found' });

    if (themes[idx].isDefault) {
      return res.status(403).json({ success: false, message: 'Default theme cannot be deleted' });
    }

    if (themes.length <= 1) {
      return res.status(400).json({ success: false, message: 'Cannot delete the last theme' });
    }

    const deleted = themes.splice(idx, 1)[0];
    await db.writeJSON('themes', themes);
    clearCache();

    const io = req.app.get('io');
    if (io) io.emit('themeDeleted', { themeId: deleted._id, code: deleted.code, name: deleted.name });

    res.json({ success: true, message: 'Theme deleted', theme: deleted });
  } catch (err) {
    console.error('[Theme] Delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// SET DEFAULT THEME
// ============================================================

router.post('/default/:code', authenticate, isAdmin, async (req, res) => {
  try {
    const themes = await db.readJSON('themes');
    const targetIdx = themes.findIndex(t => t.code === req.params.code);
    if (targetIdx === -1) return res.status(404).json({ success: false, message: 'Theme not found' });

    themes.forEach(t => (t.isDefault = false));
    themes[targetIdx].isDefault = true;
    themes[targetIdx].updated_at = new Date().toISOString();

    await db.writeJSON('themes', themes);
    clearCache();

    const io = req.app.get('io');
    if (io) io.emit('themeDefaultChanged', { code: req.params.code, name: themes[targetIdx].name });

    res.json({ success: true, message: `Default theme set to '${req.params.code}'`, theme: themes[targetIdx] });
  } catch (err) {
    console.error('[Theme] Default error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// THEME STATS
// ============================================================

router.get('/stats', authenticate, async (req, res) => {
  try {
    const themes = await getCachedThemes();
    const defaultTheme = themes.find(t => t.isDefault);

    res.json({
      total: themes.length,
      default: defaultTheme ? { code: defaultTheme.code, name: defaultTheme.name } : null,
      lastUpdated: themes.length > 0
        ? themes.reduce((max, t) => (t.updated_at && t.updated_at > max ? t.updated_at : max), themes[0]?.created_at || '')
        : null,
    });
  } catch (err) {
    console.error('[Theme] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;