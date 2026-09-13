// TuRu - "מקומות" (venues) - minimum operable admin surface for the canonical-venue layer (0076):
// list with aliases / linked activities / linked sources, add venue, add alias, merge two venues.
// Deliberately plain - operate & inspect only, no rich UI (platform brief, adjustment 6).
const { renderNav, NAV_STYLES } = require('./nav');

function renderVenuesPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - מקומות</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Assistant:wght@400;500;600;700;800&display=swap">
<style>
  * { box-sizing: border-box; }
  ${NAV_STYLES}
  body { margin: 0; min-height: 100vh; background: oklch(0.985 0.004 230); font-family: 'Assistant', 'Segoe UI', Arial, sans-serif; color: oklch(0.22 0.02 240); }
  .wrap { max-width: 1000px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0 0 18px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
  .toolbar input, .toolbar select { border: 1px solid oklch(0.88 0.01 230); border-radius: 10px; padding: 8px 12px; font-family: inherit; font-size: 13.5px; }
  .btn { border: 1px solid oklch(0.88 0.01 230); background: white; border-radius: 999px; padding: 6px 14px; font-weight: 700; font-size: 12.5px; cursor: pointer; }
  .btn.primary { background: oklch(0.52 0.11 225); color: white; border-color: transparent; }
  .status { font-size: 13px; color: oklch(0.5 0.02 235); margin: 8px 2px; }
  .card { background: white; border: 1px solid oklch(0.9 0.01 230); border-radius: 14px; padding: 12px 16px; margin-bottom: 10px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05); }
  .card.inactive { opacity: 0.55; }
  .head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .name { font-weight: 800; font-size: 14.5px; }
  .badge { font-size: 10.5px; font-weight: 800; border-radius: 999px; padding: 2px 9px; background: oklch(0.93 0.005 235); color: oklch(0.4 0.02 235); }
  .meta { font-size: 12.5px; color: oklch(0.5 0.02 235); margin-top: 4px; display: flex; flex-wrap: wrap; gap: 12px; }
  .aliases { font-size: 12px; margin-top: 6px; }
  .aliases span { display: inline-block; background: oklch(0.96 0.02 225); border-radius: 8px; padding: 2px 8px; margin: 2px; }
  .actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .form { display: none; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; background: white; border: 1px solid oklch(0.9 0.01 230); border-radius: 14px; padding: 14px; margin-bottom: 14px; }
  .form.open { display: grid; }
  .form input, .form select { width: 100%; border: 1px solid oklch(0.88 0.01 230); border-radius: 10px; padding: 8px 10px; font-family: inherit; font-size: 13px; }
  .form label { font-size: 11.5px; color: oklch(0.5 0.02 235); display: block; margin-bottom: 3px; }
  .form .full { grid-column: 1 / -1; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🏬 מקומות קנוניים (WHERE) - מקום אחד לכל הפעילויות והמקורות שמתקיימים בו</h1>
  ${renderNav('venues')}
  <div class="toolbar">
    <input id="q" type="text" placeholder="חיפוש לפי שם / עיר / כינוי...">
    <select id="typeFilter"><option value="">כל הסוגים</option></select>
    <label><input id="showInactive" type="checkbox"> הצג ממוזגים/לא פעילים</label>
    <button class="btn primary" id="addBtn" type="button">+ מקום חדש</button>
  </div>
  <div class="form" id="form">
    <div><label>שם (עברית)</label><input id="fName"></div>
    <div><label>סוג</label><select id="fType"></select></div>
    <div><label>עיר</label><input id="fCity"></div>
    <div><label>אזור</label><select id="fRegion"><option value="">--</option></select></div>
    <div><label>כתובת</label><input id="fAddress"></div>
    <div><label>רשת/קבוצה</label><input id="fChain"></div>
    <div><label>אתר</label><input id="fWeb" style="direction:ltr"></div>
    <div><label>עמוד אירועים</label><input id="fEvents" style="direction:ltr"></div>
    <div><label>פייסבוק</label><input id="fFb" style="direction:ltr"></div>
    <div><label>אינסטגרם</label><input id="fIg" style="direction:ltr"></div>
    <div class="full"><label>כינויים נוספים (מופרדים בפסיק) - איך מקורות אחרים קוראים למקום</label><input id="fAliases"></div>
    <div class="full actions"><button class="btn primary" id="saveBtn" type="button">שמירה</button><button class="btn" id="cancelBtn" type="button">ביטול</button></div>
  </div>
  <div id="status" class="status">טוען...</div>
  <div id="list"></div>
</div>
<script src="/admin-shared.js"></script>
<script>
  const VENUE_TYPES = ['mall','shopping_center','museum','library','community_center','theater','cultural_center','park','farm','petting_zoo','visitor_center','nature_site','workshop_studio','sports_center','attraction','public_square','other'];
  const TYPE_LABELS = { mall: 'קניון', shopping_center: 'מרכז מסחרי', museum: 'מוזיאון', library: 'ספרייה', community_center: 'מתנ״ס/מרכז קהילתי', theater: 'תיאטרון', cultural_center: 'מרכז תרבות', park: 'פארק', farm: 'חווה', petting_zoo: 'פינת חי', visitor_center: 'מרכז מבקרים', nature_site: 'אתר טבע', workshop_studio: 'סטודיו/סדנאות', sports_center: 'מרכז ספורט', attraction: 'אטרקציה', public_square: 'רחבה/כיכר', other: 'אחר' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let venues = [];
  const $ = (id) => document.getElementById(id);
  $('fType').innerHTML = VENUE_TYPES.map((t) => '<option value="' + t + '">' + TYPE_LABELS[t] + '</option>').join('');
  $('typeFilter').innerHTML += VENUE_TYPES.map((t) => '<option value="' + t + '">' + TYPE_LABELS[t] + '</option>').join('');
  fetch('/api/manage/options').then((r) => r.json()).then((o) => { $('fRegion').innerHTML = '<option value="">--</option>' + (o.region || []).map((r) => '<option>' + esc(r) + '</option>').join(''); });

  async function load() {
    const res = await fetch('/api/venues'); const data = await res.json();
    if (!res.ok) { $('status').textContent = data.error || 'שגיאה'; return; }
    venues = data.venues; render();
  }
  function render() {
    const q = $('q').value.trim().toLowerCase(); const t = $('typeFilter').value; const showInactive = $('showInactive').checked;
    const rows = venues.filter((v) => (showInactive || v.is_active) && (!t || v.venue_type === t) &&
      (!q || [v.name_he, v.city, ...(v.aliases || [])].join(' ').toLowerCase().includes(q)));
    $('status').textContent = rows.length + ' מקומות (' + venues.filter((v) => v.is_active).length + ' פעילים סה״כ).';
    $('list').innerHTML = rows.map((v) => '<div class="card' + (v.is_active ? '' : ' inactive') + '">' +
      '<div class="head"><span class="name">' + esc(v.name_he) + '</span>' +
        '<span class="badge">' + esc(TYPE_LABELS[v.venue_type] || v.venue_type) + '</span>' +
        (v.city ? '<span class="badge">📍 ' + esc(v.city) + '</span>' : '') +
        (v.chain ? '<span class="badge">🏷️ ' + esc(v.chain) + '</span>' : '') +
        (!v.is_active ? '<span class="badge">מוזג/לא פעיל</span>' : '') +
      '</div>' +
      '<div class="meta"><span>פעילויות מקושרות: <b>' + v.activityCount + '</b></span><span>מקורות: <b>' + (v.sources || []).length + '</b>' +
        ((v.sources || []).some((s) => !s.active && ['facebook', 'instagram'].includes(s.kind)) ? ' <span class="badge">📵 רק פייסבוק/אינסטגרם</span>' : '') + '</span>' +
        (v.website_url ? '<a href="' + esc(v.website_url) + '" target="_blank" rel="noopener">אתר</a>' : '') +
        (v.events_url ? '<a href="' + esc(v.events_url) + '" target="_blank" rel="noopener">אירועים</a>' : '') +
        (v.facebook_url ? '<a href="' + esc(v.facebook_url) + '" target="_blank" rel="noopener">פייסבוק</a>' : '') +
        (v.instagram_url ? '<a href="' + esc(v.instagram_url) + '" target="_blank" rel="noopener">אינסטגרם</a>' : '') +
      '</div>' +
      '<div class="aliases">כינויים: ' + (v.aliases || []).map((a) => '<span>' + esc(a) + '</span>').join('') + '</div>' +
      '<div class="actions">' +
        '<button class="btn" data-action="alias" data-id="' + v.id + '">+ כינוי</button>' +
        (v.is_active ? '<button class="btn" data-action="merge" data-id="' + v.id + '">מזג לתוך מקום אחר...</button>' : '') +
      '</div>' +
    '</div>').join('') || '<div class="status">אין מקומות תואמים.</div>';
  }
  $('q').addEventListener('input', render); $('typeFilter').addEventListener('change', render); $('showInactive').addEventListener('change', render);
  $('addBtn').addEventListener('click', () => $('form').classList.toggle('open'));
  $('cancelBtn').addEventListener('click', () => $('form').classList.remove('open'));
  $('saveBtn').addEventListener('click', async () => {
    const body = { name_he: $('fName').value.trim(), venue_type: $('fType').value, city: $('fCity').value.trim() || null, region: $('fRegion').value || null,
      address: $('fAddress').value.trim() || null, chain: $('fChain').value.trim() || null, website_url: $('fWeb').value.trim() || null, events_url: $('fEvents').value.trim() || null,
      facebook_url: $('fFb').value.trim() || null, instagram_url: $('fIg').value.trim() || null, aliases: $('fAliases').value.split(',').map((s) => s.trim()).filter(Boolean) };
    if (!body.name_he) { alert('שם חובה'); return; }
    const res = await fetch('/api/venues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json(); if (!res.ok) { alert(data.error || 'שגיאה'); return; }
    $('form').classList.remove('open'); load();
  });
  $('list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]'); if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'alias') {
      const alias = prompt('כינוי חדש למקום (איך מקור אחר קורא לו):'); if (!alias) return;
      const res = await fetch('/api/venues/' + id + '/alias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias }) });
      if (!res.ok) { alert((await res.json()).error || 'שגיאה'); return; } load();
    }
    if (btn.dataset.action === 'merge') {
      const loser = venues.find((v) => v.id === id);
      const target = prompt('מזג את "' + loser.name_he + '" לתוך המקום ששמו (מדויק):'); if (!target) return;
      const keeper = venues.find((v) => v.is_active && v.id !== id && v.name_he.trim() === target.trim());
      if (!keeper) { alert('לא נמצא מקום פעיל בשם הזה'); return; }
      if (!confirm('למזג? הפעילויות/המקורות/הכינויים של "' + loser.name_he + '" יעברו ל"' + keeper.name_he + '". המקום הממוזג לא נמחק, רק מסומן.')) return;
      const res = await fetch('/api/venues/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keeperId: keeper.id, loserId: id }) });
      if (!res.ok) { alert((await res.json()).error || 'שגיאה'); return; } load();
    }
  });
  load();
</script>
</body>
</html>`;
}

module.exports = { renderVenuesPage };
