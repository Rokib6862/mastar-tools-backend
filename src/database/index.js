// ============================================================
// MEGA TOOLS — DATABASE LAYER (MongoDB + JSON Fallback v5.3)
// FIXED v5.3: Array-safe readJSON + insertOne for object collections
// ============================================================

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const DATA_DIR = path.join(__dirname, '../../data');
const COLLECTIONS = [
  'users', 'links', 'sessions',
  'menuItems', 'routeLogs', 'clicks', 'referrals',
  'messages', 'themes', 'chains', 'ads', 'trash',
  'webhook_logs', 'loginAttempts', 'globalTimer', 'owner_trash'
];

const MONGODB_URI = process.env.MONGODB_URI || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
let USE_MONGODB = IS_PRODUCTION && MONGODB_URI;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(collection) {
  const filePath = path.join(DATA_DIR, `${collection}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const parsed = JSON.parse(clean || '[]');
    // ✅ v5.3: সব collection-এ array return করবে
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  } catch (err) {
    console.error(`[DB] Read error: ${collection}.json — ${err.message}`);
    return [];
  }
}

function writeJSON(collection, data) {
  const filePath = path.join(DATA_DIR, `${collection}.json`);
  const tmpPath = filePath + '.tmp';
  const backupPath = filePath + '.bak';
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, json, { encoding: 'utf8' });
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[DB] Write error: ${collection}.json — ${err.message}`);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

function matchesOperator(itemVal, operator, expectedVal) {
  switch (operator) {
    case '$ne': return itemVal !== expectedVal;
    case '$gt': return itemVal > expectedVal;
    case '$lt': return itemVal < expectedVal;
    case '$gte': return itemVal >= expectedVal;
    case '$lte': return itemVal <= expectedVal;
    case '$in': return Array.isArray(expectedVal) && expectedVal.includes(itemVal);
    case '$nin': return Array.isArray(expectedVal) && !expectedVal.includes(itemVal);
    default: return false;
  }
}

function matchesFilter(item, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  return Object.keys(filter).every(key => {
    const filterVal = filter[key];
    const itemVal = item[key];

    if (filterVal && typeof filterVal === 'object' && !Array.isArray(filterVal)) {
      return Object.keys(filterVal).every(op => {
        const expectedVal = filterVal[op];
        return matchesOperator(itemVal, op, expectedVal);
      });
    }

    return (itemVal?.toString?.() || itemVal) === (filterVal?.toString?.() || filterVal);
  });
}

const DEFAULT_LIMIT = 10000;
const MAX_LIMIT = 100000;

function resolveLimit(limit) {
  if (limit === undefined || limit === null || limit === false || limit === 0) return DEFAULT_LIMIT;
  const num = parseInt(limit);
  if (isNaN(num) || num <= 0) return DEFAULT_LIMIT;
  return Math.min(num, MAX_LIMIT);
}

const Schema = mongoose.Schema;
const schemas = {};
const models = {};

function defineSchemas() {
  COLLECTIONS.forEach(col => {
    schemas[col] = new Schema(
      { _id: { type: String } },
      { strict: false, versionKey: false }
    );
  });
}

function buildModels() {
  COLLECTIONS.forEach(col => {
    try { models[col] = mongoose.model(col, schemas[col], col); }
    catch (err) { models[col] = mongoose.model(col); }
  });
}

async function safeCreateIndex(model, key, options = {}) {
  try {
    await model.collection.createIndex(key, options);
    return true;
  } catch (err) {
    if (err.code === 85 || err.code === 86) {
      console.log(`[DB] Index already exists — skip: ${JSON.stringify(key)}`);
      return false;
    }
    console.error(`[DB] Index error (${JSON.stringify(key)}): ${err.message}`);
    return false;
  }
}

async function createIndexes() {
  if (!USE_MONGODB) return;

  if (models.sessions) {
    await safeCreateIndex(models.sessions, { visitorId: 1 });
    await safeCreateIndex(models.sessions, { trackingCode: 1 });
    await safeCreateIndex(models.sessions, { createdAt: 1 });
    await safeCreateIndex(models.sessions, { expiresAt: 1 });
    await safeCreateIndex(models.sessions, { status: 1 });
    await safeCreateIndex(models.sessions, { isLive: 1 });
    console.log('[DB] ✅ Sessions indexes ready');
  }

  if (models.users) {
    await safeCreateIndex(models.users, { email: 1 }, { unique: true });
    await safeCreateIndex(models.users, { trackingCode: 1 });
    await safeCreateIndex(models.users, { username: 1 });
    console.log('[DB] ✅ Users indexes ready');
  }

  if (models.links) {
    await safeCreateIndex(models.links, { baseCode: 1 });
    await safeCreateIndex(models.links, { slug: 1 });
    await safeCreateIndex(models.links, { redirectCode: 1 });
    console.log('[DB] ✅ Links indexes ready');
  }

  if (models.trash) {
    await safeCreateIndex(models.trash, { originalId: 1 });
    await safeCreateIndex(models.trash, { trackingCode: 1 });
    await safeCreateIndex(models.trash, { deletedAt: 1 });
    console.log('[DB] ✅ Trash indexes ready');
  }

  if (models.owner_trash) {
    await safeCreateIndex(models.owner_trash, { originalId: 1 });
    await safeCreateIndex(models.owner_trash, { trackingCode: 1 });
    await safeCreateIndex(models.owner_trash, { deletedAt: 1 });
    console.log('[DB] ✅ Owner Trash indexes ready');
  }
}

async function insertOne(collection, doc) {
  if (USE_MONGODB && models[collection]) {
    try {
      const result = await models[collection].create(doc);
      return result?.toObject?.() || result;
    } catch (err) {
      console.error(`[DB] MongoDB insertOne error (${collection}): ${err.message}`);
    }
  }
  let all = readJSON(collection);
  // ✅ v5.3: Array ensure
  if (!Array.isArray(all)) all = [];
  all.unshift(doc);
  writeJSON(collection, all);
  return doc;
}

async function updateOne(collection, id, updates) {
  if (!id) return null;
  const stringId = id?.toString?.() || id;
  const updateDoc = { ...updates, updated_at: new Date().toISOString() };
  if (USE_MONGODB && models[collection]) {
    try {
      const doc = await models[collection].findOneAndUpdate({ _id: stringId }, { $set: updateDoc }, { new: true }).lean();
      return doc || null;
    } catch (err) {
      console.error(`[DB] MongoDB updateOne error (${collection}): ${err.message}`);
    }
  }
  let all = readJSON(collection);
  if (!Array.isArray(all)) all = [];
  const index = all.findIndex(item => (item._id?.toString?.() || item._id) === stringId || (item._id?.toString?.() || item._id) === id);
  if (index === -1) return null;
  all[index] = { ...all[index], ...updateDoc };
  writeJSON(collection, all);
  return all[index];
}

async function deleteOne(collection, id) {
  if (!id) return null;
  const stringId = id?.toString?.() || id;
  if (USE_MONGODB && models[collection]) {
    try {
      const doc = await models[collection].findOneAndDelete({ _id: stringId }).lean();
      return doc || null;
    } catch (err) {
      console.error(`[DB] MongoDB deleteOne error (${collection}): ${err.message}`);
    }
  }
  let all = readJSON(collection);
  if (!Array.isArray(all)) all = [];
  const index = all.findIndex(item => (item._id?.toString?.() || item._id) === stringId || (item._id?.toString?.() || item._id) === id);
  if (index === -1) return null;
  const deleted = all.splice(index, 1)[0];
  writeJSON(collection, all);
  return deleted;
}

async function findOne(collection, filter = {}) {
  if (USE_MONGODB && models[collection]) {
    try { return await models[collection].findOne(filter).lean(); }
    catch (err) { console.error(`[DB] MongoDB findOne error (${collection}): ${err.message}`); }
  }
  const all = readJSON(collection);
  if (!Array.isArray(all)) return null;
  return all.find(item => matchesFilter(item, filter)) || null;
}

async function exists(collection, filter = {}) {
  return !!(await findOne(collection, filter));
}

async function find(collection, filter = {}, options = {}) {
  if (USE_MONGODB && models[collection]) {
    try {
      let query = models[collection].find(filter);
      if (options.limit) query = query.limit(resolveLimit(options.limit));
      if (options.skip) query = query.skip(options.skip);
      if (options.sort) query = query.sort(options.sort);
      return await query.lean();
    } catch (err) {
      console.error(`[DB] MongoDB find error (${collection}): ${err.message}`);
    }
  }

  let all = readJSON(collection);
  if (!Array.isArray(all)) all = [];
  if (Object.keys(filter).length > 0) {
    all = all.filter(item => matchesFilter(item, filter));
  }

  if (options.sort) {
    const sortEntries = Object.entries(options.sort);
    if (sortEntries.length > 0) {
      const [sortKey, sortDir] = sortEntries[0];
      all.sort((a, b) => {
        const aVal = new Date(a[sortKey] || 0).getTime();
        const bVal = new Date(b[sortKey] || 0).getTime();
        return sortDir === -1 ? bVal - aVal : aVal - bVal;
      });
    }
  }

  if (options.skip) all = all.slice(options.skip);
  if (options.limit !== undefined && options.limit !== null && options.limit !== false) {
    all = all.slice(0, resolveLimit(options.limit));
  }

  return all;
}

async function read(collection) {
  return await find(collection);
}

async function write(collection, data) {
  if (USE_MONGODB && models[collection]) {
    try {
      await models[collection].deleteMany({});
      if (Array.isArray(data) && data.length > 0) await models[collection].insertMany(data);
      return data;
    } catch (err) { console.error(`[DB] MongoDB write error (${collection}): ${err.message}`); }
  }
  writeJSON(collection, data);
  return data;
}

async function deleteAll(collection) {
  if (USE_MONGODB && models[collection]) {
    try { await models[collection].deleteMany({}); return; }
    catch (err) { console.error(`[DB] MongoDB deleteAll error (${collection}): ${err.message}`); }
  }
  writeJSON(collection, []);
}

async function findById(collection, id) { return await findOne(collection, { _id: id?.toString?.() || id }); }
async function findByIdAndUpdate(collection, id, updates) { return await updateOne(collection, id, updates); }
async function findByIdAndDelete(collection, id) { return await deleteOne(collection, id); }

async function count(collection, filter = {}) {
  if (USE_MONGODB && models[collection]) {
    try { return await models[collection].countDocuments(filter); }
    catch (err) { console.error(`[DB] MongoDB count error (${collection}): ${err.message}`); }
  }
  const all = await find(collection, filter);
  return all.length;
}

async function distinct(collection, field) {
  if (USE_MONGODB && models[collection]) {
    try { return await models[collection].distinct(field); }
    catch (err) { console.error(`[DB] MongoDB distinct error (${collection}): ${err.message}`); }
  }
  const all = readJSON(collection);
  if (!Array.isArray(all)) return [];
  return [...new Set(all.map(item => item[field]).filter(Boolean))];
}

async function health() {
  if (USE_MONGODB) {
    try {
      const state = mongoose.connection.readyState;
      if (state === 1) return { status: 'ok', type: 'mongodb', database: 'atlas' };
      return { status: 'connecting', type: 'mongodb', database: 'atlas', state };
    } catch (err) { return { status: 'error', type: 'mongodb', database: 'atlas', message: err.message }; }
  }
  return { status: 'ok', type: 'json', database: 'local' };
}

async function close() {
  if (USE_MONGODB) {
    try { await mongoose.connection.close(); console.log('[DB] MongoDB connection closed'); }
    catch (err) { console.error('[DB] MongoDB close error:', err.message); }
  } else { console.log('[DB] Connection closed (JSON mode — nothing to close)'); }
}

const db = {};

COLLECTIONS.forEach(col => {
  db[col] = {
    read: () => read(col),
    write: (data) => write(col, data),
    insertOne: (doc) => insertOne(col, doc),
    updateOne: (id, updates) => updateOne(col, id, updates),
    deleteOne: (id) => deleteOne(col, id),
    findOne: (filter) => findOne(col, filter),
    find: (filter, options) => find(col, filter, options),
    exists: (filter) => exists(col, filter),
    findById: (id) => findById(col, id),
    findByIdAndUpdate: (id, updates) => findByIdAndUpdate(col, id, updates),
    findByIdAndDelete: (id) => findByIdAndDelete(col, id),
    count: (filter) => count(col, filter),
    distinct: (field) => distinct(col, field),
    deleteAll: () => deleteAll(col),
    get _col() { return null; }
  };
});

db.connect = async () => {
  if (USE_MONGODB) {
    try {
      defineSchemas();
      buildModels();
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      console.log('[DB] ✅ MongoDB Atlas connected (production mode)');
      await createIndexes();
    } catch (err) {
      console.error('[DB] MongoDB connection failed, falling back to JSON:', err.message);
      USE_MONGODB = false;
      console.log('[DB] ✅ JSON File DB ready (fallback mode)');
    }
  } else {
    console.log('[DB] ✅ JSON File DB ready (local mode)');
  }
};
db.health = health;
db.close = close;
db.readJSON = (collection) => readJSON(collection);
db.writeJSON = (collection, data) => writeJSON(collection, data);
db.deleteAll = (collection) => deleteAll(collection);
db.createIndexes = createIndexes;
db.matchesFilter = matchesFilter;
db.matchesOperator = matchesOperator;

db.connect();

module.exports = db;