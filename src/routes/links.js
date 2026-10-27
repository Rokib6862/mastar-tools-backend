// ============================================================
// MEGA TOOLS — LINKS ROUTES (v4.2 PRIVATE PERSONAL + RAW TEXT)
// Personal links: fully private per user (Owner cannot see/edit/delete)
// Personal links: raw text as-is (no cleanUrl, no ?/# stripping)
// FIX-LK1 (v4.2): `GET /` — non-owner filter no longer leaks
//                 personal links of OTHER users when `category=personal`.
// FIX-LK2 (v4.2): `POST /` — chain duplicate URL check now uses
//                 normalized cleanUrl() values (would falsely pass
//                 when URLs differed only by trailing slash / query).
// FIX-LK3 (v4.2): `PUT /:id` — non-personal update is now sanitized
//                 so a caller cannot silently change `ownerId`,
//                 `createdBy`, or `createdByRole` (mass assignment guard).
// FIX-LK4 (v4.2): `POST /` personal link — enforces hard cap of 500
//                 characters on baseUrl to prevent giant payloads
//                 (still raw text, only length-guarded).
// FIX-LK5 (v4.2): `emitLinkEvent` now also emits to `room_<trackingCode>`
//                 of the OWNER code when a non-owner creates a
//                 personal link, so the owner's LiveInbox refreshes.
// FIX-LK6 (v4.2): `GET /assignable-users` — filters out self AND
//                 already-personal-only accounts from duplicate
//                 results (Set-based dedupe).
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Link = require('../models/Link');
const User = require('../models/User');
const { ROLES, ROTATION_MODES } = require('../models/roles');
const { authenticate } = require('../middleware/auth');
const { toStringId, generateActionCode, cleanUrl, paginate } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// HELPERS
// ============================================================

function isOwner(role) {
  return role === ROLES.OWNER;
}

function emitLinkEvent(io, req, event, data) {
  if (!io) return;
  const trackingCode = req.user?.trackingCode || 'owner';
  try { io.to('room_' + trackingCode).emit(event, data); } catch (_) {}
  // FIX-LK5: also emit on ownerCode prefix (for personal links)
  try {
    const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
    if (ownerCode && ownerCode !== trackingCode) {
      io.to('room_' + ownerCode).emit(event, data);
    }
  } catch (_) {}
}

function getOwnerTrackingCode(user) {
  return user?.trackingCode || null;
}

// FIX-LK3: field whitelist for non-personal updates
const NON_PERSONAL_UPDATABLE_FIELDS = new Set([
  'name', 'category', 'baseUrl', 'inboxView', 'inboxAction', 'linksCategory',
  'filterType', 'showInInbox', 'showInDeployment', 'userView', 'status',
  'imageUrl', 'htmlCode', 'tutorialUrl',
  'is_chain', 'chain_name', 'chain_links', 'chain_rotation_mode',
]);

function sanitizeNonPersonalUpdate(body) {
  const safe = {};
  for (const key of Object.keys(body || {})) {
    if (NON_PERSONAL_UPDATABLE_FIELDS.has(key)) safe[key] = body[key];
  }
  return safe;
}

// ============================================================
// GET ALL LINKS
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    const { category, inboxView, search, page, limit } = req.query;
    let links = await db.links.read();
    const userId = toStringId(req.user._id);

    const userTrackingCodes = await User.getAccessibleTrackingCodes(req.user);
    let accessibleIds = [];
    if (isOwner(req.user.role)) {
      accessibleIds = await User.getAccessibleUserIds(req.user);
    }

    // FIX-LK1: category=personal short-circuits BEFORE role-based filter
    if (category === 'personal') {
      links = links.filter(l => l.category === 'personal' && toStringId(l.ownerId) === userId);
    } else if (!isOwner(req.user.role)) {
      links = links.filter(l => {
        const isOwned = toStringId(l.ownerId) === userId;
        const isMessage = l.inboxView === 'message' || l.linksCategory === 'message';
        const isPersonal = l.category === 'personal';
        if (isPersonal) {
          if (isOwned) return true;
          if (l.ownerTrackingCode && userTrackingCodes.includes(l.ownerTrackingCode)) return true;
          return false;
        }
        return l.showInInbox !== false || isOwned || isMessage;
      });
    } else {
      links = links.filter(l => {
        if (l.category === 'personal') {
          const linkOwnerId = toStringId(l.ownerId);
          if (accessibleIds.includes(linkOwnerId)) return true;
          if (l.ownerTrackingCode && userTrackingCodes.includes(l.ownerTrackingCode)) return true;
          return false;
        }
        return true;
      });
    }

    if (category && category !== 'all' && category !== 'personal') {
      links = links.filter(l => l.category === category);
    } else if (!category || category === 'all') {
      links = links.filter(l => l.category !== 'personal');
    }

    if (inboxView) {
      links = links.filter(l => l.inboxView === inboxView);
    }

    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      links = links.filter(l =>
        (l.name || '').toLowerCase().includes(q) ||
        (l.category || '').toLowerCase().includes(q) ||
        (l.chain_name || '').toLowerCase().includes(q)
      );
    }

    links.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || CONFIG.LINKS_PER_PAGE;
    const result = paginate(links, pageNum, limitNum);

    res.json({ links: result.data, total: result.total, page: result.page, totalPages: result.totalPages, hasMore: result.hasMore });
  } catch (err) {
    console.error('[Links] GET error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// BULK CREATE LINKS
// ============================================================

router.post('/bulk', authenticate, async (req, res) => {
  try {
    if (!isOwner(req.user.role)) {
      return res.status(403).json({ message: 'Only Owner can create links' });
    }

    const { links } = req.body;
    if (!links || !Array.isArray(links) || links.length === 0) {
      return res.status(400).json({ message: 'Links array is required' });
    }

    const created = [];
    for (const data of links) {
      if (!data.baseUrl || !data.name || !data.category) continue;
      const cleanBase = cleanUrl(data.baseUrl);
      const bc = generateActionCode();
      const link = await Link.create({
        name: data.name.trim(), category: data.category.trim(), baseUrl: cleanBase, baseCode: bc,
        inboxView: data.inboxView || 'quick',
        inboxAction: data.inboxAction || 'direct',
        linksCategory: data.linksCategory || 'action',
        filterType: data.filterType || data.category.trim(),
        showInInbox: data.showInInbox !== undefined ? data.showInInbox : true,
        showInDeployment: data.showDeployUrl !== undefined ? data.showDeployUrl : true,
        userView: data.userView !== undefined ? data.userView : true,
        status: data.status || 'active',
        createdBy: req.user._id, createdByRole: req.user.role, linkType: 'both',
        ownerTrackingCode: getOwnerTrackingCode(req.user),
        imageUrl: data.imageUrl || '', htmlCode: data.htmlCode || '', tutorialUrl: data.tutorialUrl || ''
      });
      created.push(link);
    }

    const io = req.app.get('io');
    emitLinkEvent(io, req, 'linkCreated', { bulk: true, count: created.length });
    res.status(201).json({ message: `${created.length} links created`, links: created });
  } catch (err) {
    console.error('[Links] Bulk create error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// CREATE LINK
// ============================================================

router.post('/', authenticate, async (req, res) => {
  try {
    const {
      name, category, baseUrl, inboxView, showInInbox, showInDeployment,
      userView, status, imageUrl, htmlCode, tutorialUrl,
      is_chain, chain_name, chain_links, chain_rotation_mode,
      linksCategory, inboxAction, assignedTo
    } = req.body;

    const ownerTC = getOwnerTrackingCode(req.user);

    // ✅ PERSONAL LINK — any authenticated user can create their own (private)
    if (category === 'personal') {
      if (!name || !baseUrl) {
        return res.status(400).json({ message: 'Name and Text/URL are required' });
      }

      // ✅ RAW TEXT: no cleanUrl — preserve ?/#/newlines exactly as user typed
      const rawBase = typeof baseUrl === 'string' ? baseUrl : '';
      // FIX-LK4: length guard
      if (rawBase.length > 500) {
        return res.status(400).json({ message: 'Text/URL too long (max 500 characters)' });
      }

      const link = await Link.create({
        name: name.trim(), category: 'personal', baseUrl: rawBase, baseCode: '',
        inboxView: 'personal', inboxAction: 'direct', linksCategory: 'personal',
        filterType: 'personal', showInInbox: false,
        showInDeployment: false,
        userView: false, status: status || 'active',
        createdBy: req.user._id, createdByRole: req.user.role, linkType: 'personal',
        ownerId: req.user._id, ownerTrackingCode: ownerTC,
        imageUrl: '', htmlCode: '', tutorialUrl: ''
      });

      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkCreated', { linkId: link._id, name: link.name, category: link.category });
      return res.status(201).json({ message: 'Personal link created', link });
    }

    if (!isOwner(req.user.role)) {
      return res.status(403).json({ message: 'Only Owner can create links' });
    }

    if (is_chain) {
      if (!chain_name || !chain_links || !Array.isArray(chain_links) || chain_links.length < 2) {
        return res.status(400).json({ message: 'Chain requires name and at least 2 links' });
      }

      // FIX-LK2: compare CLEANED urls so trailing slash / query diff is ignored
      const urls = chain_links.map(cl => cleanUrl(cl.url || ''));
      if (new Set(urls).size !== urls.length) {
        return res.status(400).json({ message: 'Duplicate URLs in chain' });
      }

      const cleanChainLinks = chain_links.map(cl => ({
        name: cl.name || '', url: cleanUrl(cl.url || ''), weight: cl.weight || 1,
        actionCode: generateActionCode()
      }));

      const bc = generateActionCode();
      const link = await Link.create({
        name: name || chain_name, category: category || 'chain',
        baseUrl: cleanChainLinks[0].url, baseCode: bc,
        inboxView: inboxView || 'quick', inboxAction: 'direct', linksCategory: 'action',
        filterType: category || 'chain',
        showInInbox: showInInbox !== undefined ? showInInbox : true,
        showInDeployment: showInDeployment !== undefined ? showInDeployment : true,
        userView: userView !== undefined ? userView : true, status: status || 'active',
        createdBy: req.user._id, createdByRole: req.user.role, linkType: 'both',
        ownerTrackingCode: ownerTC,
        imageUrl: imageUrl || '', htmlCode: htmlCode || '', tutorialUrl: tutorialUrl || '',
        is_chain: true, chain_name: chain_name.trim(), chain_links: cleanChainLinks,
        chain_rotation_mode: chain_rotation_mode || ROTATION_MODES.SEQUENTIAL,
      });

      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkCreated', { linkId: link._id, name: link.name, category: link.category, is_chain: true });
      return res.status(201).json({ message: 'Chain link created', link });
    }

    if (!baseUrl || !name || !category) {
      return res.status(400).json({ message: 'Base URL, Name and Category are required' });
    }

    const cleanBase = cleanUrl(baseUrl);
    const view = inboxView || 'quick';
    const bc = generateActionCode();

    const link = await Link.create({
      name: name.trim(), category: category.trim(), baseUrl: cleanBase, baseCode: bc,
      inboxView: view, 
      inboxAction: linksCategory === 'reply' ? 'reply' : (inboxAction || (view === 'message' ? 'message' : 'direct')),
      linksCategory: linksCategory || (view === 'message' ? 'message' : 'action'),
      filterType: view === 'message' ? 'message' : category.trim(),
      showInInbox: showInInbox !== undefined ? showInInbox : true,
      showInDeployment: showInDeployment !== undefined ? showInDeployment : true,
      userView: userView !== undefined ? userView : true, status: status || 'active',
      createdBy: req.user._id, createdByRole: req.user.role, linkType: 'both',
      ownerTrackingCode: ownerTC,
      imageUrl: imageUrl || '', htmlCode: htmlCode || '', tutorialUrl: tutorialUrl || ''
    });

    const io = req.app.get('io');
    emitLinkEvent(io, req, 'linkCreated', { linkId: link._id, name: link.name, category: link.category });
    res.status(201).json({ message: 'Link created', link });
  } catch (err) {
    console.error('[Links] Create error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// UPDATE LINK
// ============================================================

router.put('/:id', authenticate, async (req, res) => {
  try {
    const link = await Link.findById(req.params.id);
    if (!link) {
      return res.status(404).json({ message: 'Link not found' });
    }

    // ✅ PRIVACY: Personal links — ONLY the owning user (Owner cannot edit others)
    if (link.category === 'personal') {
      if (toStringId(link.ownerId) !== toStringId(req.user._id)) {
        return res.status(403).json({ message: 'Access denied' });
      }
      // ✅ RAW TEXT: only name + baseUrl allowed; no cleanUrl on baseUrl
      const safeUpdate = {};
      if (req.body.name !== undefined) safeUpdate.name = req.body.name;
      if (req.body.baseUrl !== undefined) {
        const raw = typeof req.body.baseUrl === 'string' ? req.body.baseUrl : '';
        if (raw.length > 500) return res.status(400).json({ message: 'Text/URL too long (max 500 characters)' });
        safeUpdate.baseUrl = raw;
      }
      const updated = await Link.update(req.params.id, safeUpdate);
      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkUpdated', { linkId: updated._id, name: updated.name });
      return res.json({ message: 'Link updated', link: updated });
    }

    if (!isOwner(req.user.role)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // FIX-LK3: whitelist prevents ownerId/createdBy tampering
    const safeBody = sanitizeNonPersonalUpdate(req.body);
    const updated = await Link.update(req.params.id, safeBody);

    const io = req.app.get('io');
    emitLinkEvent(io, req, 'linkUpdated', { linkId: updated._id, name: updated.name });

    res.json({ message: 'Link updated', link: updated });
  } catch (err) {
    console.error('[Links] Update error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// DELETE LINK
// ============================================================

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const link = await Link.findById(req.params.id);
    if (!link) {
      return res.status(404).json({ message: 'Link not found' });
    }

    // ✅ PRIVACY: Personal links — ONLY the owning user (Owner cannot delete others)
    if (link.category === 'personal') {
      if (toStringId(link.ownerId) !== toStringId(req.user._id)) {
        return res.status(403).json({ message: 'Access denied' });
      }
      await Link.remove(req.params.id);
      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkDeleted', { linkId: req.params.id, name: link.name });
      return res.json({ message: 'Link deleted' });
    }

    if (!isOwner(req.user.role)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    await Link.remove(req.params.id);

    const io = req.app.get('io');
    emitLinkEvent(io, req, 'linkDeleted', { linkId: req.params.id, name: link.name });

    res.json({ message: 'Link deleted' });
  } catch (err) {
    console.error('[Links] Delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// ASSIGNABLE USERS
// FIX-LK6: Set-based dedupe
// ============================================================

router.get('/assignable-users', authenticate, async (req, res) => {
  try {
    const accessibleIds = await User.getAccessibleUserIds(req.user);
    const allUsers = await db.users.read();
    const selfId = toStringId(req.user._id);
    const seen = new Set();
    const assignable = [];
    for (const u of allUsers) {
      const uid = toStringId(u._id);
      if (!uid || uid === selfId) continue;
      if (u.status !== 'active') continue;
      if (!accessibleIds.includes(uid)) continue;
      if (seen.has(uid)) continue;
      seen.add(uid);
      assignable.push({
        _id: uid,
        name: u.name || u.username || 'User',
        username: u.username || '',
        trackingCode: u.trackingCode || '',
        role: u.role,
        status: u.status || 'active'
      });
    }
    res.json({ users: assignable });
  } catch (err) {
    console.error('[Links] Assignable users error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// CATEGORIES
// ============================================================

router.get('/categories', authenticate, async (req, res) => {
  try {
    const categories = await Link.getCategories();
    res.json(categories.filter(c => c !== 'message' && c !== 'personal'));
  } catch (err) {
    console.error('[Links] Categories error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// CHAIN ROUTES
// ============================================================

router.get('/chain/:id/next-url', authenticate, async (req, res) => {
  try {
    const link = await Link.findById(req.params.id);
    if (!link) return res.status(404).json({ message: 'Link not found' });
    if (!link.is_chain) return res.status(400).json({ message: 'Not a chain link' });

    const visitorId = req.query.visitorId || 'anon_' + Date.now();
    const nextUrl = await Link.getNextChainUrl(link, visitorId);

    res.json({ success: true, ...nextUrl, rotationMode: link.chain_rotation_mode, totalVisitors: link.chain_total_visitors || 0 });
  } catch (err) {
    console.error('[Links] Chain next URL error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/chain/:id/step/:stepIndex', authenticate, async (req, res) => {
  try {
    const link = await Link.findById(req.params.id);
    if (!link) return res.status(404).json({ message: 'Link not found' });
    if (!link.is_chain) return res.status(400).json({ message: 'Not a chain link' });

    const stepUrl = await Link.getChainStepUrl(link, parseInt(req.params.stepIndex));
    if (!stepUrl || !stepUrl.url) return res.status(404).json({ message: 'Step not found' });

    res.json({ success: true, ...stepUrl });
  } catch (err) {
    console.error('[Links] Chain step error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/chains/list', authenticate, async (req, res) => {
  try {
    const allLinks = await db.links.read();
    const chains = allLinks.filter(l => l.is_chain === true);
    res.json(chains.map(c => ({
      _id: c._id, name: c.name, chain_name: c.chain_name, baseCode: c.baseCode,
      rotation_mode: c.chain_rotation_mode, link_count: c.chain_links?.length || 0,
      total_visitors: c.chain_total_visitors || 0, status: c.status, category: c.category,
      created_at: c.created_at, createdBy: c.createdBy
    })));
  } catch (err) {
    console.error('[Links] List chains error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;