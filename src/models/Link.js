// ============================================================
// MEGA TOOLS — LINK MODEL (v3.1)
// ENTERPRISE FIX: pathName field + N+1 Query optimization
// ============================================================

const db = require('../database');
const { ROTATION_MODES } = require('./roles');
const {
  toStringId,
  generateId,
  generateActionCode,
  cleanUrl,
  now,
} = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// CACHE (for frequently accessed links)
// ============================================================

let linkCache = null;
let linkCacheExpiry = 0;
const CACHE_TTL = 60000; // 60 seconds

async function getCachedLinks(forceRefresh = false) {
  if (forceRefresh || !linkCache || linkCacheExpiry < Date.now()) {
    linkCache = await db.links.read();
    linkCacheExpiry = Date.now() + CACHE_TTL;
  }
  return linkCache;
}

function clearLinkCache() {
  linkCache = null;
  linkCacheExpiry = 0;
}

// ============================================================
// CREATE
// ============================================================

async function create(data) {
  try {
    const nowISO = now();
    const code = data.baseCode || data.redirectCode || generateActionCode();
    
    // ✅ v3.1: pathName — Display Name + URL Folder (একই)
    const rawPathName = (data.pathName || data.name || '').trim().toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
    const finalBaseUrl = cleanUrl(data.baseUrl) || '';

    const link = {
      _id: generateId('l'),
      name: rawPathName || 'untitled',
      pathName: rawPathName || 'untitled',
      category: data.category || 'general',
      baseUrl: finalBaseUrl,
      baseCode: code,
      redirectCode: code,
      slug: code,
      slug_history: [],
      status: data.status || 'active',
      inboxView: data.inboxView || 'quick',
      inboxAction: data.inboxAction || 'direct',
      linksCategory: data.linksCategory || 'action',
      filterType: data.filterType || data.category || 'general',
      linkType: data.linkType || 'both',
      steps: data.steps || 1,
      imageUrl: data.imageUrl || '',
      htmlCode: data.htmlCode || '',
      tutorialUrl: data.tutorialUrl || '',
      showInInbox: data.showInInbox !== undefined ? data.showInInbox : true,
      showInDeployment: data.showInDeployment !== undefined ? data.showInDeployment : true,
      showDeployUrl: data.showDeployUrl !== undefined ? data.showDeployUrl : true,
      userView: data.userView !== undefined ? data.userView : true,
      ownerId: toStringId(data.ownerId) || null,
      ownerTrackingCode: data.ownerTrackingCode || null,
      createdBy: toStringId(data.createdBy) || null,
      createdByRole: data.createdByRole || null,
      total_clicks: 0,

      // Chain fields
      is_chain: data.is_chain || false,
      chain_name: data.chain_name || null,
      chain_links: data.chain_links || [],
      chain_rotation_mode: data.chain_rotation_mode || ROTATION_MODES.SEQUENTIAL,
      chain_current_index: 0,
      chain_visitor_map: {},
      chain_total_visitors: 0,

      // Shield
      shield_enabled: data.shield_enabled || false,
      shield_duration: data.shield_duration || 2,
      shield_type: data.shield_type || 'loading',

      created_at: nowISO,
      updated_at: nowISO,
    };

    const allLinks = await db.links.read();
    allLinks.push(link);
    await db.links.write(allLinks);
    clearLinkCache();
    return link;
  } catch (error) {
    console.error('[Link] create error:', error.message);
    throw new Error(`Failed to create link: ${error.message}`);
  }
}

// ============================================================
// FIND
// ============================================================

async function findById(id) {
  try {
    return await db.links.findById(id);
  } catch (error) {
    console.error('[Link] findById error:', error.message);
    throw new Error(`Failed to find link: ${error.message}`);
  }
}

async function findOne(filter = {}) {
  try {
    const all = await getCachedLinks();
    return all.find(l => Object.keys(filter).every(k => l[k] === filter[k])) || null;
  } catch (error) {
    console.error('[Link] findOne error:', error.message);
    throw new Error(`Failed to find link: ${error.message}`);
  }
}

async function findBySlug(slug) {
  try {
    if (!slug) return null;
    const all = await getCachedLinks();
    return all.find(l => l.baseCode === slug || l.slug === slug || l.uniqueCode === slug || l.redirectCode === slug) || null;
  } catch (error) {
    console.error('[Link] findBySlug error:', error.message);
    throw new Error(`Failed to find link by slug: ${error.message}`);
  }
}

async function findByRedirectCode(code) {
  try {
    if (!code) return null;
    const all = await getCachedLinks();
    return all.find(l => l.redirectCode === code || l.baseCode === code) || null;
  } catch (error) {
    console.error('[Link] findByRedirectCode error:', error.message);
    throw new Error(`Failed to find link by redirect code: ${error.message}`);
  }
}

async function findMany(filters = {}) {
  try {
    let links = await getCachedLinks();

    if (filters.category) links = links.filter(l => l.category === filters.category);
    if (filters.status) links = links.filter(l => l.status === filters.status);
    if (filters.linkType) links = links.filter(l => l.linkType === filters.linkType);
    if (filters.ownerId) links = links.filter(l => l.ownerId === toStringId(filters.ownerId));
    if (filters.is_chain !== undefined) links = links.filter(l => l.is_chain === filters.is_chain);
    if (filters.chain_name) links = links.filter(l => l.chain_name === filters.chain_name);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      links = links.filter(l =>
        (l.name || '').toLowerCase().includes(q) ||
        (l.pathName || '').toLowerCase().includes(q) ||
        (l.category || '').toLowerCase().includes(q) ||
        (l.chain_name || '').toLowerCase().includes(q)
      );
    }

    links.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return links;
  } catch (error) {
    console.error('[Link] findMany error:', error.message);
    throw new Error(`Failed to find links: ${error.message}`);
  }
}

async function getCategories() {
  try {
    const all = await getCachedLinks();
    return [...new Set(all.map(l => l.category).filter(Boolean))].sort();
  } catch (error) {
    console.error('[Link] getCategories error:', error.message);
    throw new Error(`Failed to get categories: ${error.message}`);
  }
}

// ============================================================
// UPDATE
// ============================================================

async function update(id, updates) {
  try {
    const link = await db.links.findById(id);
    if (!link) return null;

    if (updates.baseCode && updates.baseCode !== link.baseCode) {
      if (!link.slug_history) link.slug_history = [];
      link.slug_history.push(link.baseCode);
      updates.slug = updates.baseCode;
      updates.redirectCode = updates.baseCode;
    }

    if (updates.baseUrl) updates.baseUrl = cleanUrl(updates.baseUrl);
    
    // ✅ v3.1: pathName update — name follows pathName
    if (updates.pathName) {
      updates.pathName = updates.pathName.trim().toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
      updates.name = updates.pathName;
    }

    if (updates.chain_links && Array.isArray(updates.chain_links)) {
      updates.chain_links = updates.chain_links.map(cl => ({
        name: cl.name || '',
        url: cleanUrl(cl.url || ''),
        weight: cl.weight || 1,
        actionCode: cl.actionCode || generateActionCode(),
      }));
    }

    if (updates.inboxView && !updates.linksCategory) {
      updates.inboxAction = updates.inboxView === 'message' ? 'message' : 'direct';
      updates.linksCategory = updates.inboxView === 'message' ? 'message' : 'action';
      updates.filterType = updates.inboxView === 'message' ? 'message' : (updates.category || link.category);
    }

    const result = await db.links.findByIdAndUpdate(id, updates);
    clearLinkCache();
    return result;
  } catch (error) {
    console.error('[Link] update error:', error.message);
    throw new Error(`Failed to update link: ${error.message}`);
  }
}

// ============================================================
// DELETE
// ============================================================

async function remove(id) {
  try {
    const result = await db.links.findByIdAndDelete(id);
    clearLinkCache();
    return result;
  } catch (error) {
    console.error('[Link] remove error:', error.message);
    throw new Error(`Failed to delete link: ${error.message}`);
  }
}

// ============================================================
// CLICKS
// ============================================================

async function incrementClicks(id) {
  try {
    const link = await db.links.findById(id);
    if (!link) return null;
    const result = await db.links.findByIdAndUpdate(id, {
      total_clicks: (link.total_clicks || 0) + 1,
      last_click: now(),
    });
    clearLinkCache();
    return result;
  } catch (error) {
    console.error('[Link] incrementClicks error:', error.message);
    throw new Error(`Failed to increment clicks: ${error.message}`);
  }
}

// ============================================================
// CHAIN ROTATION (OPTIMIZED - Single DB write)
// ============================================================

async function getNextChainUrl(link, visitorId) {
  try {
    if (!link || !link.is_chain || !link.chain_links || link.chain_links.length === 0) {
      return { url: null, name: '', index: 0, totalLinks: 0 };
    }

    const chainLinks = link.chain_links;
    const mode = link.chain_rotation_mode || ROTATION_MODES.SEQUENTIAL;
    let selectedIndex = 0;
    let currentIndex = link.chain_current_index || 0;

    if (mode === ROTATION_MODES.SEQUENTIAL) {
      selectedIndex = currentIndex % chainLinks.length;
      currentIndex = (selectedIndex + 1) % chainLinks.length;
    } else if (mode === ROTATION_MODES.RANDOM) {
      selectedIndex = Math.floor(Math.random() * chainLinks.length);
    } else if (mode === ROTATION_MODES.WEIGHTED) {
      const totalWeight = chainLinks.reduce((sum, cl) => sum + (cl.weight || 1), 0);
      let random = Math.random() * totalWeight;
      for (let i = 0; i < chainLinks.length; i++) {
        random -= (chainLinks[i].weight || 1);
        if (random <= 0) { selectedIndex = i; break; }
      }
    }

    const visitorMap = link.chain_visitor_map || {};
    visitorMap[visitorId] = {
      index: selectedIndex,
      url: chainLinks[selectedIndex]?.url || '',
      timestamp: now(),
    };

    const keys = Object.keys(visitorMap);
    if (keys.length > CONFIG.CHAIN_VISITOR_MAP_MAX) {
      const sorted = keys.sort((a, b) => 
        new Date(visitorMap[a].timestamp) - new Date(visitorMap[b].timestamp)
      );
      const toDelete = sorted.slice(0, keys.length - CONFIG.CHAIN_VISITOR_MAP_MAX);
      toDelete.forEach(k => delete visitorMap[k]);
    }

    await db.links.findByIdAndUpdate(link._id, {
      chain_current_index: currentIndex,
      chain_visitor_map: visitorMap,
      chain_total_visitors: (link.chain_total_visitors || 0) + 1,
      updated_at: now(),
    });
    clearLinkCache();

    return {
      url: chainLinks[selectedIndex]?.url || null,
      name: chainLinks[selectedIndex]?.name || '',
      index: selectedIndex,
      totalLinks: chainLinks.length,
    };
  } catch (error) {
    console.error('[Link] getNextChainUrl error:', error.message);
    throw new Error(`Failed to get next chain URL: ${error.message}`);
  }
}

async function getChainStepUrl(link, stepIndex) {
  try {
    if (!link || !link.is_chain || !link.chain_links) return null;
    const idx = Math.max(0, Math.min(stepIndex, link.chain_links.length - 1));
    return {
      url: link.chain_links[idx]?.url || null,
      name: link.chain_links[idx]?.name || '',
      index: idx,
      totalLinks: link.chain_links.length,
    };
  } catch (error) {
    console.error('[Link] getChainStepUrl error:', error.message);
    throw new Error(`Failed to get chain step URL: ${error.message}`);
  }
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  create,
  findById,
  findOne,
  findBySlug,
  findByRedirectCode,
  findMany,
  getCategories,
  update,
  remove,
  incrementClicks,
  getNextChainUrl,
  getChainStepUrl,
  clearLinkCache,
};