// ============================================================
// MEGA TOOLS — THEME ROUTES (v3.1 SIMPLIFIED)
// isAdmin → isOwner (Admin role eliminated)
// ENTERPRISE FIX: Global emits → Room-only
// FIX-TH1 (v3.1): paginate now NaN-safe — non-numeric page/limit
//                 falls back to defaults; totalPages >= 1.
// FIX-TH2 (v3.1): `PUT /:id` — update body is whitelisted (code,
//                 name, description, colors, fonts, layout, css)
//                 so isDefault / createdBy / created_at are
//                 immutable via PUT (mass-assignment guard).
// FIX-TH3 (v3.1): `POST /default/:code` — atomic within write, and
//                 only flips boolean flags (already safe) + emits
//                 to the OWNER CODE prefix room (consistent with
//                 other routes).
// FIX-TH4 (v3.1): `GET /stats` lastUpdated computation fixed — uses
//                 `new Date(x).getTime()` comparison, handles
//                 invalid ISO strings.
// FIX-TH5 (v3.1): routes now normalize `req.params.code` and `code`
//                 body field: trim + lowercase before compare.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate, isOwner } = require('../middleware/auth');
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
  themeCache = Array.isArray(themes) ? themes : [];
  cacheExpiry = Date.now() + CONFIG.CACHE_TTL;
  return themeCache;
}

function clearCache() {
  themeCache = null;
  cacheExpiry = 0;
}

// ============================================================
// HELPER: Emit to Owner Room Only
// ============================================================

function emitToOwnerRoom(io, req, event, data) {
  if (!io) return;
  const trackingCode = req.user?.trackingCode || 'owner';
  try { io.to('room_' + trackingCode).emit(event, data); } catch (_) {}
  // FIX-TH3: also emit to prefix owner code
  try {
    const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
    if (ownerCode && ownerCode !== trackingCode) {
      io.to('room_' + ownerCode).emit(event, data);
    }
  } catch (_) {}
}

// ============================================================
// VALIDATION (FIX-TH5: trim + lowercase code)
// ============================================================

function normalizeCode(code) {
  return String(code || '').trim().toLowerCase();
}

function validateTheme(data) {
  const errors = [];
  const code = normalizeCode(data.code);
  const name = String(data.name || '').trim();
  if (!code) errors.push('Code is required');
  if (!name) errors.push('Name is required');
  if (code && !/^[a-z0-9_-]+$/.test(code)) {
    errors.push('Code must contain only lowercase letters, numbers, underscores, and hyphens');
  }
  return errors;
}

// ============================================================
// PAGINATION (FIX-TH1)
// ============================================================

function paginateSafe(themes, pageNum, limitNum) {
  const total = themes.length;
  let page = parseInt(pageNum, 10);
  let limit = parseInt(limitNum, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  const start = (page - 1) * limit;
  return {
    items: themes.slice(start, start + limit),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: start + limit < total,
  };
}

// ============================================================
// GET ALL THEMES
// ============================================================

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    let themes = await getCachedThemes();

    if (search) {
      const q = String(search).toLowerCase();
      themes = themes.filter(t =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.code || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q)
      );
    }

    themes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const result = paginateSafe(themes, page, limit);

    res.json({
      themes: result.items,
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
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
    const code = normalizeCode(req.params.code);
    const themes = await getCachedThemes();
    const theme = themes.find(t => normalizeCode(t.code) === code);
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

router.post('/', authenticate, isOwner, async (req, res) => {
  try {
    const { name, description, colors, fonts, layout, css } = req.body;
    const code = normalizeCode(req.body.code);

    const errors = validateTheme({ code, name });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    const themes = await db.readJSON('themes');
    const list = Array.isArray(themes) ? themes : [];
    if (list.find(t => normalizeCode(t.code) === code)) {
      return res.status(400).json({ success: false, message: `Theme '${code}' already exists` });
    }

    const theme = {
      _id: 'th_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      code,
      name: String(name).trim(),
      description: description || '',
      colors: colors || {},
      fonts: fonts || {},
      layout: layout || {},
      css: css || '',
      isDefault: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      createdBy: toStringId(req.user._id),
      createdByName: req.user.name || req.user.username || 'Owner',
    };

    list.push(theme);
    await db.writeJSON('themes', list);
    clearCache();

    const io = req.app.get('io');
    emitToOwnerRoom(io, req, 'themeCreated', {
      themeId: theme._id,
      code: theme.code,
      name: theme.name
    });

    res.status(201).json({ success: true, message: 'Theme created', theme });
  } catch (err) {
    console.error('[Theme] Create error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// UPDATE THEME (FIX-TH2: whitelist)
// ============================================================

const UPDATABLE_FIELDS = new Set(['code', 'name', 'description', 'colors', 'fonts', 'layout', 'css']);

router.put('/:id', authenticate, isOwner, async (req, res) => {
  try {
    const themes = await db.readJSON('themes');
    const list = Array.isArray(themes) ? themes : [];
    const idx = list.findIndex(t => t._id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Theme not found' });

    if (list[idx].isDefault) {
      return res.status(403).json({ success: false, message: 'Default theme cannot be modified' });
    }

    // FIX-TH2: whitelist update body
    const patch = {};
    for (const k of Object.keys(req.body || {})) {
      if (UPDATABLE_FIELDS.has(k)) patch[k] = req.body[k];
    }

    if (patch.code !== undefined) {
      const newCode = normalizeCode(patch.code);
      if (!/^[a-z0-9_-]+$/.test(newCode)) {
        return res.status(400).json({ success: false, message: 'Invalid code format' });
      }
      if (list.find(t => normalizeCode(t.code) === newCode && t._id !== req.params.id)) {
        return res.status(400).json({ success: false, message: `Theme '${newCode}' already exists` });
      }
      patch.code = newCode;
    }

    const updated = {
      ...list[idx],
      ...patch,
      updated_at: new Date().toISOString(),
      updatedBy: toStringId(req.user._id),
      updatedByName: req.user.name || req.user.username || 'Owner',
    };

    list[idx] = updated;
    await db.writeJSON('themes', list);
    clearCache();

    const io = req.app.get('io');
    emitToOwnerRoom(io, req, 'themeUpdated', {
      themeId: updated._id,
      code: updated.code,
      name: updated.name
    });

    res.json({ success: true, message: 'Theme updated', theme: updated });
  } catch (err) {
    console.error('[Theme] Update error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// DELETE THEME
// ============================================================

router.delete('/:id', authenticate, isOwner, async (req, res) => {
  try {
    const themes = await db.readJSON('themes');
    const list = Array.isArray(themes) ? themes : [];
    const idx = list.findIndex(t => t._id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Theme not found' });

    if (list[idx].isDefault) {
      return res.status(403).json({ success: false, message: 'Default theme cannot be deleted' });
    }

    if (list.length <= 1) {
      return res.status(400).json({ success: false, message: 'Cannot delete the last theme' });
    }

    const deleted = list.splice(idx, 1)[0];
    await db.writeJSON('themes', list);
    clearCache();

    const io = req.app.get('io');
    emitToOwnerRoom(io, req, 'themeDeleted', {
      themeId: deleted._id,
      code: deleted.code,
      name: deleted.name
    });

    res.json({ success: true, message: 'Theme deleted', theme: deleted });
  } catch (err) {
    console.error('[Theme] Delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// SET DEFAULT THEME
// ============================================================

router.post('/default/:code', authenticate, isOwner, async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    const themes = await db.readJSON('themes');
    const list = Array.isArray(themes) ? themes : [];
    const targetIdx = list.findIndex(t => normalizeCode(t.code) === code);
    if (targetIdx === -1) return res.status(404).json({ success: false, message: 'Theme not found' });

    list.forEach(t => (t.isDefault = false));
    list[targetIdx].isDefault = true;
    list[targetIdx].updated_at = new Date().toISOString();

    await db.writeJSON('themes', list);
    clearCache();

    const io = req.app.get('io');
    emitToOwnerRoom(io, req, 'themeDefaultChanged', {
      code,
      name: list[targetIdx].name
    });

    res.json({ success: true, message: `Default theme set to '${code}'`, theme: list[targetIdx] });
  } catch (err) {
    console.error('[Theme] Default error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// THEME STATS (FIX-TH4)
// ============================================================

router.get('/stats', authenticate, async (req, res) => {
  try {
    const themes = await getCachedThemes();
    const defaultTheme = themes.find(t => t.isDefault);

    let lastUpdated = null;
    for (const t of themes) {
      const candidates = [t.updated_at, t.created_at].filter(Boolean);
      for (const c of candidates) {
        const ts = new Date(c).getTime();
        if (!Number.isFinite(ts)) continue;
        if (lastUpdated === null || ts > new Date(lastUpdated).getTime()) {
          lastUpdated = c;
        }
      }
    }

    res.json({
      total: themes.length,
      default: defaultTheme ? { code: defaultTheme.code, name: defaultTheme.name } : null,
      lastUpdated,
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