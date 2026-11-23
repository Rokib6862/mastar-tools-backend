// ============================================================
// MEGA TOOLS — FOLDER MODEL (v1.3 — DOMAIN VALIDATION + AUTO-FIX)
// ============================================================
// Purpose:
//   Custom URLs "folders" are a SERVER-SIDE entity. Each folder
//   represents one external hostname that belongs to a specific
//   user. Folder create / delete / customize is visible across
//   ALL devices and accounts of the same user.
//
// Storage:
//   - MongoDB collection `folders` (production)
//   - JSON file `data/folders.json` (local dev)
//
// Data shape:
//   {
//     _id, name (hostname), ownerId, ownerTrackingCode,
//     createdBy, createdByRole, parentId,
//     overrides: { "<linkId>": "<suffix>" },
//     created_at, updated_at, deleted_at
//   }
//
// FIX-FD1 .. FIX-FD10 retained from v1.1 / v1.2.
//
// v1.3 CHANGE (2026-11-09) — DOMAIN VALIDATION + AUTO-FIX:
//   FIX-FD11: normalizeFolderName() now delegates to
//             helpers.isValidDomain() — a strict DNS-ish
//             hostname check. Bare strings like
//             "ffffffffffffff" or "eeee" are REJECTED at
//             create() and update(). Only real domains
//             (label.label.tld) can become a folder.
//   FIX-FD12: autoFixCorruptUrls() — one-shot (idempotent)
//             server-side migration that scans every link's
//             baseUrl and rewrites any "https://hostA/hostB/…"
//             or "https://https://host/…" pattern using
//             helpers.sanitizeBaseUrl(). Called from
//             GET /api/folders so a single page load heals
//             the DB across ALL users, no separate script
//             needed.
//   FIX-FD13: create() returns a clear reason when validation
//             fails, so POST /api/folders can surface
//             "invalid_domain" to the client.
// ============================================================

const db = require('../database');
const {
  toStringId,
  generateId,
  now,
  isValidDomain,
  sanitizeBaseUrl,
} = require('../utils/helpers');
const { ROLES } = require('./roles');

// ============================================================
// CACHE — folders rarely change, cache to avoid DB roundtrips
// ============================================================

let folderCache = null;
let folderCacheExpiry = 0;
const CACHE_TTL = 30000; // 30 seconds

async function getCachedFolders(forceRefresh = false) {
  if (forceRefresh || !folderCache || folderCacheExpiry < Date.now()) {
    folderCache = await db.folders.read();
    folderCacheExpiry = Date.now() + CACHE_TTL;
  }
  return folderCache;
}

function clearFolderCache() {
  folderCache = null;
  folderCacheExpiry = 0;
}

// ============================================================
// HELPERS
// ============================================================

function extractHostname(url) {
  try {
    const s = String(url || '').trim();
    if (!s) return '';
    const withProto = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    return new URL(withProto).hostname.toLowerCase() || '';
  } catch { return ''; }
}

// FIX-FD11: strict domain validation.
// Returns the normalized name (lowercase, no protocol/path) on
// success. Throws a typed error with .code === 'invalid_domain'
// on failure. Callers (create/update/routes) can surface this.
function normalizeFolderName(name) {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/^(?:https?:\/\/)+/i, '').replace(/\/.*$/, '');
  if (!s) {
    const err = new Error('Folder name (hostname) is required');
    err.code = 'name_required';
    throw err;
  }
  if (!isValidDomain(s)) {
    const err = new Error(`Invalid domain: "${s}". Must be like "example.com"`);
    err.code = 'invalid_domain';
    throw err;
  }
  return s;
}

function normalizeOverrides(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

// ============================================================
// AUTO PURGE — FIX-FD6 (v1.1)
// ============================================================

async function autoPurgeIfNoLinks() {
  try {
    const allLinks = await db.links.read();
    const eligible = allLinks.filter(l =>
      l.category !== 'personal' &&
      l.category !== 'message' &&
      l.category !== 'reply' &&
      l.linksCategory !== 'message' &&
      l.linksCategory !== 'reply' &&
      l.showInDeployment !== false &&
      l.showDeployUrl !== false
    );

    if (eligible.length > 0) return null;

    const allFolders = await db.folders.read();
    const active = allFolders.filter(f => !f.deleted_at);
    if (active.length === 0) return { purged: 0 };

    const nowISO = now();
    let touched = 0;
    for (const f of allFolders) {
      if (!f.deleted_at) {
        f.deleted_at = nowISO;
        touched++;
      }
    }

    if (touched > 0) {
      await db.folders.write(allFolders);
      clearFolderCache();
    }

    return { purged: touched };
  } catch (error) {
    console.error('[Folder] autoPurgeIfNoLinks error:', error.message);
    return null;
  }
}

// ============================================================
// AUTO-FIX CORRUPT baseUrl — FIX-FD12 (v1.3)
// ============================================================
// One-shot idempotent migration. Scans ALL links once and rewrites
// every baseUrl using helpers.sanitizeBaseUrl(). Detects:
//   * double protocol:  https://https://host/...
//   * double host:      https://hostA/hostB/...
// Any link whose sanitized value differs is written back. The
// function is safe to call on every GET — it becomes a no-op
// after the first successful run (no writes occur).
//
// Returns { fixed: <count>, scanned: <count> }.
// ============================================================

async function autoFixCorruptUrls() {
  try {
    const allLinks = await db.links.read();
    if (!Array.isArray(allLinks) || allLinks.length === 0) {
      return { fixed: 0, scanned: 0 };
    }

    let fixed = 0;
    let dirty = false;

    for (const link of allLinks) {
      // Skip personal links — their baseUrl is intentionally raw text.
      if (link.category === 'personal') continue;

      const original = String(link.baseUrl || '');
      if (!original) continue;

      const sanitized = sanitizeBaseUrl(original);
      if (sanitized && sanitized !== original) {
        link.baseUrl = sanitized;
        link.updated_at = now();
        fixed++;
        dirty = true;
      }

      // Also sanitize chain_links[].url
      if (Array.isArray(link.chain_links)) {
        for (const cl of link.chain_links) {
          const rawCl = String(cl.url || '');
          if (!rawCl) continue;
          const clSanitized = sanitizeBaseUrl(rawCl);
          if (clSanitized && clSanitized !== rawCl) {
            cl.url = clSanitized;
            dirty = true;
          }
        }
      }
    }

    if (dirty) {
      await db.links.write(allLinks);
      try {
        const Link = require('./Link');
        if (typeof Link.clearLinkCache === 'function') Link.clearLinkCache();
      } catch (_) {}
      console.log(`[Folder] autoFixCorruptUrls: rewrote ${fixed} link(s)`);
    }

    return { fixed, scanned: allLinks.length };
  } catch (error) {
    console.error('[Folder] autoFixCorruptUrls error:', error.message);
    return { fixed: 0, scanned: 0 };
  }
}

// ============================================================
// CREATE — FIX-FD10 + FIX-FD11 + FIX-FD13
// ============================================================

async function create(data) {
  try {
    const name = normalizeFolderName(data.name); // throws on invalid
    if (!data.ownerId) {
      const err = new Error('ownerId is required');
      err.code = 'owner_required';
      throw err;
    }

    const ownerId = toStringId(data.ownerId);
    const nowISO = now();

    // FIX-FD3: idempotent — return existing non-deleted folder for
    // same (ownerId, name)
    const existing = (await getCachedFolders(true)).find(f =>
      toStringId(f.ownerId) === ownerId &&
      String(f.name).toLowerCase() === name &&
      !f.deleted_at
    );
    if (existing) return existing;

    const folder = {
      _id: generateId('f'),
      name,
      ownerId,
      ownerTrackingCode: data.ownerTrackingCode || null,
      createdBy: toStringId(data.createdBy) || ownerId,
      createdByRole: data.createdByRole || ROLES.USER,
      parentId: toStringId(data.parentId) || null,
      overrides: normalizeOverrides(data.overrides),
      created_at: nowISO,
      updated_at: nowISO,
      deleted_at: null,
    };

    const all = await db.folders.read();
    all.push(folder);
    await db.folders.write(all);
    clearFolderCache();
    return folder;
  } catch (error) {
    // Re-throw with the original .code so routes can branch on it
    console.error('[Folder] create error:', error.message);
    throw error;
  }
}

// ============================================================
// READ
// ============================================================

async function findById(id) {
  try {
    if (!id) return null;
    return await db.folders.findById(id);
  } catch (error) {
    console.error('[Folder] findById error:', error.message);
    throw new Error(`Failed to find folder: ${error.message}`);
  }
}

async function findByName(name, ownerId) {
  try {
    const n = normalizeFolderName(name); // may throw on invalid — callers handle
    const oid = toStringId(ownerId);
    const all = await getCachedFolders();
    return all.find(f =>
      String(f.name).toLowerCase() === n &&
      toStringId(f.ownerId) === oid &&
      !f.deleted_at
    ) || null;
  } catch (error) {
    // findByName must never crash callers on invalid input — just
    // return null so lookups fail gracefully.
    return null;
  }
}

// ============================================================
// LIST — FIX-FD8: strict per-user isolation for EVERY role
// ============================================================

async function findManyForUser(reqUser, allUsers) {
  try {
    const all = await getCachedFolders();
    const userId = toStringId(reqUser._id);
    if (!userId) return [];

    return all.filter(f =>
      !f.deleted_at && toStringId(f.ownerId) === userId
    );
  } catch (error) {
    console.error('[Folder] findManyForUser error:', error.message);
    throw new Error(`Failed to list folders: ${error.message}`);
  }
}

// ============================================================
// UPDATE
// ============================================================

async function update(id, updates) {
  try {
    const folder = await db.folders.findById(id);
    if (!folder) return null;

    const patch = {};
    if (updates.name !== undefined) {
      const n = normalizeFolderName(updates.name); // throws on invalid
      if (n) patch.name = n;
    }
    if (updates.overrides !== undefined) {
      patch.overrides = normalizeOverrides(updates.overrides);
    }
    if (updates.ownerId !== undefined) {
      patch.ownerId = toStringId(updates.ownerId);
    }

    if (Object.keys(patch).length === 0) return folder;

    const result = await db.folders.findByIdAndUpdate(id, patch);
    clearFolderCache();
    return result;
  } catch (error) {
    console.error('[Folder] update error:', error.message);
    throw error;
  }
}

// ============================================================
// CUSTOMIZE (per-link suffix override) — FIX-FD2
// ============================================================

async function setOverride(folderId, linkId, suffix) {
  try {
    const folder = await db.folders.findById(folderId);
    if (!folder) return null;

    const overrides = { ...(folder.overrides || {}) };
    const key = toStringId(linkId);
    const val = String(suffix || '').trim();

    if (!val) delete overrides[key];
    else overrides[key] = val;

    const result = await db.folders.findByIdAndUpdate(folderId, {
      overrides,
      updated_at: now(),
    });
    clearFolderCache();
    return result;
  } catch (error) {
    console.error('[Folder] setOverride error:', error.message);
    throw new Error(`Failed to customize folder link: ${error.message}`);
  }
}

async function clearOverride(folderId, linkId) {
  return setOverride(folderId, linkId, '');
}

// ============================================================
// DELETE (soft) — FIX-FD1
// ============================================================

async function softDelete(id) {
  try {
    const folder = await db.folders.findById(id);
    if (!folder) return null;
    const result = await db.folders.findByIdAndUpdate(id, {
      deleted_at: now(),
    });
    clearFolderCache();
    return result;
  } catch (error) {
    console.error('[Folder] softDelete error:', error.message);
    throw new Error(`Failed to delete folder: ${error.message}`);
  }
}

// ============================================================
// CASCADE DELETE LINKS — FIX-FD4 (retained, not called)
// ============================================================

async function deleteLinksByFolderName(folderName) {
  try {
    const name = String(folderName || '').trim().toLowerCase();
    if (!name) return { deleted: 0, ids: [] };

    const allLinks = await db.links.read();
    const keep = [];
    const toDelete = [];

    for (const l of allLinks) {
      if (extractHostname(l.baseUrl) === name) toDelete.push(l);
      else keep.push(l);
    }

    if (toDelete.length === 0) return { deleted: 0, ids: [] };

    await db.links.write(keep);
    try {
      const Link = require('./Link');
      if (typeof Link.clearLinkCache === 'function') Link.clearLinkCache();
    } catch (_) {}

    return {
      deleted: toDelete.length,
      ids: toDelete.map(l => toStringId(l._id)),
      links: toDelete,
    };
  } catch (error) {
    console.error('[Folder] deleteLinksByFolderName error:', error.message);
    throw new Error(`Failed to delete folder links: ${error.message}`);
  }
}

// ============================================================
// SCOPE (ownership check) — FIX-FD9
// ============================================================

function isFolderInScope(folder, reqUser) {
  if (!folder) return { allowed: false, reason: 'not_found' };
  const uid = toStringId(reqUser._id);
  const ownerId = toStringId(folder.ownerId);

  if (!ownerId) return { allowed: false, reason: 'orphan_folder' };
  if (ownerId === uid) return { allowed: true };
  return { allowed: false, reason: 'not_owner' };
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  create,
  findById,
  findByName,
  findManyForUser,
  update,
  setOverride,
  clearOverride,
  softDelete,
  deleteLinksByFolderName,
  autoPurgeIfNoLinks,
  autoFixCorruptUrls,
  isFolderInScope,
  extractHostname,
  normalizeFolderName,
  clearFolderCache,
  getCachedFolders,
};