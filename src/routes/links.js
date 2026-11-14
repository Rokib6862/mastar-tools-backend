// ============================================================
// MEGA TOOLS — LINKS ROUTES (v5.2 — 3-TIER + BULK DELETE)
// Personal links: fully private per user
// FIX-LK1..LK10 preserved from v5.1
// FIX-LK11 (v5.2 — LEGACY NULL-OWNER UNBLOCK):
//   - Links created before the ownerId field existed (legacy
//     migration data) have ownerId = null. Previously this caused
//     EVERY delete to return 403 for admins (ownerId !== uid).
//   - New helper `isLinkOwnedOrInScope()` treats null ownerId as
//     "orphan" and allows both Owner and Admin to delete — but
//     never allows User role.
// FIX-LK12 (v5.2 — BULK DELETE INTEGRITY):
//   - DELETE /by-domain/:domain now returns
//       { success:false, reason, scanned, deleted, forbidden }
//     when 0 links matched, so the client can distinguish
//     "no-op" from "real success" and never silently fail.
// FIX-LK13 (v5.2 — ORPHAN GUARD):
//   - For null-ownerId records, admin must match `createdBy`
//     (when present) — prevents admin-of-other-branch from
//     deleting cross-branch orphans.
// FIX-LK14 (v5.2 — BULK SOCKET EVENT):
//   - Emits `linkDeletedBulk` with { domain, count, ids } after
//     bulk delete so ALL clients purge their caches atomically.
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

// FIX-LK7: owner OR admin (admin has limited scope)
function isOwner(role) {
  return role === ROLES.OWNER;
}
function isAdminOrOwner(role) {
  return role === ROLES.OWNER || role === ROLES.ADMIN;
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

// v5.1 — extract hostname from a URL string (safe)
function extractHostname(url) {
  try {
    const s = String(url || '').trim();
    if (!s) return '';
    const withProto = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    return new URL(withProto).hostname.toLowerCase() || '';
  } catch { return ''; }
}

// FIX-LK11 + FIX-LK13: unified ownership/scope check for delete
// Returns:
//   { allowed: true }                       → caller may proceed
//   { allowed: false, reason: '...' }       → caller should 403
function isLinkOwnedOrInScope(link, reqUser) {
  if (!link) return { allowed: false, reason: 'not_found' };

  const uid = toStringId(reqUser._id);
  const role = reqUser.role;
  const linkOwnerId = toStringId(link.ownerId);
  const linkCreatedBy = toStringId(link.createdBy);
  const isPersonal = link.category === 'personal';

  // ---- PERSONAL: only the owner can touch ----
  if (isPersonal) {
    if (linkOwnerId && linkOwnerId === uid) return { allowed: true };
    if (!linkOwnerId && linkCreatedBy && linkCreatedBy === uid) return { allowed: true };
    return { allowed: false, reason: 'personal_not_owned' };
  }

  // ---- NON-PERSONAL ----
  // Owner: full access
  if (role === ROLES.OWNER) return { allowed: true };

  // Admin: allowed if same owner, OR orphan (ownerId=null) & createdBy matches
  if (role === ROLES.ADMIN) {
    if (linkOwnerId && linkOwnerId === uid) return { allowed: true };
    if (!linkOwnerId) {
      // Orphan legacy link — admin may delete IF createdBy matches or is null
      if (!linkCreatedBy) return { allowed: true };           // fully orphan → admin unblock
      if (linkCreatedBy === uid) return { allowed: true };    // admin's own orphan
      return { allowed: false, reason: 'orphan_created_by_other' };
    }
    return { allowed: false, reason: 'admin_not_owner' };
  }

  // Regular user: forbidden for non-personal
  return { allowed: false, reason: 'user_forbidden' };
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

// FIX-LK9: admin child scope helper
async function getAdminChildIds(reqUser) {
  if (reqUser.role !== ROLES.ADMIN) return [];
  const allUsers = await db.users.read();
  const reqId = toStringId(reqUser._id);
  return allUsers
    .filter(u => toStringId(u.parentId) === reqId)
    .map(u => toStringId(u._id));
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
    } else if (req.user.role === ROLES.ADMIN) {
      const childIds = await getAdminChildIds(req.user);
      accessibleIds = [userId, ...childIds];
    } else {
      accessibleIds = [userId];
    }

    // FIX-LK1: category=personal short-circuits BEFORE role-based filter
    if (category === 'personal') {
      links = links.filter(l => l.category === 'personal' && toStringId(l.ownerId) === userId);
    } else if (isOwner(req.user.role)) {
      // Owner: all non-personal + own personal + child-accessible personal
      links = links.filter(l => {
        if (l.category === 'personal') {
          const linkOwnerId = toStringId(l.ownerId);
          if (accessibleIds.includes(linkOwnerId)) return true;
          if (l.ownerTrackingCode && userTrackingCodes.includes(l.ownerTrackingCode)) return true;
          return false;
        }
        return true;
      });
    } else {
      // Admin or User: non-personal (owned or shared) + own personal + admin's children personal
      links = links.filter(l => {
        const isOwned = toStringId(l.ownerId) === userId;
        const isMessage = l.inboxView === 'message' || l.linksCategory === 'message';
        const isPersonal = l.category === 'personal';

        if (isPersonal) {
          if (isOwned) return true;
          if (req.user.role === ROLES.ADMIN) {
            const linkOwnerId = toStringId(l.ownerId);
            if (accessibleIds.includes(linkOwnerId)) return true;
          }
          if (l.ownerTrackingCode && userTrackingCodes.includes(l.ownerTrackingCode)) return true;
          return false;
        }

        // Non-personal: admin sees own-created; user sees shared (showInInbox) or own
        if (req.user.role === ROLES.ADMIN) {
          if (isOwned) return true;
        }
        return l.showInInbox !== false || isOwned || isMessage;
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
// BULK CREATE LINKS (owner + admin)
// ============================================================

router.post('/bulk', authenticate, async (req, res) => {
  try {
    if (!isAdminOrOwner(req.user.role)) {
      return res.status(403).json({ message: 'Only Owner or Admin can create links' });
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
        ownerId: req.user._id,
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

    // ✅ PERSONAL LINK
    if (category === 'personal') {
      if (!name || !baseUrl) {
        return res.status(400).json({ message: 'Name and Text/URL are required' });
      }

      const rawBase = typeof baseUrl === 'string' ? baseUrl : '';
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

    if (!isAdminOrOwner(req.user.role)) {
      return res.status(403).json({ message: 'Only Owner or Admin can create links' });
    }

    if (is_chain) {
      if (!chain_name || !chain_links || !Array.isArray(chain_links) || chain_links.length < 2) {
        return res.status(400).json({ message: 'Chain requires name and at least 2 links' });
      }

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
        ownerId: req.user._id,
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
      ownerId: req.user._id,
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

    // ✅ PRIVACY: Personal links — ONLY the owning user
    if (link.category === 'personal') {
      const check = isLinkOwnedOrInScope(link, req.user);
      if (!check.allowed) {
        return res.status(403).json({ message: 'Access denied', reason: check.reason });
      }
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

    // FIX-LK7 + FIX-LK11: unified scope check (unblocks null-ownerId orphans)
    const check = isLinkOwnedOrInScope(link, req.user);
    if (!check.allowed) {
      return res.status(403).json({ message: 'Permission denied', reason: check.reason });
    }

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
// BULK DELETE BY DOMAIN (v5.2 — MUST be before /:id)
// Deletes ALL links whose baseUrl hostname === :domain.
// FIX-LK11: uses isLinkOwnedOrInScope → unblocks null-ownerId
// FIX-LK12: returns detailed reason when 0 deleted
// FIX-LK14: emits linkDeletedBulk
// ============================================================

router.delete('/by-domain/:domain', authenticate, async (req, res) => {
  try {
    const rawDomain = decodeURIComponent(req.params.domain || '').trim().toLowerCase();
    if (!rawDomain) {
      return res.status(400).json({ success: false, reason: 'domain_required', message: 'Domain is required' });
    }

    // One read of the entire links collection
    const allLinks = await db.links.read();

    const toDeleteIds = [];
    const toDeleteLinks = [];
    const keepLinks = [];
    let scanned = 0;
    let forbidden = 0;

    for (const l of allLinks) {
      const host = extractHostname(l.baseUrl);
      if (host !== rawDomain) {
        keepLinks.push(l);
        continue;
      }
      scanned++;
      const check = isLinkOwnedOrInScope(l, req.user);
      if (check.allowed) {
        toDeleteIds.push(toStringId(l._id));
        toDeleteLinks.push(l);
      } else {
        forbidden++;
        keepLinks.push(l);
      }
    }

    if (toDeleteIds.length === 0) {
      // FIX-LK12: never pretend success when nothing was deleted
      return res.status(200).json({
        success: false,
        reason: scanned === 0 ? 'no_match' : 'forbidden',
        message: scanned === 0
          ? 'No links match this domain.'
          : 'You do not have permission to delete these links.',
        scanned,
        forbidden,
        deleted: 0,
        ids: [],
      });
    }

    // ONE atomic write
    await db.links.write(keepLinks);

    // Invalidate Link model cache (imported module internal)
    try {
      if (typeof Link.clearLinkCache === 'function') Link.clearLinkCache();
    } catch (_) {}

    // Emit per-link + bulk socket events (best-effort)
    const io = req.app.get('io');
    try {
      for (const l of toDeleteLinks) {
        emitLinkEvent(io, req, 'linkDeleted', { linkId: toStringId(l._id), name: l.name });
      }
      // FIX-LK14: single bulk event for cache-invalidation
      emitLinkEvent(io, req, 'linkDeletedBulk', {
        domain: rawDomain,
        count: toDeleteIds.length,
        ids: toDeleteIds,
        scanned,
        forbidden,
      });
    } catch (_) {}

    res.json({
      success: true,
      deleted: toDeleteIds.length,
      ids: toDeleteIds,
      scanned,
      forbidden,
    });
  } catch (err) {
    console.error('[Links] Bulk delete by-domain error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
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

    // ✅ PRIVACY + FIX-LK11: unified scope check (unblocks null-ownerId)
    const check = isLinkOwnedOrInScope(link, req.user);
    if (!check.allowed) {
      return res.status(403).json({ message: 'Permission denied', reason: check.reason });
    }

    await Link.remove(req.params.id);

    const io = req.app.get('io');
    emitLinkEvent(io, req, 'linkDeleted', { linkId: req.params.id, name: link.name, category: link.category });

    res.json({ message: 'Link deleted' });
  } catch (err) {
    console.error('[Links] Delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// ASSIGNABLE USERS — FIX-LK9: admin sees own children only
// ============================================================

router.get('/assignable-users', authenticate, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const selfId = toStringId(req.user._id);
    const seen = new Set();
    const assignable = [];

    if (req.user.role === ROLES.OWNER) {
      for (const u of allUsers) {
        const uid = toStringId(u._id);
        if (!uid || uid === selfId) continue;
        if (u.status !== 'active') continue;
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
    } else if (req.user.role === ROLES.ADMIN) {
      for (const u of allUsers) {
        const uid = toStringId(u._id);
        if (!uid || uid === selfId) continue;
        if (u.status !== 'active') continue;
        if (toStringId(u.parentId) !== selfId) continue;
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