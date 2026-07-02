// ============================================================
// MEGA TOOLS — LINK MODEL
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
// CREATE
// ============================================================

async function create(data) {
  const nowISO = now();
  const code = data.baseCode || data.redirectCode || generateActionCode();

  const link = {
    _id: generateId('l'),
    name: data.name || 'Untitled',
    category: data.category || 'general',
    baseUrl: cleanUrl(data.baseUrl) || '',
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
  return link;
}

// ============================================================
// FIND
// ============================================================

async function findById(id) {
  return db.links.findById(id);
}

async function findOne(filter = {}) {
  const all = await db.links.read();
  return all.find(l => Object.keys(filter).every(k => l[k] === filter[k])) || null;
}

async function findBySlug(slug) {
  if (!slug) return null;
  const all = await db.links.read();
  return all.find(l => l.baseCode === slug || l.slug === slug || l.uniqueCode === slug || l.redirectCode === slug) || null;
}

async function findByRedirectCode(code) {
  if (!code) return null;
  const all = await db.links.read();
  return all.find(l => l.redirectCode === code || l.baseCode === code) || null;
}

async function findMany(filters = {}) {
  let links = await db.links.read();

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
      (l.category || '').toLowerCase().includes(q) ||
      (l.chain_name || '').toLowerCase().includes(q)
    );
  }

  links.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return links;
}

async function getCategories() {
  const all = await db.links.read();
  return [...new Set(all.map(l => l.category).filter(Boolean))].sort();
}

// ============================================================
// UPDATE
// ============================================================

async function update(id, updates) {
  const link = await db.links.findById(id);
  if (!link) return null;

  if (updates.baseCode && updates.baseCode !== link.baseCode) {
    if (!link.slug_history) link.slug_history = [];
    link.slug_history.push(link.baseCode);
    updates.slug = updates.baseCode;
    updates.redirectCode = updates.baseCode;
  }

  if (updates.baseUrl) updates.baseUrl = cleanUrl(updates.baseUrl);

  if (updates.chain_links && Array.isArray(updates.chain_links)) {
    updates.chain_links = updates.chain_links.map(cl => ({
      name: cl.name || '',
      url: cleanUrl(cl.url || ''),
      weight: cl.weight || 1,
      actionCode: cl.actionCode || generateActionCode(),
    }));
  }

  // Only auto-set linksCategory/inboxAction if not explicitly provided
  if (updates.inboxView && !updates.linksCategory) {
    updates.inboxAction = updates.inboxView === 'message' ? 'message' : 'direct';
    updates.linksCategory = updates.inboxView === 'message' ? 'message' : 'action';
    updates.filterType = updates.inboxView === 'message' ? 'message' : (updates.category || link.category);
  }

  return db.links.findByIdAndUpdate(id, updates);
}

// ============================================================
// DELETE
// ============================================================

async function remove(id) {
  return db.links.findByIdAndDelete(id);
}

// ============================================================
// CLICKS
// ============================================================

async function incrementClicks(id) {
  const link = await db.links.findById(id);
  if (!link) return null;
  return db.links.findByIdAndUpdate(id, {
    total_clicks: (link.total_clicks || 0) + 1,
    last_click: now(),
  });
}

// ============================================================
// CHAIN ROTATION
// ============================================================

async function getNextChainUrl(link, visitorId) {
  if (!link || !link.is_chain || !link.chain_links || link.chain_links.length === 0) {
    return { url: null, name: '', index: 0, totalLinks: 0 };
  }

  const chainLinks = link.chain_links;
  const mode = link.chain_rotation_mode || ROTATION_MODES.SEQUENTIAL;
  let selectedIndex = 0;

  if (mode === ROTATION_MODES.SEQUENTIAL) {
    selectedIndex = (link.chain_current_index || 0) % chainLinks.length;
    await update(link._id, {
      chain_current_index: (selectedIndex + 1) % chainLinks.length,
      chain_total_visitors: (link.chain_total_visitors || 0) + 1,
    });
  } else if (mode === ROTATION_MODES.RANDOM) {
    selectedIndex = Math.floor(Math.random() * chainLinks.length);
    await update(link._id, {
      chain_total_visitors: (link.chain_total_visitors || 0) + 1,
    });
  } else if (mode === ROTATION_MODES.WEIGHTED) {
    const totalWeight = chainLinks.reduce((sum, cl) => sum + (cl.weight || 1), 0);
    let random = Math.random() * totalWeight;
    for (let i = 0; i < chainLinks.length; i++) {
      random -= (chainLinks[i].weight || 1);
      if (random <= 0) { selectedIndex = i; break; }
    }
    await update(link._id, {
      chain_total_visitors: (link.chain_total_visitors || 0) + 1,
    });
  }

  const visitorMap = link.chain_visitor_map || {};
  visitorMap[visitorId] = {
    index: selectedIndex,
    url: chainLinks[selectedIndex]?.url || '',
    timestamp: now(),
  };

  const keys = Object.keys(visitorMap);
  if (keys.length > CONFIG.CHAIN_VISITOR_MAP_MAX) {
    const sorted = keys.sort((a, b) => new Date(visitorMap[a].timestamp) - new Date(visitorMap[b].timestamp));
    sorted.slice(0, keys.length - CONFIG.CHAIN_VISITOR_MAP_MAX).forEach(k => delete visitorMap[k]);
  }

  await update(link._id, { chain_visitor_map: visitorMap });

  return {
    url: chainLinks[selectedIndex]?.url || null,
    name: chainLinks[selectedIndex]?.name || '',
    index: selectedIndex,
    totalLinks: chainLinks.length,
  };
}

async function getChainStepUrl(link, stepIndex) {
  if (!link || !link.is_chain || !link.chain_links) return null;
  const idx = Math.max(0, Math.min(stepIndex, link.chain_links.length - 1));
  return {
    url: link.chain_links[idx]?.url || null,
    name: link.chain_links[idx]?.name || '',
    index: idx,
    totalLinks: link.chain_links.length,
  };
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
};