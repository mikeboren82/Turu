// TuRu - מיגרציה: מחליפה שמות גנריים-מבוססי-אזור ("גן שעשועים - ירושלים והסביבה") בשם תיאורי
// מבוסס-מיקום אמיתי, כולל מספר בית כשקיים ("גן שעשועים – הרצל 25, חיפה"), על כל גני השעשועים
// הקיימים כרגע ב-DB. אותה פונקציה בדיוק כמו import-playgrounds-osm.js (playgroundNaming.js) -
// "לא לשכפל לוגיקה".
//
// גרסה שנייה: הרצה קודמת (2026-09-10 מוקדם יותר) כבר עדכנה 3859 רשומות לפורמט הישן ("...ברחוב
// X, עיר", בלי מספר בית, בלי name_source). ההרצה הזו משדרגת גם אותן לפורמט החדש - מזהה אותן
// לפי name_source IS NULL AND original_source_name IS NOT NULL (כבר עברו מיגרציה פעם, יש להן
// original לחזור אליו) ומחשבת מחדש מה-address המקורי, לא "מתקנת טקסט" על השם הישן. רשומה עם
// name_source='admin_confirmed' לעולם לא נוגעים בה (סעיף 9/14 בבקשה - שם שמנהל אישר > הכל).
//
// ברירת מחדל: dry-run בלבד (מדפיס דוח, לא כותב כלום). --apply מבצע בפועל.
// Idempotent: הרצה שלישית על התוצאה לא תשנה כלום - שם שכבר בפורמט החדש מסווג tier='official'
// (לא תואם אף דפוס גנרי) ולא נוגעים בו.
require('dotenv').config();
const { getClient } = require('./supabase');
const { generatePlaygroundDisplayName, isGenericPlaygroundName } = require('./playgroundNaming');

const APPLY = process.argv.includes('--apply');
const PREVIEW_COUNT = 20;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ~5700 קריאות רשת רצופות על המכונה הזו נתקלות לפעמים ב"TypeError: fetch failed" חולף (נצפה
// בפועל בהרצה קודמת - 3128/5474 נכשלו ככה, לא שגיאת-נתונים) - כנראה יציבות-רשת, לא קשור
// לתוכן הבקשה. רטריי קצר עם backoff לפני שמוותרים ורושמים כישלון אמיתי.
async function updateWithRetry(client, id, patch, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const { error } = await client.from('activities').update(patch).eq('id', id);
    if (!error) return null;
    lastError = error;
    if (i < attempts - 1) await sleep(500 * (i + 1));
  }
  return lastError;
}

async function main() {
  console.log(`=== מיגרציית שמות גני שעשועים - TuRu (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const { client } = await getClient();

  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from('activities')
      .select('id, name, category, name_source, original_source_name, location:locations(address, city, region)')
      .eq('category', 'גן שעשועים')
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`נמצאו ${all.length} גני שעשועים.\n`);

  const rows = all.map((a) => {
    if (a.name_source === 'admin_confirmed') {
      return { activity: a, name: a.name, tier: 'admin_confirmed', nameSource: 'admin_confirmed', changes: false, protected: true };
    }
    // רשומה שכבר עברה מיגרציה בהרצה קודמת (יש לה original_source_name, אין עדיין name_source
    // כי העמודה חדשה) - מחשבים מחדש מה-address האמיתי, לא מה-name הנוכחי (שהוא כבר תוצר-מיגרציה
    // ישן, לא "שם רשמי" אמיתי לבדוק גנריות עליו).
    const alreadyMigrated = !a.name_source && !!a.original_source_name;
    const officialName = alreadyMigrated ? null : a.name;
    const result = generatePlaygroundDisplayName({
      officialName, address: a.location?.address, city: a.location?.city,
    });
    const wasGeneric = alreadyMigrated || isGenericPlaygroundName(a.name);
    const changes = result.name && result.name !== a.name;
    return { activity: a, ...result, wasGeneric, changes, alreadyMigrated, protected: false };
  });

  const byTier = { official: 0, street: 0, city: 0, no_data: 0, admin_confirmed: 0 };
  let changed = 0;
  let noDataCount = 0;
  let alreadyOfficial = 0;
  for (const r of rows) {
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    if (r.changes) changed++;
    else if (r.tier === 'no_data') noDataCount++;
    else alreadyOfficial++;
  }

  console.log('=== סטטיסטיקה ===');
  console.log(`סה"כ גני שעשועים: ${rows.length}`);
  console.log(`כבר בעלי שם רשמי/תקין (ללא שינוי): ${byTier.official}`);
  console.log(`מוגנים ע"י אישור-מנהל (name_source='admin_confirmed', לא נוגעים): ${byTier.admin_confirmed}`);
  console.log(`ישונו לשם מבוסס-רחוב: ${rows.filter((r) => r.changes && r.tier === 'street').length}`);
  console.log(`ישונו לשם מבוסס-עיר: ${rows.filter((r) => r.changes && r.tier === 'city').length}`);
  console.log(`סה"כ ישונו: ${changed}`);
  console.log(`לא ניתן היה לשנות בגלל חוסר כתובת (מסומן לבדיקה): ${noDataCount}`);

  console.log(`\n=== PREVIEW (עד ${PREVIEW_COUNT} דוגמאות) ===`);
  rows.filter((r) => r.changes).slice(0, PREVIEW_COUNT).forEach((r) => {
    console.log(`  ישן: ${r.activity.name}\n  חדש: ${r.name}  [tier=${r.tier}]\n`);
  });
  if (noDataCount > 0) {
    console.log(`דוגמאות לרשומות ללא כתובת מספיקה (מסומנות לבדיקה, עד 5):`);
    rows.filter((r) => r.tier === 'no_data').slice(0, 5).forEach((r) => {
      console.log(`  ${r.activity.name}  (id=${r.activity.id}, אין city/street ב-location)`);
    });
  }

  if (!APPLY) {
    console.log('\n(dry run) לא בוצע שום שינוי. הריצו עם --apply כדי לבצע בפועל.');
    return;
  }

  console.log('\n=== מבצע שינויים בפועל ===');
  let updated = 0;
  let failed = 0;
  const auditLog = [];
  for (const r of rows) {
    if (!r.changes) continue;
    const patch = { name: r.name, name_source: r.nameSource };
    // שומר את השם המקורי-מקורי רק בפעם הראשונה שהוא באמת משתנה - לא דורס אותו ברשומות
    // שכבר עברו מיגרציה פעם (original_source_name כבר מחזיק את השם *האמיתי* מלפני כל מיגרציה,
    // לא את התוצר-הביניים בפורמט הישן).
    if (!r.activity.original_source_name) patch.original_source_name = r.activity.name;
    const error = await updateWithRetry(client, r.activity.id, patch);
    // הרצה קודמת (בלי ה-delay הזה) נתקלה ב"TypeError: fetch failed" ב-70%+ מהבקשות - סבב
    // רצוף בלי שום מרווח, לא בעיית-תוכן. מרווח קצר בין בקשות (לא רק ברטריי) הוא המיטיגציה
    // המקובלת לתשישות-חיבורים/פורטים-זמניים בריצה עם אלפי fetch רצופים.
    await sleep(80);
    if (error) {
      failed++;
      console.error(`נכשל: ${r.activity.name} (${r.activity.id}) - ${error.message}`);
    } else {
      updated++;
      auditLog.push({
        activity_id: r.activity.id, old_name: r.activity.name, new_name: r.name,
        tier: r.tier, name_source: r.nameSource, timestamp: new Date().toISOString(),
        reason: 'Generated descriptive playground name because no official name was available.',
      });
    }
  }

  // רשומות עם שם רשמי אמיתי שעדיין אין להן name_source (legacy, מלפני העמודה) - ממלאים
  // 'official' כדי שההרצה הבאה (ואישור-מנהל עתידי) ידעו שזה לא-לגעת בלי לעבור שוב על כל הרשומות.
  const needsOfficialBackfill = rows.filter((r) => !r.changes && !r.protected && !r.activity.name_source && r.tier === 'official');
  let backfilled = 0;
  for (const r of needsOfficialBackfill) {
    const { error } = await client.from('activities').update({ name_source: 'official' }).eq('id', r.activity.id);
    if (!error) backfilled++;
  }

  console.log('\n=== APPLY SUMMARY ===');
  console.log(`עודכנו: ${updated}`);
  console.log(`נכשלו: ${failed}`);
  console.log(`name_source='official' מולא-בדיעבד לרשומות עם שם תקין קיים: ${backfilled}`);

  const fs = require('fs');
  const auditPath = `${__dirname}/_playground-name-migration-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(auditPath, JSON.stringify(auditLog, null, 2), 'utf-8');
  console.log(`Audit log נשמר ב: ${auditPath}`);
  console.log('DONE');
}

main().catch((e) => { console.error('שגיאה קריטית:', e); process.exit(1); });
