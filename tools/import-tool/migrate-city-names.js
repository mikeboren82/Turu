// TuRu - מיגרציה חד-פעמית: מנרמלת את locations.city לצורה הקנונית (cityNaming.js) על כל
// המיקומים הקיימים - לא רק גני שעשועים, כל האפליקציה (הבעיה כללית: OSM/Nominatim/AI-extraction/
// הזנה ידנית כולם כתבו וריאציות איות שונות). לא ממזגת שורות locations - רק מתקנת את הטקסט
// בעמודת city בכל שורה, כך שספירה/סינון לפי עיר יתקבצו נכון בעתיד.
//
// ברירת מחדל: dry-run בלבד. --apply מבצע בפועל. Idempotent - שם שכבר קנוני לא משתנה שוב.
require('dotenv').config();
const { getClient } = require('./supabase');
const { normalizeCityName } = require('./cityNaming');

const APPLY = process.argv.includes('--apply');
const PREVIEW_COUNT = 30;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function updateWithRetry(client, id, patch, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const { error } = await client.from('locations').update(patch).eq('id', id);
    if (!error) return null;
    lastError = error;
    if (i < attempts - 1) await sleep(500 * (i + 1));
  }
  return lastError;
}

async function main() {
  console.log(`=== מיגרציית נרמול שמות ערים - TuRu (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const { client } = await getClient();

  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from('locations')
      .select('id, city')
      .not('city', 'is', null)
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`נמצאו ${all.length} מיקומים עם city לא-ריק.\n`);

  const changes = all
    .map((loc) => ({ loc, normalized: normalizeCityName(loc.city) }))
    .filter((r) => r.normalized && r.normalized !== r.loc.city);

  const byOldNew = new Map();
  for (const r of changes) {
    const key = `${r.loc.city} -> ${r.normalized}`;
    byOldNew.set(key, (byOldNew.get(key) || 0) + 1);
  }

  console.log('=== סטטיסטיקה ===');
  console.log(`סה"כ מיקומים: ${all.length}`);
  console.log(`ישונו: ${changes.length}`);
  console.log(`וריאציות-איות ייחודיות שיתוקנו: ${byOldNew.size}\n`);

  console.log(`=== PREVIEW (עד ${PREVIEW_COUNT} וריאציות, עם מספר רשומות מושפעות) ===`);
  [...byOldNew.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PREVIEW_COUNT)
    .forEach(([key, count]) => console.log(`  ${key}  (${count} רשומות)`));

  if (!APPLY) {
    console.log('\n(dry run) לא בוצע שום שינוי. הריצו עם --apply כדי לבצע בפועל.');
    return;
  }

  console.log('\n=== מבצע שינויים בפועל ===');
  let updated = 0;
  let failed = 0;
  for (const { loc, normalized } of changes) {
    const error = await updateWithRetry(client, loc.id, { city: normalized });
    if (error) {
      failed++;
      console.error(`נכשל: ${loc.city} -> ${normalized} (${loc.id}) - ${error.message}`);
    } else {
      updated++;
    }
  }

  console.log('\n=== APPLY SUMMARY ===');
  console.log(`עודכנו: ${updated}`);
  console.log(`נכשלו: ${failed}`);
  console.log('DONE');
}

main().catch((e) => { console.error('שגיאה קריטית:', e); process.exit(1); });
