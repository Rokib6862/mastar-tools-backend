// ============================================================
// MEGA TOOLS — GENERATE PAGE API (v3.1 LOCAL)
// FIX: Save to server/data/generatedPages/ (not client folder)
// FIX S2: Path traversal sanitization on GET + DELETE
// FIX-G1 (v3.1): Filename collation — append short hash suffix so
//                re-saving the same label does not silently overwrite
//                an existing page in a different partition.
// FIX-G2 (v3.1): JSON.parse wrapped in try/catch per-file for the
//                LIST endpoints so a single corrupt .json does not
//                break the entire list. Corrupt files are surfaced as
//                { filename, __corrupt: true, error }.
// FIX-G3 (v3.1): DELETE rejects built-in safety files (.gitkeep) and
//                non-json files; returns 400 with clear message.
// FIX-G4 (v3.1): POST validates `partition` against an allowed list
//                (landing, redirect, form, custom) to prevent arbitrary
//                category strings from drifting.
// FIX-G5 (v3.1): writeFile uses atomic write (tmp + rename) so a
//                crash mid-write cannot leave a truncated page file.
// ============================================================
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');

// FIX: Save to server/data/generatedPages/
const DATA_DIR = path.join(__dirname, '../../data/generatedPages');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// FIX-G4: allowed partitions
const ALLOWED_PARTITIONS = new Set(['landing', 'redirect', 'form', 'custom']);

// ============================================================
// HELPER: Safe filename resolution (FIX S2)
// ============================================================
function getSafePath(filename) {
  // Strip any path traversal attempts
  const safeName = path.basename(filename);
  if (safeName !== filename) return null;

  const filePath = path.join(DATA_DIR, safeName);
  const resolvedPath = path.resolve(filePath);
  const resolvedDataDir = path.resolve(DATA_DIR);

  // Verify resolved path is still within DATA_DIR
  if (!resolvedPath.startsWith(resolvedDataDir)) return null;

  return filePath;
}

// FIX-G1: generate collision-resistant filename
function buildFilename(label) {
  const base = String(label || 'page_' + Date.now())
    .replace(/[^a-z0-9]/gi, '_')
    .slice(0, 60);
  const hash = crypto.randomBytes(3).toString('hex');
  return base + '_' + hash + '.json';
}

// FIX-G5: atomic write helper
function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp_' + process.pid + '_' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

// FIX-G2: safe read that never throws on one bad file
function safeReadPage(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// GET all pages
// ============================================================
router.get('/', authenticate, (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const pages = files.map(f => {
      const read = safeReadPage(path.join(DATA_DIR, f));
      if (!read.ok) {
        return { filename: f, __corrupt: true, error: read.error };
      }
      return { filename: f, ...read.data };
    });
    res.json({ success: true, pages });
  } catch (err) {
    console.error('[GeneratePage] GET all error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// GET single page
// FIX S2: Path traversal protection
// ============================================================
router.get('/:filename', authenticate, (req, res) => {
  try {
    const filePath = getSafePath(req.params.filename);
    if (!filePath) return res.status(400).json({ success: false, message: 'Invalid filename' });
    if (!filePath.endsWith('.json')) return res.status(400).json({ success: false, message: 'Only .json allowed' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Not found' });

    const read = safeReadPage(filePath);
    if (!read.ok) return res.status(422).json({ success: false, message: 'Corrupt JSON: ' + read.error });

    res.json({ success: true, data: read.data });
  } catch (err) {
    console.error('[GeneratePage] GET single error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// SAVE page
// ============================================================
router.post('/', authenticate, (req, res) => {
  try {
    const { label, code, partition } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code is required' });

    // FIX-G4: validate partition
    const safePartition = ALLOWED_PARTITIONS.has(partition) ? partition : 'landing';

    // FIX-G1: collision-resistant filename
    const filename = buildFilename(label);

    const data = {
      id: Date.now(),
      label: label || 'Untitled',
      code,
      partition: safePartition,
      savedAt: new Date().toISOString(),
    };

    const filePath = path.join(DATA_DIR, filename);
    atomicWriteJSON(filePath, data); // FIX-G5

    res.status(201).json({ success: true, filename, data });
  } catch (err) {
    console.error('[GeneratePage] SAVE error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// DELETE page
// FIX S2: Path traversal protection
// ============================================================
router.delete('/:filename', authenticate, (req, res) => {
  try {
    const filename = req.params.filename;

    // FIX-G3: reject unsafe names
    if (!filename || filename === '.gitkeep' || !filename.endsWith('.json')) {
      return res.status(400).json({ success: false, message: 'Refusing to delete non-json or reserved file' });
    }

    const filePath = getSafePath(filename);
    if (!filePath) return res.status(400).json({ success: false, message: 'Invalid filename' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Not found' });

    fs.unlinkSync(filePath);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    console.error('[GeneratePage] DELETE error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// EXPORT all
// ============================================================
router.get('/export/all', authenticate, (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const all = [];
    for (const f of files) {
      const read = safeReadPage(path.join(DATA_DIR, f));
      if (read.ok) all.push({ filename: f, ...read.data });
      else all.push({ filename: f, __corrupt: true, error: read.error });
    }
    res.json({ success: true, pages: all, total: all.length });
  } catch (err) {
    console.error('[GeneratePage] EXPORT error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;