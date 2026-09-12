// TuRu - ביקורת חד-פעמית: כמה מ-4,551 הפעילויות שיובאו מ-OpenStreetMap (import-playgrounds-osm.js)
// עדיין קיימות בפועל ב-OSM החי היום, מול כמה שנמחקו/שינו תיוג מאז הייבוא (2026-09-07). נוצר בעקבות
// דיווח משתמש על "ארץ עוץ · פרדסיה" - גן-שעשועים שלא נמצא בגוגל, שהתברר כ-OSM node אמיתי
// (2572156543) אבל ערוך לאחרונה לפני כ-12 שנה, גרסה 2 בלבד, ע"י תורם יחיד - בלי שום אימות נוסף
// לפני שהאפליקציה אישרה אותו אוטומטית (status='approved' ישר, ראו import-playgrounds-osm.js שורה
// 374). לא בודק "האם המקום קיים פיזית" (אי אפשר לדעת את זה מ-OSM) - רק שני איתותים אמיתיים
// וזמינים: (1) ה-node/way/relation עדיין קיים ב-OSM בכלל, (2) הוא עדיין מתויג leisure=playground.
// שניהם "נמחק/שונה מאז הייבוא" - איתות חזק בהרבה מ"העריכה האחרונה ישנה" (שלא מוכיח כלום לבד -
// יש המון גני שעשועים אמיתיים בני 12+ שנה שלא השתנו).

require('dotenv').config();
const { getClient } = require('./supabase');
const fs = require('fs');

const OVERPASS_ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const BATCH_SIZE = 300;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function queryOverpassBatch(type, ids) {
  const query = `[out:json][timeout:120];${type}(id:${ids.join(',')});out tags meta;`;
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            'User-Agent': 'TuRu-KidsApp/1.0 (one-time OSM playground audit; contact: mborenmusic@gmail.com)',
          },
          body: query,
          signal: AbortSignal.timeout(130_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status} מ-${endpoint}`);
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} מ-${endpoint}`);
        const data = await res.json();
        return data.elements || [];
      } catch (err) {
        lastErr = err;
        await sleep(2000 * 2 ** attempt);
      }
    }
  }
  throw lastErr || new Error('כל הניסיונות נכשלו');
}

function parseSourceUrl(url) {
  const m = /openstreetmap\.org\/(node|way|relation)\/(\d+)/.exec(url || '');
  return m ? { type: m[1], id: m[2] } : null;
}

async function main() {
  console.log('=== ביקורת OSM - פעילויות שיובאו מ-OpenStreetMap ===\n');
  const { client } = await getClient();

  let activities = [];
  {
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await client
        .from('activities')
        .select('id, name, status, source_url, created_at, location:locations(city, lat, lng)')
        .eq('source', 'scraped')
        .like('source_url', 'https://www.openstreetmap.org/%')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      activities = activities.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
  }
  console.log(`נטענו ${activities.length} פעילויות מ-DB (source='scraped', OSM source_url)\n`);

  const byType = { node: [], way: [], relation: [] };
  const activityByKey = new Map(); // "type/id" -> activity
  for (const a of activities) {
    const parsed = parseSourceUrl(a.source_url);
    if (!parsed) continue;
    byType[parsed.type]?.push(parsed.id);
    activityByKey.set(`${parsed.type}/${parsed.id}`, a);
  }

  const liveByKey = new Map(); // "type/id" -> { tags, timestamp }
  for (const type of ['node', 'way', 'relation']) {
    const ids = byType[type];
    if (ids.length === 0) continue;
    console.log(`שולף ${ids.length} ${type}(s) מ-Overpass החי, ב-batches של ${BATCH_SIZE}...`);
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      try {
        const elements = await queryOverpassBatch(type, batch);
        for (const el of elements) {
          liveByKey.set(`${type}/${el.id}`, { tags: el.tags || {}, timestamp: el.timestamp || null });
        }
        console.log(`  ${type} batch ${i / BATCH_SIZE + 1}: ${elements.length}/${batch.length} עדיין קיימים`);
      } catch (err) {
        console.log(`  ⚠️ ${type} batch ${i / BATCH_SIZE + 1} נכשל לגמרי: ${err.message} - מדלג (לא מסמן כמחוק, רק "לא נבדק")`);
      }
      await sleep(1500);
    }
  }

  const deleted = [];
  const retagged = [];
  const staleOld = []; // עדיין קיים+מתויג נכון, אבל timestamp ישן מאוד - לא הוכחה, רק סימון-משני
  const okCount = { count: 0 };
  const notChecked = [];
  const STALE_YEARS = 8;
  const staleCutoff = Date.now() - STALE_YEARS * 365 * 86400_000;

  for (const [key, a] of activityByKey) {
    const live = liveByKey.get(key);
    if (!live) { notChecked.push({ key, ...a }); continue; }
    if (!live.tags.leisure || live.tags.leisure !== 'playground') {
      retagged.push({ key, id: a.id, name: a.name, city: a.location?.city, currentTags: live.tags });
      continue;
    }
    okCount.count++;
    if (live.timestamp && new Date(live.timestamp).getTime() < staleCutoff) {
      staleOld.push({ key, id: a.id, name: a.name, city: a.location?.city, lastEdited: live.timestamp });
    }
  }
  // מה שלא הוחזר מ-Overpass בכלל (לא ב-liveByKey) ולא notChecked (batch שכן רץ בהצלחה) = נמחק.
  for (const [key, a] of activityByKey) {
    if (!liveByKey.has(key) && !notChecked.find((n) => n.key === key)) {
      deleted.push({ key, id: a.id, name: a.name, city: a.location?.city, sourceUrl: a.source_url });
    }
  }

  console.log('\n=== סיכום ===');
  console.log(`סה"כ נבדקו: ${activityByKey.size}`);
  console.log(`✅ עדיין קיימים ומתויגים leisure=playground: ${okCount.count}`);
  console.log(`❌ נמחקו לגמרי מ-OSM מאז הייבוא: ${deleted.length}`);
  console.log(`⚠️ עדיין קיימים אבל כבר לא מתויגים playground (שונה יעוד/תוקן): ${retagged.length}`);
  console.log(`🕰️ קיימים+תקינים אבל נערכו לאחרונה לפני ${STALE_YEARS}+ שנים (לא הוכחה - רק דגל למעקב): ${staleOld.length}`);
  console.log(`⏭️ לא נבדקו (batch נכשל לגמרי) : ${notChecked.length}`);

  const report = { deleted, retagged, staleOld, notChecked, generatedAt: new Date().toISOString() };
  fs.writeFileSync('osm-audit-report.json', JSON.stringify(report, null, 2));
  console.log('\nדוח מלא נשמר ב-tools/import-tool/osm-audit-report.json');
}

main().catch((err) => {
  console.error('\n🛑 שגיאה קריטית:', err);
  process.exit(1);
});
