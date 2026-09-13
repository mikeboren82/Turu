// TuRu - "THE CLEANER" admin page: backlog / processing / resolved / archived with reasons, attempts,
// last attempt, next retry. Deliberately plain (operate & inspect only). Data from /api/cleaner/*.
const { renderNav, NAV_STYLES } = require('./nav');

function renderCleanerPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - THE CLEANER</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&display=swap">
<style>
  * { box-sizing: border-box; }
  ${NAV_STYLES}
  body { margin: 0; background: oklch(0.985 0.004 230); font-family: 'Assistant', 'Segoe UI', Arial, sans-serif; color: oklch(0.22 0.02 240); }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 16px; font-weight: 800; margin: 0 0 14px; color: oklch(0.4 0.02 235); }
  h2 { font-size: 14px; margin: 22px 0 8px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .tile { background: white; border: 1px solid oklch(0.9 0.01 230); border-radius: 12px; padding: 10px 14px; }
  .tile b { display: block; font-size: 22px; }
  .tile span { font-size: 12px; color: oklch(0.5 0.02 235); }
  table { width: 100%; border-collapse: collapse; background: white; border: 1px solid oklch(0.9 0.01 230); border-radius: 12px; overflow: hidden; font-size: 12.5px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid oklch(0.94 0.01 230); text-align: right; vertical-align: top; }
  th { background: oklch(0.96 0.01 230); font-weight: 700; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  select, input { border: 1px solid oklch(0.88 0.01 230); border-radius: 8px; padding: 6px 10px; font-family: inherit; }
  .muted { color: oklch(0.55 0.02 235); }
  code { font-size: 11px; direction: ltr; unicode-bidi: embed; }
</style>
</head>
<body>
${renderNav('cleaner')}
<div class="wrap">
  <h1>🧹 THE CLEANER - סגירת מעגלים</h1>
  <div class="tiles" id="tiles"></div>
  <h2>לפי סוג בעיה (פתוחים)</h2><div id="byIssue"></div>
  <h2>סיבות ארכיון</h2><div id="byReason"></div>
  <h2>מקרים</h2>
  <div class="toolbar">
    <select id="status"><option value="open">פתוחים</option><option value="resolved">נפתרו</option><option value="archived">בארכיון</option></select>
    <select id="issue"><option value="">כל הבעיות</option></select>
    <input id="limit" type="number" value="100" min="10" max="500" style="width:90px">
    <button class="btn" id="reload">רענון</button>
    <span class="muted" id="runInfo"></span>
  </div>
  <table><thead><tr><th>סוג</th><th>בעיה</th><th>נושא</th><th>עדיפות</th><th>ניסיונות</th><th>ניסיון אחרון</th><th>ניסיון הבא</th><th>שיטות</th><th>סטטוס / סיבה</th><th>שגיאה אחרונה / פתרון</th></tr></thead><tbody id="rows"></tbody></table>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (d) => d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '-';
async function loadSummary() {
  const s = await (await fetch('/api/cleaner/summary')).json();
  $('tiles').innerHTML = [['פתוחים (backlog)', s.open], ['ממתינים לניסיון', s.due], ['נפתרו', s.resolved], ['בארכיון', s.archived], ['תקועים מעבר לחלון', s.stuck], ['ריצה אחרונה', s.lastRun ? fmt(s.lastRun.finished_at || s.lastRun.started_at) : '-']].map(([l, v]) => '<div class="tile"><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>').join('');
  $('byIssue').innerHTML = '<table><tr><th>בעיה</th><th>פתוחים</th><th>נפתרו</th><th>בארכיון</th></tr>' + Object.entries(s.byIssue).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + (v.open || 0) + '</td><td>' + (v.resolved || 0) + '</td><td>' + (v.archived || 0) + '</td></tr>').join('') + '</table>';
  $('byReason').innerHTML = '<table><tr><th>סיבה</th><th>מקרים</th></tr>' + Object.entries(s.byArchiveReason).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>').join('') + '</table>';
  const issues = Object.keys(s.byIssue); $('issue').innerHTML = '<option value="">כל הבעיות</option>' + issues.map((i) => '<option>' + esc(i) + '</option>').join('');
  if (s.lastRun) $('runInfo').textContent = 'ריצה אחרונה: ' + fmt(s.lastRun.started_at) + ' - ' + JSON.stringify(s.lastRun.counters || {}).slice(0, 160);
}
async function loadCases() {
  const q = new URLSearchParams({ status: $('status').value, issue: $('issue').value, limit: $('limit').value });
  const { items } = await (await fetch('/api/cleaner/cases?' + q)).json();
  $('rows').innerHTML = items.map((c) => '<tr><td>' + esc(c.subject_kind) + '</td><td>' + esc(c.issue) + '</td><td><code>' + esc(c.subject_id.slice(0, 8)) + '</code><br><span class="muted">' + esc(c.subject_label || '') + '</span></td><td>' + c.priority + '</td><td>' + c.attempts + '</td><td>' + fmt(c.last_attempt_at) + '</td><td>' + (c.status === 'open' ? fmt(c.next_attempt_at) : '-') + '</td><td>' + esc((c.methods_tried || []).join(', ')) + '</td><td>' + esc(c.status) + (c.archive_reason ? '<br><b>' + esc(c.archive_reason) + '</b>' : '') + '</td><td class="muted">' + esc(c.last_error || (c.resolution ? JSON.stringify(c.resolution).slice(0, 160) : '')) + '</td></tr>').join('') || '<tr><td colspan="10" class="muted">אין מקרים</td></tr>';
}
$('reload').onclick = () => { loadSummary(); loadCases(); };
$('status').onchange = loadCases; $('issue').onchange = loadCases;
loadSummary().then(loadCases);
</script>
</body></html>`;
}
module.exports = { renderCleanerPage };
