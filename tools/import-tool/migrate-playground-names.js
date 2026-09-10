// TuRu - מיגרציה חד-פעמית: מחליפה שמות גנריים-מבוססי-אזור ("גן שעשועים - ירושלים והסביבה")
// בשם תיאורי מבוסס-מיקום אמיתי ("גן שעשועים ברחוב תל חי, ירושלים"), על כל גני השעשועים
// הקיימים כרגע ב-DB. אותה פונקציית generatePlaygroundDisplayName בדיוק כמו import-playgrounds-
// osm.js (playgroundNaming.js) - "לא לשכפל לוגיקה".
//
// ברירת מחדל: dry-run בלבד (מדפיס דוח, לא כותב כלום). --apply מבצע בפועל.
// Idempotent: הרצה שנייה על אותם נתונים לא משנה כלום - שם שכבר "נראה אמיתי" (לא תואם את דפוסי
// השם-הגנרי הידועים) מסווג tier='official' ולא נוגעים בו.
require('dotenv').config();
const { getClient } = require('./supabase');
const { generatePlaygroundDisplayName, isGenericPlaygroundName } = require('./playgroundNaming');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`=== מיגרציית שמות גני שעשועים - TuRu (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const { client } = await getClient();

  let all = [];
  let from = 0;
  while (true) {
    // original_source_name (מיגרציה 0056) לא נקרא כאן בכוונה - כך ה-dry-run עובד גם לפני
    // שהעמודה קיימת ב-DB; רק --apply באמת צריך אותה (ואז ינחש null אם העמודה עדיין לא הורצה,
    // ראו למטה - "!r.activity.original_source_name" יתנהג כ-true תמיד וזה עדיין נכון/בטוח).
    const { data, error } = await client
      .from('activities')
      .select('id, name, category, location:locations(address, city, region)')
      .eq('category', 'גן שעשועים')
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`נמצאו ${all.length} גני שעשועים.\n`);

  const rows = all.map((a) => {
    const result = generatePlaygroundDisplayName({
      officialName: a.name, address: a.location?.address, city: a.location?.city,
    });
    const wasGeneric = isGenericPlaygroundName(a.name);
    const changes = result.name && result.name !== a.name;
    return { activity: a, ...result, wasGeneric, changes };
  });

  const byTier = { official: 0, street: 0, city: 0, no_data: 0 };
  let changed = 0;
  let noDataCount = 0;
  let alreadyOfficial = 0;
  for (const r of rows) {
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    if (r.changes) changed++;
    else if (r.tier === 'no_data') noDataCount++;
    else alreadyOfficial++;
  }

  console.log('=== DRY RUN SUMMARY ===');
  console.log(`סה"כ גני שעשועים: ${rows.length}`);
  console.log(`כבר בעלי שם רשמי/תקין (ללא שינוי): ${alreadyOfficial}`);
  console.log(`ישונו לשם מבוסס-רחוב: ${rows.filter((r) => r.changes && r.tier === 'street').length}`);
  console.log(`ישונו לשם מבוסס-עיר: ${rows.filter((r) => r.changes && r.tier === 'city').length}`);
  console.log(`סה"כ ישונו: ${changed}`);
  console.log(`לא ניתן היה לשנות בגלל חוסר מידע (NO_CHANGE, מסומן לבדיקה): ${noDataCount}`);

  console.log('\nדוגמאות (עד 15):');
  rows.filter((r) => r.changes).slice(0, 15).forEach((r) => {
    console.log(`  OLD: ${r.activity.name}\n  NEW: ${r.name}  [tier=${r.tier}]\n`);
  });
  if (noDataCount > 0) {
    console.log(`דוגמאות ל-NO_CHANGE בגלל חוסר מידע (עד 5):`);
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
    const patch = { name: r.name };
    // שומר את השם המקורי רק בפעם הראשונה שהוא באמת משתנה (לא דורס אם כבר נשמר בהרצה קודמת).
    if (!r.activity.original_source_name) patch.original_source_name = r.activity.name;
    const { error } = await client.from('activities').update(patch).eq('id', r.activity.id);
    if (error) {
      failed++;
      console.error(`נכשל: ${r.activity.name} (${r.activity.id}) - ${error.message}`);
    } else {
      updated++;
      auditLog.push({
        activity_id: r.activity.id, old_name: r.activity.name, new_name: r.name,
        tier: r.tier, timestamp: new Date().toISOString(),
        reason: 'Generated descriptive playground name because no official name was available.',
      });
    }
  }

  console.log('\n=== APPLY SUMMARY ===');
  console.log(`עודכנו: ${updated}`);
  console.log(`נכשלו: ${failed}`);

  const fs = require('fs');
  const auditPath = `${__dirname}/_playground-name-migration-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(auditPath, JSON.stringify(auditLog, null, 2), 'utf-8');
  console.log(`Audit log נשמר ב: ${auditPath}`);
  console.log('DONE');
}

main().catch((e) => { console.error('שגיאה קריטית:', e); process.exit(1); });
