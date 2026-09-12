// חד-פעמי: מפעיל ידנית את run_settlement_scan_now() (supabase/0060) - Batch 1 של סריקת-הפערים
// הארצית, לפי בקשת המשתמש (2026-09-12: "התחל לבצע את התוכנית בהדרגה... Batch הראשון בלבד").
// לא מחכים ל-cron היומי (03:00) - מריצים עכשיו כדי לבדוק/לדווח מיד. אותו getClient() בוט
// (role='importer', עובר is_trusted_uploader()) שכל שאר tools/import-tool כבר משתמש בו - לא
// service_role key גולמי (הפונקציה הפנימית _dispatch_settlement_scan דואגת לזה בעצמה מ-Vault).
require('dotenv').config();
const { getClient } = require('./supabase');

(async () => {
  const { client } = await getClient();
  console.log('Calling run_settlement_scan_now()...');
  const { error } = await client.rpc('run_settlement_scan_now');
  if (error) {
    console.error('RPC call failed:', error.message);
    process.exit(1);
  }
  console.log('RPC accepted - dispatch queued via pg_net (async, fire-and-forget). The actual scan runs inside the Edge Function; check automation_settings.settlement_scan_cursor / function logs / the daily email for results.');
})();
