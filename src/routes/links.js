// ============================================================
// MEGA TOOLS — LINKS ROUTES (v6.0)
// v6.0: showPathName Boolean explicit + display name fallback
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
  io.to('room_' + trackingCode).emit(event, data);
}

function getOwnerTrackingCode(user) {
  return user?.trackingCode || null;
}

function sanitizePathName(p) {
  if (!p || !p.trim()) return '';
  return p.trim().toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
}

function getDisplayName(pathName, category) {
  const cleanPath = sanitizePathName(pathName);
  if (cleanPath) return cleanPath;
  return sanitizePathName(category) || 'link';
}

// v6.0: Boolean explicit conversion
function toBoolean(val) {
  return val === true || val === 'true' || val === 1 || val === '1';
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

    if (!isOwner(req.user.role)) {
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

    if (category && category !== 'all') {
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
        (l.pathName || '').toLowerCase().includes(q) ||
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
      if (!data.baseUrl || !data.category) continue;
      const cleanBase = cleanUrl(data.baseUrl);
      const pn = sanitizePathName(data.pathName);
      const displayName = getDisplayName(data.pathName, data.category);
      const bc = generateActionCode();
      const link = await Link.create({
        pathName: pn, name: displayName, category: data.category.trim(), baseUrl: cleanBase, baseCode: bc,
        showPathName: toBoolean(data.showPathName),
        inboxView: data.inboxView || 'quick',
        inboxAction: data.inboxAction || 'direct',
        linksCategory: data.linksCategory || 'action',
        filterType: data.filterType || data.category.trim(),
        showInInbox: data.showInInbox !== undefined ? data.showInInbox : true,
        showInDeployment: data.showDeployUrl !== undefined ? data.showDeployUrl : true,
        showDeployUrl: data.showDeployUrl !== undefined ? data.showDeployUrl : true,
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
// CREATE LINK — v6.0 showPathName Boolean explicit
// ============================================================

router.post('/', authenticate, async (req, res) => {
  try {
    const {
      pathName, name, category, baseUrl, inboxView, showInInbox, showInDeployment,
      showDeployUrl,
      userView, status, imageUrl, htmlCode, tutorialUrl,
      is_chain, chain_name, chain_links, chain_rotation_mode,
      linksCategory, inboxAction, assignedTo, showPathName
    } = req.body;

    const ownerTC = getOwnerTrackingCode(req.user);
    const pn = sanitizePathName(pathName);
    const displayName = getDisplayName(pathName, category);
    // v6.0: Boolean explicit
    const showPath = toBoolean(showPathName);

    if (category === 'personal') {
      if (req.user.role !== ROLES.OWNER) {
        return res.status(403).json({ message: 'Only Owner can create personal links' });
      }
      if (!baseUrl) {
        return res.status(400).json({ message: 'Base URL is required' });
      }
      const cleanBase = cleanUrl(baseUrl);
      const bc = generateActionCode();

      let targetUser = req.user;
      if (assignedTo) {
        const allUsers = await db.users.read();
        const found = allUsers.find(u => toStringId(u._id) === toStringId(assignedTo) || u.trackingCode === assignedTo);
        if (found) {
          const accessibleIds = await User.getAccessibleUserIds(req.user);
          if (!accessibleIds.includes(toStringId(found._id))) {
            return res.status(403).json({ message: 'Cannot assign link to this user' });
          }
          targetUser = found;
        }
      }

      const link = await Link.create({
        pathName: pn, name: displayName, category: 'personal', baseUrl: cleanBase, baseCode: bc,
        showPathName: showPath,
        inboxView: 'personal', inboxAction: 'direct', linksCategory: 'personal',
        filterType: 'personal', showInInbox: false,
        showInDeployment: showInDeployment !== undefined ? showInDeployment : true,
        showDeployUrl: showDeployUrl !== undefined ? showDeployUrl : true,
        userView: userView !== undefined ? userView : true, status: status || 'active',
        createdBy: req.user._id, createdByRole: req.user.role, linkType: 'personal',
        ownerId: req.user._id, ownerTrackingCode: targetUser.trackingCode || ownerTC,
        imageUrl: imageUrl || '', htmlCode: htmlCode || '', tutorialUrl: tutorialUrl || ''
      });

      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkCreated', { linkId: link._id, name: link.name, category: link.category });
      emitLinkEvent(io, req, 'menuUpdated', { linkId: link._id });
      return res.status(201).json({ message: 'Personal link created', link });
    }

    if (!isOwner(req.user.role)) {
      return res.status(403).json({ message: 'Only Owner can create links' });
    }

    if (is_chain) {
      if (!chain_name || !chain_links || !Array.isArray(chain_links) || chain_links.length < 2) {
        return res.status(400).json({ message: 'Chain requires name and at least 2 links' });
      }

      const urls = chain_links.map(cl => cl.url);
      if (new Set(urls).size !== urls.length) {
        return res.status(400).json({ message: 'Duplicate URLs in chain' });
      }

      const cleanChainLinks = chain_links.map(cl => ({
        name: cl.name || '', url: cleanUrl(cl.url || ''), weight: cl.weight || 1,
        actionCode: generateActionCode()
      }));

      const bc = generateActionCode();
      const chainPathName = sanitizePathName(pathName);
      const chainDisplayName = getDisplayName(chain_name, 'chain');
      const link = await Link.create({
        pathName: chainPathName, name: chainDisplayName, category: category || 'chain',
        baseUrl: cleanChainLinks[0].url, baseCode: bc,
        showPathName: showPath,
        inboxView: inboxView || 'quick', inboxAction: 'direct', linksCategory: 'action',
        filterType: category || 'chain',
        showInInbox: showInInbox !== undefined ? showInInbox : true,
        showInDeployment: showInDeployment !== undefined ? showInDeployment : true,
        showDeployUrl: showDeployUrl !== undefined ? showDeployUrl : true,
        userView: userView !== undefined ? userView : true, status: status || 'active',
        createdBy: req.user._id, createdByRole: req.user.role, linkType: 'both',
        ownerTrackingCode: ownerTC,
        imageUrl: imageUrl || '', htmlCode: htmlCode || '', tutorialUrl: tutorialUrl || '',
        is_chain: true, chain_name: chain_name.trim(), chain_links: cleanChainLinks,
        chain_rotation_mode: chain_rotation_mode || ROTATION_MODES.SEQUENTIAL,
      });

      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkCreated', { linkId: link._id, name: link.name, category: link.category, is_chain: true });
      emitLinkEvent(io, req, 'menuUpdated', { linkId: link._id });
      return res.status(201).json({ message: 'Chain link created', link });
    }

    if (!baseUrl || !category) {
      return res.status(400).json({ message: 'Base URL and Category are required' });
    }

    const cleanBase = cleanUrl(baseUrl);
    const view = inboxView || 'quick';
    const bc = generateActionCode();

    const link = await Link.create({
      pathName: pn, name: displayName, category: category.trim(), baseUrl: cleanBase, baseCode: bc,
      showPathName: showPath,
      inboxView: view, 
      inboxAction: linksCategory === 'reply' ? 'reply' : (inboxAction || (view === 'message' ? 'message' : 'direct')),
      linksCategory: linksCategory || (view === 'message' ? 'message' : 'action'),
      filterType: view === 'message' ? 'message' : category.trim(),
      showInInbox: showInInbox !== undefined ? showInInbox : true,
      showInDeployment: showInDeployment !== undefined ? showInDeployment : true,
      showDeployUrl: showDeployUrl !== undefined ? showDeployUrl : true,
      userView: userView !== undefined ? userView : true, status: status || 'active',
      createdBy: req.user._id, createdByRole: req.user.role, linkType: 'both',
      ownerTrackingCode: ownerTC,
      imageUrl: imageUrl || '', htmlCode: htmlCode || '', tutorialUrl: tutorialUrl || ''
    });

    const io = req.app.get('io');
    emitLinkEvent(io, req, 'linkCreated', { linkId: link._id, name: link.name, category: link.category });
    emitLinkEvent(io, req, 'menuUpdated', { linkId: link._id });
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

    if (link.category === 'personal') {
      const accessibleIds = await User.getAccessibleUserIds(req.user);
      const isOwnerCheck = toStringId(link.ownerId) === toStringId(req.user._id);
      const isUpper = req.user.role === ROLES.OWNER || 
        (accessibleIds.includes(toStringId(link.ownerId)) && toStringId(link.ownerId) !== toStringId(req.user._id));
      if (!isOwnerCheck && !isUpper) {
        return res.status(403).json({ message: 'Access denied' });
      }
    } else if (!isOwner(req.user.role)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // v6.0: showPathName Boolean explicit in update
    if (req.body.showPathName !== undefined) {
      req.body.showPathName = toBoolean(req.body.showPathName);
    }

    const updated = await Link.update(req.params.id, req.body);
    
    const io = req.app.get('io');
    emitLinkEvent(io, req, 'linkUpdated', { linkId: updated._id, name: updated.name });
    emitLinkEvent(io, req, 'menuUpdated', { linkId: updated._id });

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

    if (link.category === 'personal') {
      const accessibleIds = await User.getAccessibleUserIds(req.user);
      const isOwnerCheck = toStringId(link.ownerId) === toStringId(req.user._id);
      const isUpper = req.user.role === ROLES.OWNER || 
        (accessibleIds.includes(toStringId(link.ownerId)) && toStringId(link.ownerId) !== toStringId(req.user._id) && req.user.role !== ROLES.USER);
      if (!isOwnerCheck && !isUpper) {
        return res.status(403).json({ message: 'Access denied' });
      }
    } else if (!isOwner(req.user.role)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    await Link.remove(req.params.id);
    
    const io = req.app.get('io');
    emitLinkEvent(io, req, 'linkDeleted', { linkId: req.params.id, name: link.name });
    emitLinkEvent(io, req, 'menuUpdated', { linkId: req.params.id });

    res.json({ message: 'Link deleted' });
  } catch (err) {
    console.error('[Links] Delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// ASSIGNABLE USERS
// ============================================================

router.get('/assignable-users', authenticate, async (req, res) => {
  try {
    const accessibleIds = await User.getAccessibleUserIds(req.user);
    const allUsers = await db.users.read();
    const assignable = allUsers
      .filter(u => {
        const uid = toStringId(u._id);
        const selfId = toStringId(req.user._id);
        return uid !== selfId && u.status === 'active' && accessibleIds.includes(uid);
      })
      .map(u => ({
        _id: toStringId(u._id),
        name: u.name || u.username || 'User',
        username: u.username || '',
        trackingCode: u.trackingCode || '',
        role: u.role,
        status: u.status || 'active'
      }));
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