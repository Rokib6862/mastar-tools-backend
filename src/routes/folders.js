// ============================================================
// MEGA TOOLS — FOLDERS ROUTES (v1.4 — AUTO-FIX CORRUPT URLS)
// ============================================================
// Endpoints (all authenticated):
//   GET    /api/folders                    — list visible folders
//                                             (+ auto-purge + auto-fix)
//   POST   /api/folders                    — create folder
//   PATCH  /api/folders/:id                — rename folder
//   DELETE /api/folders/:id                — soft-delete ONLY
//   PATCH  /api/folders/:id/suffix/:linkId — set per-link suffix override
//   DELETE /api/folders/:id/suffix/:linkId — clear suffix override
//
// Socket events emitted:
//   folderCreated  { folder }
//   folderUpdated  { folder }
//   folderDeleted  { folderId, name, cascadeDeleted: 0, cascadeIds: [] }
//   folderSuffix   { folderId, linkId, suffix }
//   linkUpdated (via auto-fix, one per fixed link)
//
// v1.2: DELETE no longer cascades to links.
// v1.3: GET runs autoPurgeIfNoLinks() before listing.
//
// v1.4 CHANGE (2026-11-09):
//   FIX-FR7: GET /api/folders now ALSO runs
//            Folder.autoFixCorruptUrls() before listing. That
//            helper is idempotent — after the first successful
//            scan every subsequent call is a no-op (0 writes).
//            This heals existing corrupt baseUrl values
//            (https://hostA/hostB/…, https://https://…)
//            across all links, for all users, automatically.
//   FIX-FR8: POST /api/folders now surfaces the typed error
//            code from Folder.create() (invalid_domain,
//            name_required, owner_required) as a 400 response
//            so the client can show a precise message instead
//            of a generic 500.
//   FIX-FR9: PATCH /api/folders/:id — same error surfacing
//            for invalid_domain on rename.
//   FIX-FR10: response of GET includes autoFixed count for
//            observability.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Folder = require('../models/Folder');
const { authenticate } = require('../middleware/auth');
const { toStringId } = require('../utils/helpers');
const { ROLES } = require('../models/roles');

// ============================================================
// HELPERS
// ============================================================

function emitFolderEvent(io, req, event, data) {
  if (!io) return;
  const tc = req.user?.trackingCode || 'owner';
  const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
  try { io.to('room_' + tc).emit(event, data); } catch (_) {}
  try {
    if (ownerCode && ownerCode !== tc) {
      io.to('room_' + ownerCode).emit(event, data);
    }
  } catch (_) {}
}

function pickFolderDto(f) {
  return {
    _id: f._id,
    name: f.name,
    ownerId: f.ownerId,
    ownerTrackingCode: f.ownerTrackingCode || null,
    createdBy: f.createdBy || null,
    createdByRole: f.createdByRole || null,
    parentId: f.parentId || null,
    overrides: f.overrides || {},
    created_at: f.created_at,
    updated_at: f.updated_at,
    deleted_at: f.deleted_at || null,
  };
}

// FIX-FR8 + FIX-FR9: map Folder.create / Folder.update errors to
// proper HTTP statuses so the client can display a meaningful
// message. Any other error remains a 500.
function httpStatusForError(err) {
  const code = err?.code;
  if (code === 'name_required' || code === 'invalid_domain' || code === 'owner_required') {
    return { status: 400, reason: code, message: err.message };
  }
  return { status: 500, reason: 'server_error', message: 'Server error' };
}

// ============================================================
// GET /api/folders — list + auto-purge + auto-fix
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    // 1) Auto-purge if Ready Kits is empty
    let purged = 0;
    try {
      const result = await Folder.autoPurgeIfNoLinks();
      if (result && typeof result.purged === 'number') {
        purged = result.purged;
      }
      if (purged > 0) {
        const io = req.app.get('io');
        try {
          emitFolderEvent(io, req, 'folderDeleted', {
            folderId: null,
            name: null,
            cascadeDeleted: 0,
            cascadeIds: [],
            autoPurged: true,
            count: purged,
          });
        } catch (_) {}
      }
    } catch (purgeErr) {
      console.warn('[Folders] autoPurge skipped:', purgeErr.message);
    }

    // 2) FIX-FR7: heal any corrupt baseUrl values (idempotent)
    let autoFixed = 0;
    try {
      const fixResult = await Folder.autoFixCorruptUrls();
      if (fixResult && typeof fixResult.fixed === 'number') {
        autoFixed = fixResult.fixed;
      }
      if (autoFixed > 0) {
        const io = req.app.get('io');
        try {
          emitFolderEvent(io, req, 'linkUpdated', {
            bulk: true,
            count: autoFixed,
            autoFixed: true,
          });
        } catch (_) {}
      }
    } catch (fixErr) {
      console.warn('[Folders] autoFix skipped:', fixErr.message);
    }

    // 3) List current user's folders
    const allUsers = await db.users.read();
    const folders = await Folder.findManyForUser(req.user, allUsers);
    folders.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    res.json({
      success: true,
      count: folders.length,
      autoPurged: purged,
      autoFixed,
      folders: folders.map(pickFolderDto),
    });
  } catch (err) {
    console.error('[Folders] GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// POST /api/folders — create folder (validated)
// ============================================================

router.post('/', authenticate, async (req, res) => {
  try {
    const raw = req.body?.name;
    if (!raw || !String(raw).trim()) {
      return res.status(400).json({
        success: false,
        reason: 'name_required',
        message: 'Folder name (hostname) is required.',
      });
    }

    const folder = await Folder.create({
      name: raw,
      ownerId: req.user._id,
      ownerTrackingCode: req.user.trackingCode || null,
      createdBy: req.user._id,
      createdByRole: req.user.role,
      parentId: req.user.parentId || null,
      overrides: {},
    });

    const io = req.app.get('io');
    emitFolderEvent(io, req, 'folderCreated', { folder: pickFolderDto(folder) });

    res.status(201).json({ success: true, folder: pickFolderDto(folder) });
  } catch (err) {
    console.error('[Folders] POST error:', err.message, '| code:', err.code);
    const mapped = httpStatusForError(err);
    res.status(mapped.status).json({
      success: false,
      reason: mapped.reason,
      message: mapped.message,
    });
  }
});

// ============================================================
// PATCH /api/folders/:id — rename
// ============================================================

router.patch('/:id', authenticate, async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder || folder.deleted_at) {
      return res.status(404).json({ success: false, reason: 'not_found', message: 'Folder not found' });
    }

    const scope = Folder.isFolderInScope(folder, req.user);
    if (!scope.allowed) {
      return res.status(403).json({ success: false, reason: scope.reason, message: 'Permission denied' });
    }

    const updated = await Folder.update(req.params.id, {
      name: req.body?.name,
    });

    const io = req.app.get('io');
    emitFolderEvent(io, req, 'folderUpdated', { folder: pickFolderDto(updated) });

    res.json({ success: true, folder: pickFolderDto(updated) });
  } catch (err) {
    console.error('[Folders] PATCH error:', err.message, '| code:', err.code);
    const mapped = httpStatusForError(err);
    res.status(mapped.status).json({
      success: false,
      reason: mapped.reason,
      message: mapped.message,
    });
  }
});

// ============================================================
// DELETE /api/folders/:id — soft-delete only
// ============================================================

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder || folder.deleted_at) {
      return res.status(404).json({ success: false, reason: 'not_found', message: 'Folder not found' });
    }

    const scope = Folder.isFolderInScope(folder, req.user);
    if (!scope.allowed) {
      return res.status(403).json({ success: false, reason: scope.reason, message: 'Permission denied' });
    }

    const deleted = await Folder.softDelete(folder._id);

    const io = req.app.get('io');
    emitFolderEvent(io, req, 'folderDeleted', {
      folderId: toStringId(folder._id),
      name: folder.name,
      cascadeDeleted: 0,
      cascadeIds: [],
    });

    res.json({
      success: true,
      folderId: toStringId(folder._id),
      name: folder.name,
      cascadeDeleted: 0,
      cascadeIds: [],
      folder: pickFolderDto(deleted),
    });
  } catch (err) {
    console.error('[Folders] DELETE error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// PATCH /api/folders/:id/suffix/:linkId — set override
// ============================================================

router.patch('/:id/suffix/:linkId', authenticate, async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder || folder.deleted_at) {
      return res.status(404).json({ success: false, reason: 'not_found', message: 'Folder not found' });
    }

    const scope = Folder.isFolderInScope(folder, req.user);
    if (!scope.allowed) {
      return res.status(403).json({ success: false, reason: scope.reason, message: 'Permission denied' });
    }

    const linkId = req.params.linkId;
    if (!linkId) {
      return res.status(400).json({ success: false, reason: 'link_required', message: 'linkId required' });
    }

    const suffix = typeof req.body?.suffix === 'string' ? req.body.suffix : '';
    const updated = await Folder.setOverride(folder._id, linkId, suffix);

    const io = req.app.get('io');
    emitFolderEvent(io, req, 'folderSuffix', {
      folderId: toStringId(folder._id),
      linkId,
      suffix,
      folder: pickFolderDto(updated),
    });

    res.json({ success: true, folder: pickFolderDto(updated) });
  } catch (err) {
    console.error('[Folders] PATCH suffix error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// DELETE /api/folders/:id/suffix/:linkId — clear override
// ============================================================

router.delete('/:id/suffix/:linkId', authenticate, async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder || folder.deleted_at) {
      return res.status(404).json({ success: false, reason: 'not_found', message: 'Folder not found' });
    }

    const scope = Folder.isFolderInScope(folder, req.user);
    if (!scope.allowed) {
      return res.status(403).json({ success: false, reason: scope.reason, message: 'Permission denied' });
    }

    const linkId = req.params.linkId;
    if (!linkId) {
      return res.status(400).json({ success: false, reason: 'link_required', message: 'linkId required' });
    }

    const updated = await Folder.clearOverride(folder._id, linkId);

    const io = req.app.get('io');
    emitFolderEvent(io, req, 'folderSuffix', {
      folderId: toStringId(folder._id),
      linkId,
      suffix: '',
      folder: pickFolderDto(updated),
    });

    res.json({ success: true, folder: pickFolderDto(updated) });
  } catch (err) {
    console.error('[Folders] DELETE suffix error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;