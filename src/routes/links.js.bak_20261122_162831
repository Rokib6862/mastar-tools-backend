// ============================================================
// MEGA TOOLS — LINKS ROUTES (v14.5 — PRIVACY ENDPOINT)
// Personal links: fully private per user
// Custom shortener: shared DB rows (all users see, Owner writes)
// FIX-LK1..LK15 preserved from v5.3
// FIX-CD2 (v11.2 — CUSTOM SHORTENER FIELD PERSISTENCE)
// FIX-CD3 (v11.3 — URL CONSTRUCTION + ORIGINAL URL PERSIST)
// FIX-CD4 (v11.4 — BULK SHORTENER — initial, replaced in v5.6)
// FIX-CD5 (v11.5 — CATEGORY-BASED BULK SHORTENER)
// FIX-CD6 (v14.0 — DOMAIN-SWAP PATH PRESERVE)
// FIX-CD16 (v14.1 — PER-USER TRACKINGCODE PRIORITY)
// FIX-CD19 (v14.2 — CUSTOM SHORTENER SHARED/DB-ONLY):
//   - bulk-shortener POST now writes category='custom_shortener'
//     (was: category='personal') — shared row, all users see.
//   - GET /links?category=custom_shortener returns ALL rows for
//     ALL authenticated roles (role-blind). Owner-only writes via
//     isOwner check on bulk-shortener + PUT/DELETE.
//   - No localStorage. Frontend reads DB directly.
// FIX-PR1 (v14.3 — PUBLIC ROUTES ENDPOINT for deployed ZIPs):
//   - GET /api/links/public-routes/:trackingCode (no auth)
//   - Returns { routes, categories, trackingCode, updatedAt }
//   - Deployed ZIP index.html can runtime-fetch → no re-deploy needed
//   - Public CORS — deployed sites on any host can call it
// FIX-PR2 (v14.4 — CUSTOM_SHORTENER EXCLUDED FROM DEPLOYED ROUTES):
//   - custom_shortener rows are OWNER BOOKMARKS / RECORDS — they
//     describe the DEPLOYED domain, not a route on it. Including
//     them in the routes map caused double-code redirects.
//   - Fixed: `inScope` now returns false for custom_shortener rows.
// FIX-PR3 (v14.5 — DISGUISED ALIAS ENDPOINT FOR PRIVACY):
//   - GET /api/theme/config.json?site=<trackingCode>
//   - Same response as /public-routes/:trackingCode, but the URL
//     looks like a normal theme-config fetch in browser Network tab.
//   - Both endpoints share a single buildPublicRoutes() helper.
//   - Deployed index.html (v5.0+) uses this disguised alias.
// ============================================================

const express = require('express');
const router = express.Router();
const cors = require('cors');
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

// FIX-PR1: permissive public CORS for public-routes + theme config.
const PUBLIC_ROUTES_CORS = cors({
  origin: true,
  credentials: false,
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 300,
});

function isOwner(role) {
  return role === ROLES.OWNER;
}
function isAdminOrOwner(role) {
  return role === ROLES.OWNER || role === ROLES.ADMIN;
}

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

function isMessageLink(l) {
  if (!l) return false;
  return (
    l.inboxView === 'message' ||
    l.linksCategory === 'message' ||
    l.inboxAction === 'message' ||
    l.category === 'message' ||
    l.category === 'message_row'
  );
}

function emitLinkEvent(io, req, event, data) {
  if (!io) return;
  const trackingCode = req.user?.trackingCode || 'owner';
  try { io.to('room_' + trackingCode).emit(event, data); } catch (_) {}
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

function extractHostname(url) {
  try {
    const s = String(url || '').trim();
    if (!s) return '';
    const withProto = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    return new URL(withProto).hostname.toLowerCase() || '';
  } catch { return ''; }
}

function normalizeCustomDomain(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/\/+$/, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  return s.toLowerCase();
}

function extractPath(url) {
  try {
    const s = String(url || '').trim();
    if (!s) return '';
    const withProto = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    const u = new URL(withProto);
    return (u.pathname || '') + (u.search || '') + (u.hash || '');
  } catch { return ''; }
}

function composeDisplayPath(link, ownerTrackingCode) {
  if (!link) return '';
  const callerTC = String(ownerTrackingCode || '').trim();
  const refTC = String(link.ownerTrackingCode || '').trim();
  const tc = callerTC || refTC;
  const bc = String(link.baseCode || link.redirectCode || link.slug || '').trim();
  if (tc && bc) return '/' + tc + '_' + bc;
  if (bc) return '/' + bc;
  if (tc) return '/' + tc;
  const p = extractPath(link.baseUrl);
  return p && p !== '/' ? p : '';
}

function constructShortUrl(customDomain, shortenerCategory, allLinks, referenceUrl, referenceLink, ownerTrackingCode) {
  const domain = normalizeCustomDomain(customDomain);
  if (!domain) return null;
  const base = 'https://' + domain;

  let refLink = referenceLink;
  if (!refLink && referenceUrl) {
    refLink = (allLinks || []).find(l => l && l.baseUrl === referenceUrl);
  }
  if (!refLink && shortenerCategory) {
    const cat = String(shortenerCategory).trim();
    refLink = (allLinks || []).find(l =>
      l &&
      l.category === cat &&
      l.category !== 'personal' &&
      l.category !== 'custom_shortener' &&
      typeof l.baseUrl === 'string' &&
      l.baseUrl.length > 0
    );
  }

  if (!refLink) return base;
  const pathSeg = composeDisplayPath(refLink, ownerTrackingCode);
  if (!pathSeg || pathSeg === '/') return base;
  return base + pathSeg;
}

function isLinkOwnedOrInScope(link, reqUser) {
  if (!link) return { allowed: false, reason: 'not_found' };

  const uid = toStringId(reqUser._id);
  const role = reqUser.role;
  const linkOwnerId = toStringId(link.ownerId);
  const linkCreatedBy = toStringId(link.createdBy);
  const isPersonal = link.category === 'personal';

  if (isPersonal) {
    if (linkOwnerId && linkOwnerId === uid) return { allowed: true };
    if (!linkOwnerId && linkCreatedBy && linkCreatedBy === uid) return { allowed: true };
    return { allowed: false, reason: 'personal_not_owned' };
  }

  if (role === ROLES.OWNER) return { allowed: true };

  if (role === ROLES.ADMIN) {
    if (linkOwnerId && linkOwnerId === uid) return { allowed: true };
    if (!linkOwnerId) {
      if (!linkCreatedBy) return { allowed: true };
      if (linkCreatedBy === uid) return { allowed: true };
      return { allowed: false, reason: 'orphan_created_by_other' };
    }
    return { allowed: false, reason: 'admin_not_owner' };
  }

  return { allowed: false, reason: 'user_forbidden' };
}

const NON_PERSONAL_UPDATABLE_FIELDS = new Set([
  'name', 'category', 'baseUrl', 'inboxView', 'inboxAction', 'linksCategory',
  'filterType', 'showInInbox', 'showInDeployment', 'userView', 'status',
  'showInMessageRow', 'showInSendSection',
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

async function getAdminChildIds(reqUser) {
  if (reqUser.role !== ROLES.ADMIN) return [];
  const allUsers = await db.users.read();
  const reqId = toStringId(reqUser._id);
  return allUsers
    .filter(u => toStringId(u.parentId) === reqId)
    .map(u => toStringId(u._id));
}

// ============================================================
// FIX-PR3: SHARED PUBLIC-ROUTES BUILDER
// Used by both /public-routes/:trackingCode (v14.3) and
// /theme/config.json?site=<tc> (v14.5 — disguised alias).
// ============================================================

async function buildPublicRoutes(req, res, rawCodeInput) {
  const rawCode = decodeURIComponent(String(rawCodeInput || '')).trim();
  if (!rawCode) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({
      trackingCode: '',
      routes: {},
      categories: {},
      count: 0,
      updatedAt: new Date().toISOString(),
    });
  }

  const allLinks = await db.links.read();

  const isExcluded = (l) => {
    if (!l) return true;
    if (l.category === 'personal') return true;
    if (l.category === 'message' || l.category === 'message_row') return true;
    if (l.inboxView === 'message') return true;
    if (l.linksCategory === 'message') return true;
    if (typeof l.baseUrl !== 'string' || !l.baseUrl) return true;
    return false;
  };

  const inScope = allLinks.filter((l) => {
    if (isExcluded(l)) return false;
    // FIX-PR2: custom_shortener rows are OWNER BOOKMARKS, not routes.
    if (l.category === 'custom_shortener') return false;
    const linkTC = String(l.ownerTrackingCode || '').trim();
    if (linkTC === rawCode) return true;
    if (linkTC && rawCode.includes('_')) {
      const base = rawCode.split('_')[0];
      if (linkTC === base) return true;
    }
    return false;
  });

  const routes = {};
  const categories = {};

  const makeEntry = (l) => {
    const base = String(l.baseUrl || '').replace(/\/$/, '');
    let host = '';
    let slug = '';
    try {
      const u = new URL(base);
      host = u.hostname;
      const segs = (u.pathname || '').split('/').filter(Boolean);
      slug = segs.length > 0 ? segs[segs.length - 1] : '';
    } catch { return null; }
    if (!host || !slug) return null;

    const linkTC = String(l.ownerTrackingCode || '').trim();
    const baseCode = String(l.baseCode || l.slug || '').trim();
    const code = linkTC && baseCode ? `${linkTC}_${baseCode}` : (baseCode || linkTC);
    if (!code) return null;

    const categorySlug = String(l.category || l.linksCategory || 'other').trim() || 'other';
    return {
      slug,
      domain: host,
      code,
      category: categorySlug,
      linkId: toStringId(l._id),
      isOwner: linkTC === rawCode,
    };
  };

  for (const l of inScope) {
    const entry = makeEntry(l);
    if (!entry) continue;

    const prev = routes[entry.slug];
    if (!prev || (!prev.isOwner && entry.isOwner)) {
      routes[entry.slug] = {
        domain: entry.domain,
        code: entry.code,
        category: entry.category,
      };
    }

    if (!categories[entry.slug]) categories[entry.slug] = [];
    categories[entry.slug].push({
      domain: entry.domain,
      code: entry.code,
      category: entry.category,
      linkId: entry.linkId,
      isOwner: entry.isOwner,
    });
  }

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Vary', 'Origin');
  return res.json({
    trackingCode: rawCode,
    routes,
    categories,
    count: Object.keys(routes).length,
    updatedAt: new Date().toISOString(),
  });
}

// ============================================================
// FIX-PR1: PUBLIC ROUTES — canonical endpoint
// GET /api/links/public-routes/:trackingCode
// ============================================================

router.options('/public-routes/:trackingCode', PUBLIC_ROUTES_CORS);

router.get('/public-routes/:trackingCode', PUBLIC_ROUTES_CORS, async (req, res) => {
  try {
    await buildPublicRoutes(req, res, req.params.trackingCode);
  } catch (err) {
    console.error('[Links] public-routes error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// FIX-PR3: DISGUISED ALIAS — looks like a theme config fetch
// GET /api/theme/config.json?site=<trackingCode>
// Same response as /public-routes, but the URL appears in browser
// Network tab as a routine theme-config call (privacy).
// ============================================================

router.options('/theme/config.json', PUBLIC_ROUTES_CORS);

router.get('/theme/config.json', PUBLIC_ROUTES_CORS, async (req, res) => {
  try {
    const site = req.query.site || req.query.tc || '';
    await buildPublicRoutes(req, res, site);
  } catch (err) {
    console.error('[Links] theme/config.json error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

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

    if (category === 'custom_shortener') {
      links = links.filter(l => l.category === 'custom_shortener');
    } else if (category === 'personal') {
      links = links.filter(l => l.category === 'personal' && toStringId(l.ownerId) === userId);
    } else if (isOwner(req.user.role)) {
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
      links = links.filter(l => {
        const isOwned = toStringId(l.ownerId) === userId;
        const isMessage = isMessageLink(l);
        const isPersonal = l.category === 'personal';
        const isCustomShortener = l.category === 'custom_shortener';

        if (isPersonal) {
          if (isOwned) return true;
          if (req.user.role === ROLES.ADMIN) {
            const linkOwnerId = toStringId(l.ownerId);
            if (accessibleIds.includes(linkOwnerId)) return true;
          }
          if (l.ownerTrackingCode && userTrackingCodes.includes(l.ownerTrackingCode)) return true;
          return false;
        }

        if (isCustomShortener) return true;

        if (isOwned) return true;
        if (isMessage) return true;
        return toBool(l.showInInbox, true) !== false;
      });
    }

    if (category && category !== 'all' && category !== 'personal' && category !== 'custom_shortener') {
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
        showInInbox: toBool(data.showInInbox, true),
        showInDeployment: toBool(data.showDeployUrl !== undefined ? data.showDeployUrl : data.showInDeployment, true),
        userView: toBool(data.userView, true),
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
// FIX-CD5: GET CATEGORIES WITH AT LEAST ONE NON-PERSONAL LINK
// ============================================================

router.get('/categories-with-links', authenticate, async (req, res) => {
  try {
    const allLinks = await db.links.read();
    const counts = new Map();
    for (const l of allLinks) {
      if (!l) continue;
      if (l.category === 'personal') continue;
      if (l.category === 'custom_shortener') continue;
      if (l.category === 'message' || l.category === 'message_row') continue;
      if (typeof l.baseUrl !== 'string' || !l.baseUrl) continue;
      const cat = String(l.category || '').trim();
      if (!cat) continue;
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    const list = Array.from(counts.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => a.category.localeCompare(b.category));

    res.json({ total: list.length, categories: list });
  } catch (err) {
    console.error('[Links] categories-with-links error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// FIX-CD5: GET LINKS BY CATEGORY (preview for reference)
// ============================================================

router.get('/by-category/:category', authenticate, async (req, res) => {
  try {
    const rawCat = decodeURIComponent(req.params.category || '').trim();
    if (!rawCat) {
      return res.status(400).json({ message: 'Category is required' });
    }

    const allLinks = await db.links.read();
    const refs = allLinks
      .filter(l => l
        && l.category === rawCat
        && l.category !== 'personal'
        && l.category !== 'custom_shortener'
        && typeof l.baseUrl === 'string'
        && l.baseUrl.length > 0
      )
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(l => ({
        _id: toStringId(l._id),
        name: l.name || 'Untitled',
        category: l.category,
        baseUrl: l.baseUrl,
        baseCode: l.baseCode || '',
        trackingCode: l.ownerTrackingCode || '',
        created_at: l.created_at,
      }));

    res.json({
      category: rawCat,
      count: refs.length,
      links: refs,
    });
  } catch (err) {
    console.error('[Links] by-category error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// FIX-CD19: BULK CUSTOM SHORTENER (category='custom_shortener', shared)
// Body: { category: "<existing category>", customDomain: "myshortener.com" }
// Owner-only. Creates SHARED rows visible to all users.
// ============================================================

router.post('/bulk-shortener', authenticate, async (req, res) => {
  try {
    if (!isOwner(req.user.role)) {
      return res.status(403).json({ message: 'Only Owner can create custom short links' });
    }

    const rawCategory = typeof req.body?.category === 'string'
      ? req.body.category.trim()
      : '';
    const rawDomain = typeof req.body?.customDomain === 'string'
      ? req.body.customDomain.trim()
      : '';

    if (!rawCategory) {
      return res.status(400).json({ message: 'Category is required' });
    }
    if (!rawDomain) {
      return res.status(400).json({ message: 'Domain is required' });
    }
    if (rawDomain.length > 253) {
      return res.status(400).json({ message: 'Domain too long (max 253 characters)' });
    }

    const cleanDomain = normalizeCustomDomain(rawDomain);
    if (!cleanDomain) {
      return res.status(400).json({ message: 'Invalid domain' });
    }

    const allLinks = await db.links.read();
    const refs = allLinks.filter(l =>
      l &&
      l.category === rawCategory &&
      l.category !== 'personal' &&
      l.category !== 'custom_shortener' &&
      typeof l.baseUrl === 'string' &&
      l.baseUrl.length > 0
    );

    if (refs.length === 0) {
      return res.status(400).json({
        message: `No links found in category "${rawCategory}".`,
      });
    }

    const created = [];
    const io = req.app.get('io');
    const ownerTC = getOwnerTrackingCode(req.user);

    for (const ref of refs) {
      const pathSeg = composeDisplayPath(ref, ownerTC);
      const constructedUrl = pathSeg && pathSeg !== '/'
        ? `https://${cleanDomain}${pathSeg}`
        : `https://${cleanDomain}`;

      const row = await Link.create({
        name: (ref.name || 'Untitled').trim(),
        category: 'custom_shortener',
        baseUrl: constructedUrl,
        originalUrl: ref.baseUrl,
        baseCode: '',
        inboxView: 'custom_shortener',
        inboxAction: 'direct',
        linksCategory: 'custom_shortener',
        filterType: 'custom_shortener',
        showInInbox: false,
        showInDeployment: false,
        userView: true,
        status: 'active',
        createdBy: req.user._id,
        createdByRole: req.user.role,
        linkType: 'custom_shortener',
        ownerId: req.user._id,
        ownerTrackingCode: ownerTC,
        imageUrl: '',
        htmlCode: '',
        tutorialUrl: '',
        customDomain: cleanDomain,
        shortenerCategory: rawCategory,
      });
      created.push(row);
      try {
        emitLinkEvent(io, req, 'linkCreated', {
          linkId: row._id, name: row.name, category: row.category,
        });
      } catch (_) {}
    }

    res.status(201).json({
      message: `${created.length} short link${created.length === 1 ? '' : 's'} created`,
      count: created.length,
      category: rawCategory,
      domain: cleanDomain,
      links: created,
    });
  } catch (err) {
    console.error('[Links] bulk-shortener error:', err);
    res.status(500).json({ message: 'Server error', detail: err.message });
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
      linksCategory, inboxAction, assignedTo,
      showInMessageRow, showInSendSection,
      customDomain, shortenerCategory
    } = req.body;

    const ownerTC = getOwnerTrackingCode(req.user);

    if (category === 'personal') {
      if (!name || !baseUrl) {
        return res.status(400).json({ message: 'Name and Text/URL are required' });
      }

      const rawBase = typeof baseUrl === 'string' ? baseUrl : '';
      if (rawBase.length > 500) {
        return res.status(400).json({ message: 'Text/URL too long (max 500 characters)' });
      }

      const rawDomain = typeof customDomain === 'string' ? customDomain.trim() : '';
      if (rawDomain && rawDomain.length > 253) {
        return res.status(400).json({ message: 'Domain too long (max 253 characters)' });
      }
      const cleanDomain = normalizeCustomDomain(rawDomain);

      const cleanCategory = typeof shortenerCategory === 'string' && shortenerCategory.trim()
        ? shortenerCategory.trim()
        : null;

      let constructedUrl = null;
      if (cleanDomain) {
        const allLinks = await db.links.read();
        constructedUrl = constructShortUrl(cleanDomain, cleanCategory, allLinks, null, null, ownerTC);
      }

      const link = await Link.create({
        name: name.trim(), category: 'personal',
        baseUrl: constructedUrl || rawBase,
        originalUrl: rawBase,
        baseCode: '',
        inboxView: 'personal', inboxAction: 'direct', linksCategory: 'personal',
        filterType: 'personal', showInInbox: false,
        showInDeployment: false,
        userView: false, status: status || 'active',
        createdBy: req.user._id, createdByRole: req.user.role, linkType: 'personal',
        ownerId: req.user._id, ownerTrackingCode: ownerTC,
        imageUrl: '', htmlCode: '', tutorialUrl: '',
        customDomain: cleanDomain,
        shortenerCategory: cleanCategory
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
        showInInbox: toBool(showInInbox, true),
        showInDeployment: toBool(showInDeployment, true),
        userView: toBool(userView, true), status: status || 'active',
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
      showInInbox: toBool(showInInbox, true),
      showInDeployment: toBool(showInDeployment, true),
      userView: toBool(userView, true), status: status || 'active',
      showInMessageRow: toBool(showInMessageRow, undefined),
      showInSendSection: toBool(showInSendSection, undefined),
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

    if (link.category === 'custom_shortener') {
      if (!isOwner(req.user.role)) {
        return res.status(403).json({ message: 'Only Owner can edit custom short links' });
      }
      const safeUpdate = {};
      if (req.body.name !== undefined) safeUpdate.name = req.body.name;

      let newDomain = null;
      let newCategory = null;
      let anyDriver = false;

      if (req.body.customDomain !== undefined) {
        const d = typeof req.body.customDomain === 'string' ? req.body.customDomain.trim() : '';
        if (d.length > 253) return res.status(400).json({ message: 'Domain too long (max 253 characters)' });
        newDomain = normalizeCustomDomain(d);
        safeUpdate.customDomain = newDomain;
        anyDriver = true;
      }
      if (req.body.shortenerCategory !== undefined) {
        newCategory = req.body.shortenerCategory
          ? String(req.body.shortenerCategory).trim()
          : null;
        safeUpdate.shortenerCategory = newCategory;
        anyDriver = true;
      }

      if (anyDriver) {
        const effectiveDomain   = newDomain   !== null ? newDomain   : normalizeCustomDomain(link.customDomain);
        const effectiveCategory = newCategory !== null ? newCategory : (link.shortenerCategory || null);

        let constructed = null;
        if (effectiveDomain) {
          const allLinks = await db.links.read();
          constructed = constructShortUrl(
            effectiveDomain,
            effectiveCategory,
            allLinks,
            link.originalUrl,
            null,
            getOwnerTrackingCode(req.user)
          );
        }
        if (constructed) safeUpdate.baseUrl = constructed;
      }

      const updated = await Link.update(req.params.id, safeUpdate);
      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkUpdated', { linkId: updated._id, name: updated.name });
      return res.json({ message: 'Short link updated', link: updated });
    }

    if (link.category === 'personal') {
      const check = isLinkOwnedOrInScope(link, req.user);
      if (!check.allowed) {
        return res.status(403).json({ message: 'Access denied', reason: check.reason });
      }
      const safeUpdate = {};
      if (req.body.name !== undefined) safeUpdate.name = req.body.name;

      let newRawBase = null;
      let newDomain   = null;
      let newCategory = null;
      let anyDriver   = false;

      if (req.body.baseUrl !== undefined) {
        const raw = typeof req.body.baseUrl === 'string' ? req.body.baseUrl : '';
        if (raw.length > 500) return res.status(400).json({ message: 'Text/URL too long (max 500 characters)' });
        newRawBase = raw;
        anyDriver = true;
        safeUpdate.originalUrl = raw;
      }
      if (req.body.customDomain !== undefined) {
        const d = typeof req.body.customDomain === 'string' ? req.body.customDomain.trim() : '';
        if (d.length > 253) return res.status(400).json({ message: 'Domain too long (max 253 characters)' });
        newDomain = normalizeCustomDomain(d);
        safeUpdate.customDomain = newDomain;
        anyDriver = true;
      }
      if (req.body.shortenerCategory !== undefined) {
        newCategory = req.body.shortenerCategory
          ? String(req.body.shortenerCategory).trim()
          : null;
        safeUpdate.shortenerCategory = newCategory;
        anyDriver = true;
      }

      if (anyDriver) {
        const effectiveDomain   = newDomain   !== null ? newDomain   : normalizeCustomDomain(link.customDomain);
        const effectiveCategory = newCategory !== null ? newCategory : (link.shortenerCategory || null);
        const effectiveRawBase  = newRawBase  !== null ? newRawBase  : (link.originalUrl || link.baseUrl || '');

        let constructed = null;
        if (effectiveDomain) {
          const allLinks = await db.links.read();
          constructed = constructShortUrl(
            effectiveDomain,
            effectiveCategory,
            allLinks,
            effectiveRawBase,
            null,
            getOwnerTrackingCode(req.user)
          );
        }
        safeUpdate.baseUrl = constructed || effectiveRawBase;
      }

      const updated = await Link.update(req.params.id, safeUpdate);
      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkUpdated', { linkId: updated._id, name: updated.name });
      return res.json({ message: 'Link updated', link: updated });
    }

    const check = isLinkOwnedOrInScope(link, req.user);
    if (!check.allowed) {
      return res.status(403).json({ message: 'Permission denied', reason: check.reason });
    }

    const safeBody = sanitizeNonPersonalUpdate(req.body);
    for (const k of ['showInInbox', 'showInDeployment', 'userView', 'showInMessageRow', 'showInSendSection']) {
      if (safeBody[k] !== undefined) safeBody[k] = toBool(safeBody[k], undefined);
    }
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
// ============================================================

router.delete('/by-domain/:domain', authenticate, async (req, res) => {
  try {
    const rawDomain = decodeURIComponent(req.params.domain || '').trim().toLowerCase();
    if (!rawDomain) {
      return res.status(400).json({ success: false, reason: 'domain_required', message: 'Domain is required' });
    }

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

    await db.links.write(keepLinks);

    try {
      if (typeof Link.clearLinkCache === 'function') Link.clearLinkCache();
    } catch (_) {}

    const io = req.app.get('io');
    try {
      for (const l of toDeleteLinks) {
        emitLinkEvent(io, req, 'linkDeleted', { linkId: toStringId(l._id), name: l.name });
      }
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

    if (link.category === 'custom_shortener') {
      if (!isOwner(req.user.role)) {
        return res.status(403).json({ message: 'Only Owner can delete custom short links' });
      }
      await Link.remove(req.params.id);
      const io = req.app.get('io');
      emitLinkEvent(io, req, 'linkDeleted', { linkId: req.params.id, name: link.name, category: link.category });
      return res.json({ message: 'Short link deleted' });
    }

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
    res.json(categories.filter(c => c !== 'message' && c !== 'personal' && c !== 'custom_shortener'));
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
      total_visitors: c.total_chain_visitors || 0, status: c.status, category: c.category,
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