// ============================================================
// MEGA TOOLS — FULL DATA WIPE (Owner Preservation)
// Wipes: users (except owner), sessions, trash, owner_trash,
//        referrals, globalTimer reset
// Safe: backup before wipe, owner preserved
// ============================================================
require('dotenv').config({ path: require('path').join(__dirname, '.env.wipe') });
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'megamastartools';
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(__dirname, 'data', '_wipe_backup_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing in .env');
  process.exit(1);
}

async function main() {
  console.log('============================================================');
  console.log('MEGA TOOLS — FULL DATA WIPE (Owner Preservation)');
  console.log('============================================================');
  console.log('MongoDB DB:', MONGODB_DB);
  console.log('Backup dir:', BACKUP_DIR);
  console.log('');

  // 1) Create backup dir
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    console.log('[1/8] MongoDB connected ✅');

    const db = client.db(MONGODB_DB);

    // 2) Backup all collections
    console.log('[2/8] Backing up collections...');
    const collections = ['users', 'sessions', 'trash', 'owner_trash', 'referrals', 'globalTimer'];
    for (const col of collections) {
      try {
        const data = await db.collection(col).find({}).toArray();
        fs.writeFileSync(path.join(BACKUP_DIR, `${col}.json`), JSON.stringify(data, null, 2));
        console.log(`   ✅ ${col}: ${data.length} docs → backup`);
      } catch (e) {
        console.log(`   ⚠️  ${col}: ${e.message}`);
      }
    }

    // 3) Find owner(s)
    console.log('[3/8] Finding owner(s)...');
    const owners = await db.collection('users').find({ role: 'owner' }).toArray();
    console.log(`   Found ${owners.length} owner(s)`);
    if (owners.length === 0) {
      console.error('❌ No owner found! Aborting to prevent total lockout.');
      process.exit(1);
    }
    owners.forEach(o => console.log(`   - ${o.email} (${o.username})`));

    // 4) Delete non-owner users
    console.log('[4/8] Deleting non-owner users...');
    const delUsers = await db.collection('users').deleteMany({ role: { $ne: 'owner' } });
    console.log(`   ✅ Deleted ${delUsers.deletedCount} users`);

    // 5) Wipe sessions, trash, owner_trash, referrals
    console.log('[5/8] Wiping sessions, trash, owner_trash, referrals...');
    for (const col of ['sessions', 'trash', 'owner_trash', 'referrals']) {
      const r = await db.collection(col).deleteMany({});
      console.log(`   ✅ ${col}: deleted ${r.deletedCount}`);
    }

    // 6) Reset globalTimer
    console.log('[6/8] Resetting globalTimer...');
    await db.collection('globalTimer').deleteMany({});
    console.log('   ✅ globalTimer cleared (will re-init on next server request)');

    // 7) Sync local JSON files
    console.log('[7/8] Syncing local JSON files...');
    const syncMap = {
      'users': 'users.json',
      'sessions': 'sessions.json',
      'trash': 'trash.json',
      'owner_trash': 'owner_trash.json',
      'referrals': 'referrals.json',
      'globalTimer': 'globalTimer.json',
    };
    for (const [col, file] of Object.entries(syncMap)) {
      try {
        const data = await db.collection(col).find({}).toArray();
        const cleanData = data.map(d => { const { _id, ...rest } = d; return { _id: String(_id), ...rest }; });
        fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(cleanData, null, 2));
        console.log(`   ✅ ${file}: ${cleanData.length} docs`);
      } catch (e) {
        console.log(`   ⚠️  ${file}: ${e.message}`);
      }
    }

    // 8) Final state
    console.log('[8/8] Verifying final state...');
    const finalUsers = await db.collection('users').countDocuments();
    const finalSessions = await db.collection('sessions').countDocuments();
    const finalTrash = await db.collection('trash').countDocuments();
    const finalOwnerTrash = await db.collection('owner_trash').countDocuments();
    console.log('');
    console.log('════════════════════════════════════════════════');
    console.log('FINAL STATE');
    console.log('════════════════════════════════════════════════');
    console.log(`  Users:       ${finalUsers} (expect: ${owners.length} owner)`);
    console.log(`  Sessions:    ${finalSessions} (expect: 0)`);
    console.log(`  Trash:       ${finalTrash} (expect: 0)`);
    console.log(`  Owner trash: ${finalOwnerTrash} (expect: 0)`);
    console.log('');
    console.log('✅ WIPE COMPLETE');
    console.log('Backup saved to:', BACKUP_DIR);
    console.log('════════════════════════════════════════════════');
  } catch (err) {
    console.error('❌ ERROR:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();

