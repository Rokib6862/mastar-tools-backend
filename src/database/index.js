// ============================================================
// MEGA TOOLS — DATABASE LAYER (MongoDB Primary + JSON Backup)
// HYBRID: _col exposed + deleteAll for clear-all
// ============================================================

const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const CONFIG = require('../config');

// ---- CONSTANTS ----
const DATA_DIR = path.join(__dirname, '../../data');
const COLLECTIONS = [
  'users', 'links', 'sessions',
  'menuItems', 'routeLogs', 'clicks', 'referrals',
  'messages', 'themes', 'chains', 'ads'
];

// ---- ENSURE DATA DIRECTORY ----
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---- STATE ----
let client = null;
let dbInstance = null;
let mongoAvailable = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

// ============================================================
// JSON FILE HELPERS (Backup Only — NEVER primary)
// ============================================================

function readJSON(collection) {
  const filePath = path.join(DATA_DIR, `${collection}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error(`[DB] Read error: ${collection}.json — ${err.message}`);
    return [];
  }
}

function writeJSON(collection, data) {
  const filePath = path.join(DATA_DIR, `${collection}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[DB] Write error: ${collection}.json — ${err.message}`);
  }
}

// ============================================================
// MONGODB CONNECTION
// ============================================================

async function connectMongo() {
  const uri = CONFIG.MONGODB_URI;
  if (!uri || uri.trim() === '') {
    if (!mongoAvailable) logFallback('MONGODB_URI is empty');
    return null;
  }

  try {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: CONFIG.DB_SERVER_SELECTION_TIMEOUT,
      connectTimeoutMS: CONFIG.DB_CONNECT_TIMEOUT,
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 60000,
    });

    await client.connect();
    dbInstance = client.db(CONFIG.MONGODB_DB);
    mongoAvailable = true;
    reconnectAttempts = 0;

    const existingCols = await dbInstance.listCollections().toArray();
    const existingNames = existingCols.map(c => c.name);
    for (const col of COLLECTIONS) {
      if (!existingNames.includes(col)) {
        await dbInstance.createCollection(col);
      }
    }

    await createIndexes();
    await migrateFromJSON();
    await syncMongoToJSON();

    console.log(`[DB] ✅ MongoDB connected: ${CONFIG.MONGODB_DB}`);
    return dbInstance;

  } catch (err) {
    mongoAvailable = false;
    logFallback(err.message);
    scheduleReconnect();
    return null;
  }
}

function logFallback(reason) {
  if (reconnectAttempts === 0) {
    console.log(`[DB] 📂 MongoDB unavailable, using JSON (${reason})`);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectAttempts >= CONFIG.DB_MAX_RETRIES) {
    console.log('[DB] Max reconnect attempts reached, using JSON fallback');
    return;
  }
  reconnectAttempts++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await connectMongo();
  }, CONFIG.DB_RETRY_DELAY);
}

async function createIndexes() {
  if (!dbInstance) return;
  try {
    const sessionCol = dbInstance.collection('sessions');
    await sessionCol.createIndex({ visitorId: 1 });
    await sessionCol.createIndex({ trackingCode: 1 });
    await sessionCol.createIndex({ isLive: 1 });
    await sessionCol.createIndex({ lastActivity: -1 });
    await sessionCol.createIndex({ status: 1 });
    await sessionCol.createIndex({ created_at: -1 });

    try { await sessionCol.dropIndex('unique_active_visitor'); } catch (e) {}

    const userCol = dbInstance.collection('users');
    try { await userCol.createIndex({ email: 1 }, { unique: true, sparse: true }); } catch (e) {}
    try { await userCol.createIndex({ username: 1 }, { unique: true, sparse: true }); } catch (e) {}
    await userCol.createIndex({ trackingCode: 1 });

    const linkCol = dbInstance.collection('links');
    await linkCol.createIndex({ baseCode: 1 });
    await linkCol.createIndex({ category: 1 });

    console.log('[DB] ✅ Indexes ready (6 session indexes)');

  } catch (err) {
    console.error(`[DB] Index error: ${err.message}`);
  }
}

async function migrateFromJSON() {
  if (!dbInstance) return;
  for (const col of COLLECTIONS) {
    try {
      const count = await dbInstance.collection(col).countDocuments();
      if (count > 0) continue;
      const jsonData = readJSON(col);
      if (jsonData.length > 0) {
        await dbInstance.collection(col).insertMany(jsonData, { ordered: false });
        console.log(`[DB] 📦 Migrated ${jsonData.length} docs from ${col}.json → MongoDB`);
      }
    } catch (err) {
      if (err.code !== 11000) {
        console.error(`[DB] Migration error: ${col} — ${err.message}`);
      }
    }
  }
}

async function syncMongoToJSON() {
  if (!dbInstance) return;
  for (const col of COLLECTIONS) {
    try {
      const all = await dbInstance.collection(col).find().toArray();
      writeJSON(col, all);
    } catch (err) {}
  }
}

// ============================================================
// ATOMIC WRITE
// ============================================================

async function read(collection) {
  if (mongoAvailable && dbInstance) {
    try {
      return await dbInstance.collection(collection).find().toArray();
    } catch (err) {
      console.error(`[DB] MongoDB read error: ${collection} — ${err.message}`);
    }
  }
  return readJSON(collection);
}

async function write(collection, data) {
  if (mongoAvailable && dbInstance) {
    try {
      const col = dbInstance.collection(collection);
      const existingIds = (await col.find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id.toString());
      const newIds = data.map(d => (d._id?.toString?.() || d._id));
      const toDelete = existingIds.filter(id => !newIds.includes(id));
      const toUpsert = data;
      const operations = [];
      toDelete.forEach(id => {
        const { ObjectId } = require('mongodb');
        operations.push({ deleteOne: { filter: { _id: ObjectId.isValid(id) ? new ObjectId(id) : id } } });
      });
      toUpsert.forEach(doc => {
        const { ObjectId } = require('mongodb');
        const id = doc._id?.toString?.() || doc._id;
        operations.push({ replaceOne: { filter: { _id: ObjectId.isValid(id) ? new ObjectId(id) : id }, replacement: doc, upsert: true } });
      });
      if (operations.length > 0) await col.bulkWrite(operations, { ordered: false });
      setImmediate(async () => {
        try { const all = await col.find().toArray(); writeJSON(collection, all); } catch (err) {}
      });
      return data;
    } catch (err) {
      console.error(`[DB] MongoDB write error: ${collection} — ${err.message}`);
    }
  }
  writeJSON(collection, data);
  return data;
}

// ============================================================
// DELETE ALL — MongoDB + JSON both clean, no sync-back
// ============================================================

async function deleteAll(collection) {
  // MongoDB
  if (mongoAvailable && dbInstance) {
    try {
      await dbInstance.collection(collection).deleteMany({});
    } catch (err) {
      console.error(`[DB] deleteAll MongoDB error: ${collection} — ${err.message}`);
    }
  }
  // JSON
  writeJSON(collection, []);
}

async function findById(collection, id) {
  if (!id) return null;
  if (mongoAvailable && dbInstance) {
    try {
      const { ObjectId } = require('mongodb');
      const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
      return await dbInstance.collection(collection).findOne(query);
    } catch (err) {
      console.error(`[DB] findById error: ${collection} — ${err.message}`);
    }
  }
  const all = readJSON(collection);
  return all.find(item => {
    const itemId = item._id?.toString?.() || item._id;
    return itemId === id?.toString?.() || itemId === id;
  }) || null;
}

async function findByIdAndUpdate(collection, id, updates) {
  if (!id) return null;
  const updateDoc = { ...updates, updated_at: new Date().toISOString() };
  if (mongoAvailable && dbInstance) {
    try {
      const { ObjectId } = require('mongodb');
      const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
      await dbInstance.collection(collection).updateOne(query, { $set: updateDoc });
      const updated = await dbInstance.collection(collection).findOne(query);
      setImmediate(async () => {
        try { const all = await dbInstance.collection(collection).find().toArray(); writeJSON(collection, all); } catch (err) {}
      });
      return updated;
    } catch (err) {
      console.error(`[DB] findByIdAndUpdate error: ${collection} — ${err.message}`);
    }
  }
  const all = readJSON(collection);
  const index = all.findIndex(item => {
    const itemId = item._id?.toString?.() || item._id;
    return itemId === id?.toString?.() || itemId === id;
  });
  if (index === -1) return null;
  all[index] = { ...all[index], ...updateDoc };
  writeJSON(collection, all);
  return all[index];
}

async function findByIdAndDelete(collection, id) {
  if (!id) return null;
  if (mongoAvailable && dbInstance) {
    try {
      const { ObjectId } = require('mongodb');
      const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
      const doc = await dbInstance.collection(collection).findOne(query);
      if (doc) await dbInstance.collection(collection).deleteOne(query);
      setImmediate(async () => {
        try { const all = await dbInstance.collection(collection).find().toArray(); writeJSON(collection, all); } catch (err) {}
      });
      return doc;
    } catch (err) {
      console.error(`[DB] findByIdAndDelete error: ${collection} — ${err.message}`);
    }
  }
  const all = readJSON(collection);
  const index = all.findIndex(item => {
    const itemId = item._id?.toString?.() || item._id;
    return itemId === id?.toString?.() || itemId === id;
  });
  if (index === -1) return null;
  const deleted = all.splice(index, 1)[0];
  writeJSON(collection, all);
  return deleted;
}

async function count(collection, filter = {}) {
  if (mongoAvailable && dbInstance) {
    try { return await dbInstance.collection(collection).countDocuments(filter); }
    catch (err) { console.error(`[DB] count error: ${collection} — ${err.message}`); }
  }
  let all = readJSON(collection);
  if (filter.status) all = all.filter(x => x.status === filter.status);
  if (filter.role) all = all.filter(x => x.role === filter.role);
  if (filter.isLive !== undefined) all = all.filter(x => x.isLive === filter.isLive);
  return all.length;
}

async function distinct(collection, field) {
  if (mongoAvailable && dbInstance) {
    try { return await dbInstance.collection(collection).distinct(field); }
    catch (err) { console.error(`[DB] distinct error: ${collection} — ${err.message}`); }
  }
  const all = readJSON(collection);
  return [...new Set(all.map(item => item[field]).filter(Boolean))];
}

async function health() {
  if (mongoAvailable && dbInstance) {
    try {
      await dbInstance.command({ ping: 1 });
      return { status: 'ok', type: 'mongodb', database: CONFIG.MONGODB_DB };
    } catch (err) {
      return { status: 'degraded', type: 'fallback', error: err.message };
    }
  }
  return { status: 'offline', type: 'json' };
}

async function close() {
  if (mongoAvailable && dbInstance) { await syncMongoToJSON(); }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (client) { await client.close(); client = null; dbInstance = null; mongoAvailable = false; console.log('[DB] Connection closed'); }
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
    get _col() { return dbInstance ? dbInstance.collection(col) : null; }
  };
});

// ---- ALIASES ----
db.connect = connectMongo;
db.health = health;
db.close = close;
db.readJSON = (collection) => readJSON(collection);
db.writeJSON = (collection, data) => writeJSON(collection, data);
db.deleteAll = (collection) => deleteAll(collection);

// ---- INIT ----
connectMongo();

module.exports = db;