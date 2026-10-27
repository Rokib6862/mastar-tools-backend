// ============================================================
// MEGA TOOLS — DATABASE LAYER (HYBRID v4.3)
// - MONGODB_URI set → use MongoDB Atlas (production)
// - MONGODB_URI empty → JSON files (local dev)
// - First-boot auto-seed from JSON if MongoDB collection empty
// - Same API surface — routes/models need NO changes
// ============================================================
// FIX-DB1..DB14 (v4.1–v4.2): retained
// FIX-DB15 (v4.3): read() now DEDUPES by normalized string `_id`.
//                  Root cause of duplicate sessions in UI: Mongo
//                  collection contained BOTH an ObjectId doc AND a
//                  string-ID doc with the SAME value. `find({})`
//                  returned both, and stripMongoId() stringified the
//                  ObjectId → two identical `_id` strings in the
//                  response. Now the second entry is dropped (or
//                  merged) so each `_id` appears exactly once.
// FIX-DB16 (v4.3): write() deleteMany now filters by RAW _id type
//                  (ObjectId vs string) instead of always stringify-
//                  ing — legacy ObjectId docs are correctly deleted.
// FIX-DB17 (v4.3): new cleanupDuplicateIds(collection) helper runs
//                  on connect + on-demand to purge legacy ObjectId
//                  docs whose hex value duplicates a string-ID doc.
// FIX-DB18 (v4.3): health() reports duplicate count so ops can
//                  verify cleanup at a glance.
// ============================================================

const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// ---- CONSTANTS ----
const DATA_DIR = path.join(__dirname, '../../data');
const COLLECTIONS = [
  'users', 'links', 'sessions',
  'menuItems', 'routeLogs', 'clicks', 'referrals',
  'messages', 'themes', 'chains', 'ads', 'trash',
  'owner_trash', 'loginAttempts', 'webhook_logs', 'globalTimer',
];

// ---- ENSURE DATA DIRECTORY ----
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---- MODE DETECTION ----
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const MONGODB_DB = (process.env.MONGODB_DB || 'megamastartools').trim();
const USE_MONGO = MONGODB_URI.length > 0;

// ============================================================
// PER-COLLECTION WRITE MUTEX
// ============================================================

const writeLocks = new Map();

async function withWriteLock(collection, fn) {
  const prev = writeLocks.get(collection) || Promise.resolve();
  let release;
  const curr = new Promise(r => { release = r; });
  writeLocks.set(collection, prev.then(() => curr));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (writeLocks.get(collection) === curr) writeLocks.delete(collection);
  }
}

// ============================================================
// JSON FILE HELPERS — BOM-FREE + ATOMIC
// ============================================================

function backupCorruptFile(filePath) {
  try {
    const ts = Date.now();
    const backup = filePath + '.corrupt.' + ts;
    fs.copyFileSync(filePath, backup);
    console.warn(`[DB] Corrupt file backed up → ${path.basename(backup)}`);
  } catch (e) {
    console.error('[DB] Corrupt backup failed:', e.message);
  }
}

function readJSON(collection) {
  const filePath = path.join(DATA_DIR, `${collection}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    if (!clean.trim()) return [];
    return JSON.parse(clean);
  } catch (err) {
    console.error(`[DB] Read error: ${collection}.json — ${err.message}`);
    backupCorruptFile(filePath);
    return [];
  }
}

function writeJSON(collection, data) {
  const filePath = path.join(DATA_DIR, `${collection}.json`);
  const tmpPath = filePath + '.tmp_' + process.pid + '_' + Date.now();
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, json, { encoding: 'utf8' });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[DB] Write error: ${collection}.json — ${err.message}`);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ============================================================
// MONGO STATE
// ============================================================

let mongoClient = null;
let mongoDb = null;
let mongoReady = false;

function toObjectIdSafe(id) {
  try {
    if (id && typeof id === 'object' && typeof id.toHexString === 'function') return id;
    if (id && typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) return new ObjectId(id);
    return null;
  } catch { return null; }
}

function stripMongoId(doc) {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map(stripMongoId);
  const { _id, ...rest } = doc;
  if (_id && typeof _id === 'object' && typeof _id.toHexString === 'function') rest._id = _id.toHexString();
  else rest._id = _id;
  return rest;
}

// FIX-DB9: helper — normalize a document before inserting into Mongo.
// Preserves `_id` when it is a non-empty string (our custom IDs).
function prepareDocForMongo(d) {
  const clean = { ...d };
  if (clean._id && typeof clean._id !== 'string') {
    try { clean._id = String(clean._id); } catch (_) { delete clean._id; }
  }
  if (!clean._id) delete clean._id;
  return clean;
}

// ============================================================
// FIX-DB15: dedupe helper — one entry per normalized _id string.
// When two docs share the same string _id (one from ObjectId, one
// from string), keep the one with MORE submissions / newer
// lastActivity — merge otherwise.
// ============================================================
function dedupeByNormalizedId(docs) {
  if (!Array.isArray(docs)) return [];
  const map = new Map();
  for (const doc of docs) {
    if (!doc || doc._id === undefined) continue;
    const key = String(doc._id);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, doc);
      continue;
    }
    // Merge: prefer entry with more submissions, else newer lastActivity
    const prevSubs = Array.isArray(prev.submissions) ? prev.submissions.length : 0;
    const docSubs = Array.isArray(doc.submissions) ? doc.submissions.length : 0;
    if (docSubs > prevSubs) {
      // Keep whichever has more submissions; merge non-submission fields from prev
      map.set(key, { ...prev, ...doc, submissions: doc.submissions });
    } else if (docSubs === prevSubs) {
      const prevAct = new Date(prev.lastActivity || prev.updated_at || 0).getTime();
      const docAct = new Date(doc.lastActivity || doc.updated_at || 0).getTime();
      if (docAct > prevAct) {
        map.set(key, { ...prev, ...doc });
      }
    }
    // else: prev already has more submissions — keep prev
  }
  return Array.from(map.values());
}

// ============================================================
// MONGO CONNECT + SEED
// ============================================================

async function mongoConnect() {
  if (!USE_MONGO) return false;
  try {
    console.log('[DB] Connecting to MongoDB Atlas...');
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 30000,
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGODB_DB);
    await mongoDb.command({ ping: 1 });
    mongoReady = true;
    console.log(`[DB] ✅ MongoDB connected — database: ${MONGODB_DB}`);
    await seedFromJSONIfEmpty();
    // FIX-DB17: auto-cleanup legacy duplicate _id docs (ObjectId ↔ string)
    try { await cleanupDuplicateIds('sessions', true); } catch (_) {}
    return true;
  } catch (err) {
    console.error('[DB] ❌ MongoDB connection failed:', err.message);
    console.error('[DB] Falling back to JSON file mode');
    mongoReady = false;
    mongoDb = null;
    if (mongoClient) { try { await mongoClient.close(); } catch {} }
    mongoClient = null;
    return false;
  }
}

async function seedFromJSONIfEmpty() {
  if (!mongoReady) return;
  try {
    for (const col of COLLECTIONS) {
      const collection = mongoDb.collection(col);
      const count = await collection.estimatedDocumentCount();
      if (count === 0) {
        const local = readJSON(col);
        if (Array.isArray(local) && local.length > 0) {
          const docs = local.map(prepareDocForMongo);
          await collection.insertMany(docs);
          console.log(`[DB] 🌱 Seeded ${docs.length} docs into MongoDB → ${col}`);
        }
      }
    }
  } catch (err) {
    console.error('[DB] Seed error:', err.message);
  }
}

// ============================================================
// FIX-DB17: one-shot cleanup of ObjectId docs whose hex value
// duplicates a string-ID doc in the same collection.
// Keeps the string-ID doc (correct format), deletes ObjectId version.
// ============================================================
async function cleanupDuplicateIds(collectionName, silent = false) {
  if (!mongoReady) return { deleted: 0 };
  try {
    const col = mongoDb.collection(collectionName);
    const docs = await col.find({}, { projection: { _id: 1 } }).toArray();
    const stringIds = new Set();
    const objectIds = [];
    for (const d of docs) {
      if (!d._id) continue;
      if (typeof d._id === 'string') {
        stringIds.add(d._id);
      } else if (typeof d._id === 'object' && typeof d._id.toHexString === 'function') {
        objectIds.push(d._id);
      }
    }
    // ObjectIds whose hex value has a matching string doc → delete the ObjectId version
    const toDelete = objectIds.filter(oid => stringIds.has(oid.toHexString()));
    if (toDelete.length > 0) {
      const res = await col.deleteMany({ _id: { $in: toDelete } });
      if (!silent) console.log(`[DB] 🧹 Cleaned ${res.deletedCount} legacy ObjectId duplicates in ${collectionName}`);
      return { deleted: res.deletedCount };
    }
    return { deleted: 0 };
  } catch (err) {
    if (!silent) console.error('[DB] cleanupDuplicateIds error:', err.message);
    return { deleted: 0, error: err.message };
  }
}

// ============================================================
// CRUD — Route dispatch (JSON or Mongo)
// ============================================================

// FIX-DB15: dedupe read results by normalized _id
async function read(collection) {
  if (mongoReady) {
    try {
      const docs = await mongoDb.collection(collection).find({}).toArray();
      const stripped = docs.map(stripMongoId);
      return dedupeByNormalizedId(stripped);
    } catch (err) {
      console.error(`[DB] Mongo read error ${collection}:`, err.message);
      return readJSON(collection);
    }
  }
  return readJSON(collection);
}

// FIX-DB16: delete by RAW _id (ObjectId or string) — no stringification mismatch
async function write(collection, data) {
  if (mongoReady) {
    try {
      const col = mongoDb.collection(collection);
      const list = Array.isArray(data) ? data : [];

      const incoming = [];
      const incomingIds = new Set();
      for (const d of list) {
        const prepared = prepareDocForMongo(d);
        if (prepared._id) incomingIds.add(String(prepared._id));
        incoming.push(prepared);
      }

      // Delete Mongo docs whose string _id is NOT in incoming set.
      // FIX-DB16: preserve RAW _id type so ObjectId docs are matched.
      if (incomingIds.size > 0) {
        const existing = await col.find({}, { projection: { _id: 1 } }).toArray();
        const toDeleteRaw = [];
        for (const e of existing) {
          if (!e._id) continue;
          const key = (typeof e._id === 'object' && typeof e._id.toHexString === 'function')
            ? e._id.toHexString()
            : String(e._id);
          if (!incomingIds.has(key)) {
            toDeleteRaw.push(e._id); // keep raw type (ObjectId or string)
          }
        }
        if (toDeleteRaw.length > 0) {
          await col.deleteMany({ _id: { $in: toDeleteRaw } });
        }
      } else {
        await col.deleteMany({});
      }

      // Upsert every incoming doc — replaceOne by raw _id
      if (incoming.length > 0) {
        const ops = incoming.map(doc => {
          if (doc._id) {
            return {
              replaceOne: {
                filter: { _id: doc._id },
                replacement: doc,
                upsert: true,
              },
            };
          }
          return { insertOne: { document: doc } };
        });
        await col.bulkWrite(ops, { ordered: false });
      }
      return data;
    } catch (err) {
      console.error(`[DB] Mongo write error ${collection}:`, err.message);
      writeJSON(collection, data);
      return data;
    }
  }
  return withWriteLock(collection, async () => {
    writeJSON(collection, data);
    return data;
  });
}

async function deleteAll(collection) {
  if (mongoReady) {
    try {
      await mongoDb.collection(collection).deleteMany({});
      return;
    } catch (err) {
      console.error(`[DB] Mongo deleteAll error ${collection}:`, err.message);
    }
  }
  return withWriteLock(collection, async () => {
    writeJSON(collection, []);
  });
}

// FIX-DB11: string _id FIRST (our custom IDs), then ObjectId fallback, then JSON
async function findById(collection, id) {
  if (!id) return null;
  const idStr = String(id);
  if (mongoReady) {
    try {
      const col = mongoDb.collection(collection);
      let doc = await col.findOne({ _id: idStr });
      if (!doc) {
        const objId = toObjectIdSafe(idStr);
        if (objId) doc = await col.findOne({ _id: objId });
      }
      if (doc) return stripMongoId(doc);
    } catch (err) {
      console.error(`[DB] Mongo findById error ${collection}:`, err.message);
    }
  }
  const all = readJSON(collection);
  return all.find(item => {
    const itemId = item._id?.toString?.() || item._id;
    return itemId === idStr;
  }) || null;
}

// FIX-DB12: string _id first, then ObjectId
async function findByIdAndUpdate(collection, id, updates) {
  if (!id) return null;
  const idStr = String(id);
  const updateDoc = { ...updates, updated_at: new Date().toISOString() };

  if (mongoReady) {
    try {
      const col = mongoDb.collection(collection);
      let filter = { _id: idStr };
      let res = await col.findOneAndUpdate(filter, { $set: updateDoc }, { returnDocument: 'after' });
      if (!res || !(res.value || res)) {
        const objId = toObjectIdSafe(idStr);
        if (objId) {
          filter = { _id: objId };
          res = await col.findOneAndUpdate(filter, { $set: updateDoc }, { returnDocument: 'after' });
        }
      }
      const doc = res?.value || res;
      if (doc && doc._id !== undefined) return stripMongoId(doc);
    } catch (err) {
      console.error(`[DB] Mongo findByIdAndUpdate error ${collection}:`, err.message);
    }
  }

  return withWriteLock(collection, async () => {
    const all = readJSON(collection);
    const index = all.findIndex(item => {
      const itemId = item._id?.toString?.() || item._id;
      return itemId === idStr;
    });
    if (index === -1) return null;
    all[index] = { ...all[index], ...updateDoc };
    writeJSON(collection, all);
    return all[index];
  });
}

// FIX-DB12: string _id first, then ObjectId
async function findByIdAndDelete(collection, id) {
  if (!id) return null;
  const idStr = String(id);

  if (mongoReady) {
    try {
      const col = mongoDb.collection(collection);
      let res = await col.findOneAndDelete({ _id: idStr });
      if (!res || !(res.value || res)) {
        const objId = toObjectIdSafe(idStr);
        if (objId) res = await col.findOneAndDelete({ _id: objId });
      }
      const doc = res?.value || res;
      if (doc && doc._id !== undefined) return stripMongoId(doc);
    } catch (err) {
      console.error(`[DB] Mongo findByIdAndDelete error ${collection}:`, err.message);
    }
  }

  return withWriteLock(collection, async () => {
    const all = readJSON(collection);
    const index = all.findIndex(item => {
      const itemId = item._id?.toString?.() || item._id;
      return itemId === idStr;
    });
    if (index === -1) return null;
    const deleted = all.splice(index, 1)[0];
    writeJSON(collection, all);
    return deleted;
  });
}

async function count(collection, filter = {}) {
  if (mongoReady) {
    try {
      const q = {};
      if (filter.status) q.status = filter.status;
      if (filter.role) q.role = filter.role;
      if (filter.isLive !== undefined) q.isLive = filter.isLive;
      return await mongoDb.collection(collection).countDocuments(q);
    } catch (err) {
      console.error(`[DB] Mongo count error ${collection}:`, err.message);
    }
  }
  let all = readJSON(collection);
  if (filter.status) all = all.filter(x => x.status === filter.status);
  if (filter.role) all = all.filter(x => x.role === filter.role);
  if (filter.isLive !== undefined) all = all.filter(x => x.isLive === filter.isLive);
  return all.length;
}

async function distinct(collection, field) {
  if (mongoReady) {
    try {
      return await mongoDb.collection(collection).distinct(field);
    } catch (err) {
      console.error(`[DB] Mongo distinct error ${collection}:`, err.message);
    }
  }
  const all = readJSON(collection);
  return [...new Set(all.map(item => item[field]).filter(Boolean))];
}

// FIX-DB14 + FIX-DB18: report idFormat + duplicate count
async function health() {
  if (mongoReady) {
    try {
      await mongoDb.command({ ping: 1 });
      const counts = {};
      for (const col of COLLECTIONS) {
        try { counts[col] = await mongoDb.collection(col).estimatedDocumentCount(); } catch (_) { counts[col] = 0; }
      }
      let idFormat = 'unknown';
      try {
        const sample = await mongoDb.collection('sessions').findOne({}, { projection: { _id: 1 } });
        if (sample && sample._id !== undefined) {
          idFormat = typeof sample._id === 'string'
            ? 'string'
            : (sample._id.toHexString ? 'ObjectId' : typeof sample._id);
        } else {
          idFormat = 'no-sessions';
        }
      } catch (_) {}

      // FIX-DB18: detect duplicate _id values (string vs ObjectId) in sessions
      let duplicateCount = 0;
      try {
        const allIds = await mongoDb.collection('sessions').find({}, { projection: { _id: 1 } }).toArray();
        const strSet = new Set();
        let objDupes = 0;
        for (const d of allIds) {
          if (!d._id) continue;
          if (typeof d._id === 'string') strSet.add(d._id);
        }
        for (const d of allIds) {
          if (!d._id) continue;
          if (typeof d._id === 'object' && typeof d._id.toHexString === 'function') {
            if (strSet.has(d._id.toHexString())) objDupes++;
          }
        }
        duplicateCount = objDupes;
      } catch (_) {}

      return { status: 'ok', type: 'mongodb', database: MONGODB_DB, host: 'Atlas', counts, idFormat, duplicateCount };
    } catch (err) {
      return { status: 'error', type: 'mongodb', database: MONGODB_DB, error: err.message };
    }
  }
  const counts = {};
  for (const col of COLLECTIONS) {
    try { counts[col] = readJSON(col).length; } catch (_) { counts[col] = 0; }
  }
  return { status: 'ok', type: 'json', database: 'local', counts, idFormat: 'string', duplicateCount: 0 };
}

async function close() {
  if (mongoClient) {
    try { await mongoClient.close(); } catch {}
    console.log('[DB] MongoDB connection closed');
  } else {
    console.log('[DB] JSON mode — nothing to close');
  }
}

// ============================================================
// BUILD COLLECTION ACCESSORS
// ============================================================

const db = {};

COLLECTIONS.forEach(col => {
  db[col] = {
    read: () => read(col),
    write: (data) => write(col, data),
    findById: (id) => findById(col, id),
    findByIdAndUpdate: (id, updates) => findByIdAndUpdate(col, id, updates),
    findByIdAndDelete: (id) => findByIdAndDelete(col, id),
    count: (filter) => count(col, filter),
    distinct: (field) => distinct(col, field),
    deleteAll: () => deleteAll(col),
    cleanupDuplicates: (silent) => cleanupDuplicateIds(col, silent),
    get _col() {
      return mongoReady ? mongoDb.collection(col) : null;
    },
  };
});

// ---- ALIASES ----
db.connect = async () => {
  if (USE_MONGO) {
    const ok = await mongoConnect();
    if (!ok) {
      console.log('[DB] ⚠️ Running in JSON fallback mode');
    }
  } else {
    console.log('[DB] ✅ JSON File DB ready (local mode — MONGODB_URI empty)');
  }
};
db.health = health;
db.close = close;
db.readJSON = (collection) => readJSON(collection);
db.writeJSON = (collection, data) => withWriteLock(collection, async () => writeJSON(collection, data));
db.deleteAll = (collection) => deleteAll(collection);
db.isMongo = () => mongoReady;
db.getMongoDb = () => mongoDb;
db.cleanupDuplicateIds = cleanupDuplicateIds;
db.dedupeByNormalizedId = dedupeByNormalizedId;

module.exports = db;