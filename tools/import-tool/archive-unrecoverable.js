// TuRu - מארכב (status='archived', לא מוחק לצמיתות - עקבי עם העיקרון הקיים בכל שאר המערכת:
// cleanup_expired_activities/0028-0029, incoming.js "ארכוב" ל-missing_flagged, וכו') פעילויות
// שבאמת אין שום סיכוי לשחזר להן כתובת: אין להן location בכלל, או יש location בלי גם קואורדינטות
// וגם שם/עיר טקסטואליים - כלום לחפש איתו. לא נוגע בפעילויות עם קואורדינטות אמיתיות שרק אין להן
// שם-רחוב מזוהה (יש להן עדיין מיקום אמיתי ומפה תקינה - "לא ניתן למצוא כתובת" != "אין מיקום").
require('dotenv').config();
const { getClient } = require('./supabase');

async function main() {
  const { client } = await getClient();

  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from('activities')
      .select('id, name, status, location:locations(id, name, city, address, lat, lng)')
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const unrecoverable = all.filter((a) => (
    a.status !== 'archived' &&
    (!a.location || (!a.location.address && a.location.lat == null && !a.location.name && !a.location.city))
  ));

  console.log(`נמצאו ${unrecoverable.length} פעילויות ללא שום אפשרות לשחזר כתובת (לא-ארכיון עדיין).`);
  if (unrecoverable.length === 0) { console.log('DONE - אין מה לארכב.'); return; }

  let archived = 0;
  let failed = 0;
  for (const a of unrecoverable) {
    const { error } = await client.from('activities').update({ status: 'archived' }).eq('id', a.id);
    if (error) { failed++; console.error(`נכשל: ${a.name} - ${error.message}`); }
    else archived++;
  }

  console.log('\n=== ARCHIVE SUMMARY ===');
  console.log(`אורכבו: ${archived}`);
  console.log(`נכשלו: ${failed}`);
  console.log('DONE');
}
main().catch((e) => { console.error('שגיאה קריטית:', e); process.exit(1); });
