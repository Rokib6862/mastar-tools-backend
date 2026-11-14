const { MongoClient } = require("mongodb");
const uri = "mongodb://mega_master_tools_db_user:112233Rk@ac-e6fbgph-shard-00-00.ketrbd3.mongodb.net:27017,ac-e6fbgph-shard-00-01.ketrbd3.mongodb.net:27017,ac-e6fbgph-shard-00-02.ketrbd3.mongodb.net:27017/megamastartools?ssl=true&replicaSet=atlas-e6fbgph-shard-0&authSource=admin&retryWrites=true&w=majority";
const dbName = "megamastartools";

(async () => {
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await c.connect();
  const db = c.db(dbName);
  const col = db.collection("globalTimer");

  console.log("BEFORE:", JSON.stringify(await col.find({}).toArray()));
  await col.deleteMany({});
  console.log("CLEARED");

  const now = Date.now();
  const BD = 6 * 3600000;
  const bdMs = now + BD;
  const d = new Date(bdMs);
  const noonBdUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0) - BD;
  const cycleEnd = now >= noonBdUtc ? noonBdUtc + 86400000 : noonBdUtc;

  const state = {
    _id: "globalTimer_singleton",
    cycleStart: now,
    cycleEnd: cycleEnd,
    lastCleanupAt: null,
    cleanupInProgress: false,
  };

  await col.insertOne(state);
  console.log("INSERTED:", JSON.stringify(state, null, 2));

  const verify = await col.findOne({ _id: "globalTimer_singleton" });
  console.log("cycleStart type:", typeof verify.cycleStart, "value:", verify.cycleStart);
  console.log("cycleEnd type:", typeof verify.cycleEnd, "value:", verify.cycleEnd);
  console.log("delta_hours:", ((verify.cycleEnd - verify.cycleStart) / 3600000).toFixed(2));

  await c.close();
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });