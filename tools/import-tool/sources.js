const { renderNav, NAV_STYLES } = require('./nav');

function renderSourcesPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - מקורות מידע</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Assistant:wght@400;500;600;700;800&display=swap">
<style>
  * { box-sizing: border-box; }
  ${NAV_STYLES}
  body {
    margin: 0; min-height: 100vh;
    background: oklch(0.985 0.004 230);
    font-family: 'Assistant', 'Segoe UI', Arial, sans-serif;
    color: oklch(0.22 0.02 240);
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 60px; }
  .logo-lockup { display: flex; align-items: center; gap: 8px; direction: ltr; margin-bottom: 4px; }
  .logo { font-family: 'Fredoka', 'Assistant', sans-serif; font-size: 26px; font-weight: 700; }
  .logo .wab { color: oklch(0.3 0.03 235); }
  .logo .bit { color: oklch(0.52 0.11 225); }
  .top-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0; }

  .kill-switch-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 18px; margin-bottom: 18px; box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06);
  }
  .kill-switch-bar.off { border-color: oklch(0.7 0.15 25); background: oklch(0.98 0.02 25); }
  .kill-label { font-size: 13.5px; font-weight: 700; }
  .kill-sub { font-size: 12px; color: oklch(0.5 0.02 235); margin-top: 2px; }
  .toggle-btn {
    border: none; border-radius: 999px; padding: 9px 18px; font-weight: 800; font-size: 13px;
    cursor: pointer; font-family: inherit;
  }
  .toggle-btn.on { background: oklch(0.55 0.14 150); color: white; }
  .toggle-btn.off { background: oklch(0.55 0.18 25); color: white; }

  .actions-row { display: flex; justify-content: flex-end; margin-bottom: 14px; }
  .primary-btn {
    background: oklch(0.52 0.11 225); color: white; border: none; border-radius: 999px;
    padding: 10px 20px; font-weight: 700; font-size: 13.5px; cursor: pointer; font-family: inherit;
  }
  .secondary-btn {
    background: oklch(0.97 0.005 230); color: oklch(0.35 0.02 235); border: 1px solid oklch(0.88 0.01 230);
    border-radius: 999px; padding: 7px 14px; font-weight: 700; font-size: 12.5px; cursor: pointer; font-family: inherit;
  }
  .danger-btn { background: oklch(0.96 0.05 25); color: oklch(0.5 0.18 25); border: 1px solid oklch(0.85 0.08 25); }

  .status { margin: 12px 2px; font-size: 13.5px; color: oklch(0.5 0.02 235); }
  .status.error { color: oklch(0.5 0.18 25); font-weight: 600; }

  .form-card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 16px;
    padding: 18px; margin-bottom: 18px; box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06);
  }
  .form-title { font-size: 14.5px; font-weight: 800; margin: 0 0 12px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
  .field label { display: block; font-size: 12px; font-weight: 700; color: oklch(0.45 0.02 235); margin-bottom: 4px; }
  .field input[type=text], .field input[type=number], .field select {
    width: 100%; border: 1px solid oklch(0.88 0.01 230); border-radius: 9px; padding: 8px 10px;
    font-family: inherit; font-size: 13px;
  }
  .field.full { grid-column: 1 / -1; }
  .cat-checks { display: flex; flex-wrap: wrap; gap: 5px 10px; max-height: 130px; overflow-y: auto; padding: 6px 2px; }
  .cat-checks label { font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .checkbox-row { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; margin-top: 4px; }
  .form-actions { display: flex; gap: 8px; margin-top: 14px; }

  .source-list { display: flex; flex-direction: column; gap: 10px; }
  .source-card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
  }
  .source-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .source-name { font-size: 14.5px; font-weight: 800; }
  .source-url { font-size: 11.5px; color: oklch(0.5 0.02 235); direction: ltr; text-align: right; }
  .source-url a { color: inherit; }
  .badge { font-size: 10.5px; font-weight: 800; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
  .badge.active { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .badge.paused { background: oklch(0.93 0.005 235); color: oklch(0.5 0.02 235); }
  .badge.trust-HIGH { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .badge.trust-MEDIUM { background: oklch(0.95 0.07 80); color: oklch(0.5 0.13 80); }
  .badge.trust-LOW { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .badge.trust-none { background: oklch(0.93 0.005 235); color: oklch(0.5 0.02 235); }
  .badge.error { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .badge.trusted { background: oklch(0.94 0.08 250); color: oklch(0.45 0.15 260); }
  .source-meta { font-size: 12px; color: oklch(0.5 0.02 235); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .source-meta b { color: oklch(0.3 0.02 240); font-weight: 700; }
  .source-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .logs-panel { margin-top: 10px; padding-top: 10px; border-top: 1px solid oklch(0.95 0.01 230); font-size: 12px; }
  .log-row { display: flex; gap: 8px; flex-wrap: wrap; padding: 4px 0; border-bottom: 1px solid oklch(0.97 0.005 230); }
  .log-row b { color: oklch(0.3 0.02 240); }

  .settings-toggle { font-size: 12.5px; font-weight: 700; color: oklch(0.52 0.11 225); cursor: pointer; text-decoration: underline; margin-bottom: 10px; display: inline-block; }
  #settingsPanel { display: none; }
  #settingsPanel.open { display: block; }
  .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .settings-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: oklch(0.98 0.004 230); border-radius: 9px; padding: 8px 10px; }
  .settings-field label { font-size: 12px; font-weight: 600; flex: 1; }
  .settings-field input { width: 90px; border: 1px solid oklch(0.88 0.01 230); border-radius: 7px; padding: 5px 8px; font-family: inherit; font-size: 12.5px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top-row">
    <div>
      <div class="logo-lockup">
        <svg width="24" height="24" viewBox="0 0 24 24">
          <ellipse cx="9" cy="7" rx="3" ry="7.5" fill="oklch(0.62 0.16 40)" transform="rotate(-18 9 7)"/>
          <ellipse cx="15" cy="7" rx="3" ry="7.5" fill="oklch(0.52 0.11 225)" transform="rotate(18 15 7)"/>
        </svg>
        <div class="logo"><span class="wab">WAB</span><span class="bit">BIT</span></div>
      </div>
      <h1>🌐 מקורות מידע - אתרים שנסרקים אוטומטית לגילוי ועדכון פעילויות</h1>
    </div>
  </div>
  ${renderNav('sources')}

  <div id="killSwitchBar" class="kill-switch-bar">
    <div>
      <div class="kill-label">סריקה אוטומטית גלובלית</div>
      <div class="kill-sub">כשכבוי - שום מקור לא נסרק אוטומטית, גם אם הגיע זמנו. "סרוק עכשיו" ידני עדיין עובד.</div>
    </div>
    <button id="killSwitchBtn" class="toggle-btn" type="button">טוען...</button>
  </div>

  <div class="settings-toggle" id="settingsToggle">⚙️ הגדרות סריקה (מגבלות/ספים)</div>
  <div id="settingsPanel" class="form-card">
    <div id="settingsGrid" class="settings-grid"></div>
    <div class="form-actions">
      <button id="saveSettingsBtn" class="primary-btn" type="button">שמירת הגדרות</button>
    </div>
  </div>

  <div class="actions-row">
    <button id="addSourceBtn" class="primary-btn" type="button">+ הוספת מקור</button>
  </div>

  <div id="formCard" class="form-card" style="display:none;">
    <div class="form-title" id="formTitle">מקור חדש</div>
    <div class="form-grid">
      <div class="field"><label>שם המקור</label><input id="fName" type="text" placeholder="למשל: אתר עיריית תל אביב - אירועי ילדים"></div>
      <div class="field"><label>כתובת (Seed URL)</label><input id="fUrl" type="text" placeholder="https://..." style="direction:ltr; text-align:left;"></div>
      <div class="field"><label>סוג</label><select id="fType"><option value="html">html</option><option value="api">api</option><option value="rss">rss</option><option value="sitemap">sitemap</option><option value="other">other</option></select></div>
      <div class="field"><label>אזור</label><select id="fRegion"><option value="">-- ללא --</option></select></div>
      <div class="field"><label>תדירות סריקה</label><select id="fFreq"><option value="12">כל 12 שעות</option><option value="24" selected>כל 24 שעות</option><option value="72">כל 3 ימים</option><option value="168">כל שבוע</option></select></div>
      <div class="field"><label>ציון אמון (0-100, ריק = לא הוגדר)</label><input id="fTrust" type="number" min="0" max="100" placeholder="לא הוגדר"></div>
      <div class="field"><label>סוג מקור (מה הדף)</label><select id="fKind">
        <option value="website">אתר</option><option value="events_page">עמוד אירועים</option><option value="municipality_calendar">לוח אירועים עירוני</option>
        <option value="chain_events_page">עמוד אירועים של רשת</option><option value="aggregator">אגרגטור</option><option value="ticketing">כרטיסים</option>
        <option value="facebook">פייסבוק (לא נתמך לסריקה)</option><option value="instagram">אינסטגרם (לא נתמך לסריקה)</option><option value="rss">RSS</option><option value="api">API</option><option value="other">אחר</option>
      </select></div>
      <div class="field"><label>מי מפרסם (WHO)</label><select id="fPublisherType">
        <option value="">--</option><option value="venue_operator">המקום עצמו</option><option value="municipality">עירייה</option><option value="local_council">מועצה מקומית</option>
        <option value="regional_council">מועצה אזורית</option><option value="mall_chain">רשת קניונים</option><option value="organizer">מארגן/מפיק</option>
        <option value="community_center_network">רשת מתנ״סים</option><option value="library_network">רשת ספריות</option><option value="aggregator">אגרגטור</option><option value="government_body">גוף ממשלתי</option><option value="other">אחר</option>
      </select></div>
      <div class="field"><label>שם המפרסם</label><input id="fPublisherName" type="text" placeholder="למשל: עיריית חיפה / אמות קניונים"></div>
      <div class="field"><label>מקום קנוני (WHERE) - רק אם זה העמוד של המקום עצמו</label><select id="fVenue"><option value="">-- ללא --</option></select></div>
      <div class="field"><label>עדיפות (1-10, 8+ = מקור בעל ערך גבוה, לא מושהה אוטומטית)</label><input id="fPriority" type="number" min="1" max="10" value="5"></div>
      <div class="field full"><label>adapter_config (JSON) - למשל {"detail_traversal":{"max_pages":8,"allow_hosts":[],"link_selector":"","url_pattern":""}} - ריק = ללא</label><textarea id="fAdapterConfig" rows="2" style="direction:ltr; text-align:left; font-family:monospace; font-size:12px; width:100%;"></textarea></div>
      <div class="field full">
        <label>קטגוריות רלוונטיות (אופציונלי - להנחיה/סינון עתידי)</label>
        <div id="fCategories" class="cat-checks"></div>
      </div>
      <div class="field full">
        <label class="checkbox-row"><input id="fActive" type="checkbox" checked> פעיל (נסרק אוטומטית)</label>
        <label class="checkbox-row"><input id="fTrusted" type="checkbox"> מקור מהימן (Trusted Source)</label>
      </div>
    </div>
    <div class="form-actions">
      <button id="saveSourceBtn" class="primary-btn" type="button">שמירה</button>
      <button id="cancelFormBtn" class="secondary-btn" type="button">ביטול</button>
    </div>
  </div>

  <div id="status" class="status">טוען...</div>
  <div id="sourceList" class="source-list"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $status = document.getElementById('status');
  const $list = document.getElementById('sourceList');
  const $killBar = document.getElementById('killSwitchBar');
  const $killBtn = document.getElementById('killSwitchBtn');
  const $settingsToggle = document.getElementById('settingsToggle');
  const $settingsPanel = document.getElementById('settingsPanel');
  const $settingsGrid = document.getElementById('settingsGrid');
  const $formCard = document.getElementById('formCard');
  const $formTitle = document.getElementById('formTitle');
  const $addSourceBtn = document.getElementById('addSourceBtn');
  const $cancelFormBtn = document.getElementById('cancelFormBtn');
  const $saveSourceBtn = document.getElementById('saveSourceBtn');
  const $fCategories = document.getElementById('fCategories');
  const $fRegion = document.getElementById('fRegion');

  let sources = [];
  let options = { category: [], region: [] };
  let settings = {};
  let editingId = null;
  let openLogsFor = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function formatDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('he-IL'); } catch { return iso; }
  }

  const SETTINGS_LABELS = {
    max_discovered_pages_per_source: 'מקסימום דפים נוספים למקור בסריקה',
    max_activities_per_scan: 'מקסימום פעילויות לסריקה',
    max_ai_requests_per_scan: 'מקסימום קריאות AI לסריקה',
    fetch_timeout_ms: 'טיים-אאוט לטעינת דף (מילישניות)',
    page_retry_count: 'מספר ניסיונות חוזרים לדף שנכשל',
    missing_scan_threshold: 'סף סריקות רצופות עד "נעלם מהמקור"',
    duplicate_confidence_threshold: 'סף ביטחון לזיהוי כפילות (0-1)',
    needs_review_confidence_threshold: 'סף ביטחון לזיהוי "אולי עדכון" (0-1)',
    proximity_km: 'טווח קרבה גיאוגרפית לכפילות (ק"מ)',
  };

  function renderKillSwitch() {
    const on = settings.scanning_enabled !== false;
    $killBar.className = 'kill-switch-bar' + (on ? '' : ' off');
    $killBtn.className = 'toggle-btn ' + (on ? 'on' : 'off');
    $killBtn.textContent = on ? '🟢 מופעל' : '🔴 כבוי';
  }

  function renderSettingsPanel() {
    $settingsGrid.innerHTML = Object.keys(SETTINGS_LABELS).map((key) => (
      '<div class="settings-field"><label>' + escapeHtml(SETTINGS_LABELS[key]) + '</label>' +
      '<input data-key="' + key + '" type="number" step="any" value="' + (settings[key] ?? '') + '"></div>'
    )).join('');
  }

  function renderCategoryChecks(selected) {
    const sel = new Set(selected || []);
    $fCategories.innerHTML = options.category.map((c) => (
      '<label><input type="checkbox" value="' + escapeHtml(c) + '"' + (sel.has(c) ? ' checked' : '') + '> ' + escapeHtml(c) + '</label>'
    )).join('');
  }

  function renderRegionOptions(selected) {
    $fRegion.innerHTML = '<option value="">-- ללא --</option>' + options.region.map((r) => (
      '<option value="' + escapeHtml(r) + '"' + (r === selected ? ' selected' : '') + '>' + escapeHtml(r) + '</option>'
    )).join('');
  }

  function openForm(source) {
    editingId = source ? source.id : null;
    $formTitle.textContent = source ? 'עריכת מקור: ' + source.name : 'מקור חדש';
    document.getElementById('fName').value = source ? source.name : '';
    document.getElementById('fUrl').value = source ? source.seed_url : '';
    document.getElementById('fType').value = source ? source.type : 'html';
    document.getElementById('fFreq').value = source ? String(source.scan_frequency_hours) : '24';
    document.getElementById('fTrust').value = source && source.source_trust_score != null ? source.source_trust_score : '';
    document.getElementById('fActive').checked = source ? source.is_active : true;
    document.getElementById('fTrusted').checked = source ? source.is_trusted : false;
    document.getElementById('fKind').value = source ? (source.source_kind || 'website') : 'website';
    document.getElementById('fPublisherType').value = source ? (source.publisher_type || '') : '';
    document.getElementById('fPublisherName').value = source ? (source.publisher_name || '') : '';
    document.getElementById('fPriority').value = source ? String(source.priority ?? 5) : '5';
    document.getElementById('fAdapterConfig').value = source && source.adapter_config ? JSON.stringify(source.adapter_config) : '';
    renderVenueOptions(source ? source.venue_id : '');
    renderRegionOptions(source ? source.region : '');
    renderCategoryChecks(source ? source.categories : []);
    $formCard.style.display = 'block';
    $formCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeForm() {
    editingId = null;
    $formCard.style.display = 'none';
  }

  async function submitForm() {
    const name = document.getElementById('fName').value.trim();
    const seed_url = document.getElementById('fUrl').value.trim();
    if (!name || !seed_url) { alert('שם וכתובת הם שדות חובה'); return; }
    const trustRaw = document.getElementById('fTrust').value;
    const categories = Array.from($fCategories.querySelectorAll('input:checked')).map((el) => el.value);
    const fields = {
      name, seed_url,
      type: document.getElementById('fType').value,
      region: $fRegion.value || null,
      categories,
      scan_frequency_hours: Number(document.getElementById('fFreq').value),
      is_active: document.getElementById('fActive').checked,
      is_trusted: document.getElementById('fTrusted').checked,
      source_trust_score: trustRaw === '' ? null : Number(trustRaw),
      source_kind: document.getElementById('fKind').value,
      publisher_type: document.getElementById('fPublisherType').value || null,
      publisher_name: document.getElementById('fPublisherName').value.trim() || null,
      venue_id: document.getElementById('fVenue').value || null,
      priority: Math.min(10, Math.max(1, Number(document.getElementById('fPriority').value) || 5)),
    };
    const adapterRaw = document.getElementById('fAdapterConfig').value.trim();
    if (adapterRaw) { try { fields.adapter_config = JSON.parse(adapterRaw); } catch { alert('adapter_config אינו JSON תקין'); return; } }
    else fields.adapter_config = null;
    $saveSourceBtn.disabled = true;
    try {
      const url = editingId ? '/api/sources/' + editingId : '/api/sources';
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      closeForm();
      await load();
    } catch (err) {
      alert('שגיאה בשמירה: ' + err.message);
    } finally {
      $saveSourceBtn.disabled = false;
    }
  }

  async function deleteSource(id) {
    if (!await confirmModal('למחוק את המקור? היסטוריית הסריקות שלו תישאר, אבל הוא יפסיק להיסרק.', { danger: true })) return;
    try {
      const res = await fetch('/api/sources/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      await load();
    } catch (err) {
      alert('שגיאה במחיקה: ' + err.message);
    }
  }

  async function scanNow(id, btn) {
    btn.disabled = true;
    btn.textContent = '⏳ שולח...';
    try {
      const res = await fetch('/api/sources/' + id + '/scan-now', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      btn.textContent = '✅ נשלח לסריקה';
      setTimeout(load, 4000);
    } catch (err) {
      alert('שגיאה בהפעלת הסריקה: ' + err.message);
      btn.disabled = false;
      btn.textContent = '🔍 סרוק עכשיו';
    }
  }

  async function toggleLogs(id) {
    openLogsFor = openLogsFor === id ? null : id;
    renderList();
    if (openLogsFor === id) await loadLogsPanel(id);
  }

  async function loadLogsPanel(id) {
    const panel = document.getElementById('logs-' + id);
    if (!panel) return;
    panel.innerHTML = 'טוען היסטוריה...';
    try {
      const res = await fetch('/api/sources/' + id + '/logs');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      if (!data.logs.length) { panel.innerHTML = '<div>אין עדיין היסטוריית סריקות.</div>'; return; }
      panel.innerHTML = data.logs.map((l) => (
        '<div class="log-row">' +
          '<span><b>' + formatDate(l.started_at) + '</b></span>' +
          '<span>' + escapeHtml(l.status) + '</span>' +
          '<span>דפים: ' + l.pages_checked + ' (שונו ' + l.pages_changed + ', ללא שינוי ' + l.pages_unchanged + ')</span>' +
          '<span>AI: ' + l.ai_calls + '</span>' +
          '<span>חדש/עדכון/כפול: ' + l.new_count + '/' + l.updated_count + '/' + l.duplicate_count + '</span>' +
          '<span>נעלמו: ' + l.missing_count + '</span>' +
          (l.error_message ? '<span style="color:oklch(0.5 0.18 25);">שגיאה (' + escapeHtml(l.error_type || '') + '): ' + escapeHtml(l.error_message) + '</span>' : '') +
        '</div>'
      )).join('');
    } catch (err) {
      panel.innerHTML = '<div style="color:oklch(0.5 0.18 25);">שגיאה בטעינת ההיסטוריה: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function trustBadge(s) {
    if (s.source_trust_score == null) return '<span class="badge trust-none">ציון אמון: לא הוגדר</span>';
    return '<span class="badge trust-' + s.source_trust_level + '">ציון אמון: ' + s.source_trust_score + ' (' + s.source_trust_level + ')</span>';
  }

  const HEALTH_LABELS = { healthy: '💚 תקין', failing: '🟡 כשלים אחרונים', backed_off: '🟠 בהאטה (backoff)', attention_required: '🔴 דורש תשומת לב', auto_paused: '⏸️ הושהה אוטומטית' };
  const FAILURE_LABELS = { gone_404: 'הדף נעלם (404)', access_403_waf: 'חסימת גישה (403/WAF)', timeout_network: 'timeout/רשת', parse_extraction: 'כשל חילוץ', content_changed: 'התוכן השתנה - לא נמצאו פעילויות', unknown: 'לא ידוע' };
  const KIND_LABELS = { website: 'אתר', events_page: 'עמוד אירועים', municipality_calendar: 'לוח עירוני', chain_events_page: 'אירועי רשת', aggregator: 'אגרגטור', ticketing: 'כרטיסים', facebook: 'פייסבוק', instagram: 'אינסטגרם', rss: 'RSS', api: 'API', other: 'אחר' };
  let venueNames = {};

  function healthBadge(s) {
    const h = s.health_status || 'healthy';
    if (!s.is_active && ['facebook', 'instagram'].includes(s.source_kind)) return '<span class="badge paused">📵 לא נתמך לסריקה (רשת חברתית)</span>';
    const cls = h === 'healthy' ? 'active' : (h === 'failing' || h === 'backed_off' ? 'trust-MEDIUM' : 'error');
    return '<span class="badge ' + cls + '">' + (HEALTH_LABELS[h] || h) + (s.consecutive_failures ? ' (' + s.consecutive_failures + ')' : '') + '</span>';
  }

  function renderCard(s) {
    const statusBadge = s.last_scan_status === 'error'
      ? '<span class="badge error">⚠️ סריקה אחרונה נכשלה</span>'
      : (s.last_scan_status ? '<span class="badge active">סריקה אחרונה: ' + escapeHtml(s.last_scan_status) + '</span>' : '');
    return '<div class="source-card">' +
      '<div class="source-head">' +
        '<span class="source-name">' + escapeHtml(s.name) + '</span>' +
        '<span class="badge ' + (s.is_active ? 'active' : 'paused') + '">' + (s.is_active ? '🟢 פעיל' : '⏸️ מושהה') + '</span>' +
        healthBadge(s) +
        trustBadge(s) +
        (s.is_trusted ? '<span class="badge trusted">⭐ מהימן</span>' : '') +
        (s.adapter_config && s.adapter_config.detail_traversal ? '<span class="badge trusted" title="detail traversal">🔗 דפי פרטים' + (s.detail_yield ? ': ' + s.detail_yield : '') + '</span>' : '') +
        ((s.priority || 5) >= 8 ? '<span class="badge trusted">🔝 עדיפות ' + s.priority + '</span>' : '') +
        statusBadge +
      '</div>' +
      '<div class="source-url"><a href="' + escapeHtml(s.seed_url) + '" target="_blank" rel="noopener">' + escapeHtml(s.seed_url) + '</a></div>' +
      '<div class="source-meta">' +
        '<span><b>סוג:</b> ' + escapeHtml(KIND_LABELS[s.source_kind] || s.source_kind || 'אתר') + '</span>' +
        (s.publisher_name || s.publisher_type ? '<span><b>מפרסם:</b> ' + escapeHtml([s.publisher_name, s.publisher_type].filter(Boolean).join(' · ')) + '</span>' : '') +
        (s.venue_id ? '<span><b>מקום:</b> 🏬 ' + escapeHtml(venueNames[s.venue_id] || s.venue_id) + '</span>' : '') +
        (s.last_failure_kind ? '<span><b>סוג כשל אחרון:</b> ' + escapeHtml(FAILURE_LABELS[s.last_failure_kind] || s.last_failure_kind) + '</span>' : '') +
        (s.disabled_reason ? '<span style="color:oklch(0.5 0.18 25);"><b>סיבת השהיה:</b> ' + escapeHtml(s.disabled_reason) + '</span>' : '') +
        '<span><b>אזור:</b> ' + escapeHtml(s.region || '—') + '</span>' +
        '<span><b>תדירות:</b> כל ' + s.scan_frequency_hours + ' שעות</span>' +
        '<span><b>סריקה אחרונה:</b> ' + formatDate(s.last_scan_at) + '</span>' +
        '<span><b>סריקה הבאה:</b> ' + formatDate(s.next_scan_at) + '</span>' +
        '<span><b>נמצאו/אושרו/שגיאות:</b> ' + s.activities_found_total + ' / ' + s.activities_approved_total + ' / ' + s.scan_errors_total + '</span>' +
      '</div>' +
      (s.last_scan_error ? '<div class="source-meta" style="color:oklch(0.5 0.18 25);">שגיאה אחרונה: ' + escapeHtml(s.last_scan_error) + '</div>' : '') +
      '<div class="source-actions">' +
        ((!s.is_active || ['attention_required', 'backed_off', 'auto_paused'].includes(s.health_status)) && !['facebook', 'instagram'].includes(s.source_kind)
          ? '<button class="secondary-btn" data-action="reactivate" data-id="' + s.id + '">🔁 הפעל מחדש (איפוס כשלים)</button>' : '') +
        '<button class="secondary-btn" data-action="scan" data-id="' + s.id + '">🔍 סרוק עכשיו</button>' +
        '<button class="secondary-btn" data-action="logs" data-id="' + s.id + '">📜 היסטוריית סריקות</button>' +
        '<button class="secondary-btn" data-action="edit" data-id="' + s.id + '">✏️ עריכה</button>' +
        '<button class="secondary-btn danger-btn" data-action="delete" data-id="' + s.id + '">🗑️ מחיקה</button>' +
      '</div>' +
      (openLogsFor === s.id ? '<div class="logs-panel" id="logs-' + s.id + '"></div>' : '') +
    '</div>';
  }

  function renderList() {
    $status.textContent = sources.length + ' מקורות.';
    $list.innerHTML = sources.map(renderCard).join('') || '<div class="status">אין עדיין מקורות מוגדרים. לחצו על "+ הוספת מקור" כדי להתחיל.</div>';
    // אחרי re-render (למשל אחרי scanNow) - אם פאנל לוגים היה פתוח, טוענים אותו מחדש בלי לטגל.
    if (openLogsFor) loadLogsPanel(openLogsFor);
  }

  function editSourceById(id) {
    const source = sources.find((s) => s.id === id);
    if (source) openForm(source);
  }

  // Event delegation (לא inline onclick) - כמו manage.js, נמנע מבעיות escaping של מזהי UUID
  // בתוך מחרוזות HTML/JS מקוננות.
  $list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'scan') scanNow(id, btn);
    else if (btn.dataset.action === 'reactivate') reactivateSource(id, btn);
    else if (btn.dataset.action === 'logs') toggleLogs(id);
    else if (btn.dataset.action === 'edit') editSourceById(id);
    else if (btn.dataset.action === 'delete') deleteSource(id);
  });

  async function reactivateSource(id, btn) {
    btn.disabled = true;
    try {
      const res = await fetch('/api/sources/' + id + '/reactivate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      await load();
    } catch (err) {
      alert('שגיאה בהפעלה מחדש: ' + err.message);
      btn.disabled = false;
    }
  }

  let venuesList = [];
  function renderVenueOptions(selected) {
    const $v = document.getElementById('fVenue');
    $v.innerHTML = '<option value="">-- ללא --</option>' + venuesList.filter((v) => v.is_active).map((v) => (
      '<option value="' + v.id + '"' + (v.id === selected ? ' selected' : '') + '>' + escapeHtml(v.name_he + (v.city ? ' · ' + v.city : '')) + '</option>'
    )).join('');
  }
  async function loadVenues() {
    try {
      const res = await fetch('/api/venues');
      const data = await res.json();
      if (res.ok) { venuesList = data.venues || []; venueNames = Object.fromEntries(venuesList.map((v) => [v.id, v.name_he])); }
    } catch { /* venues are optional decoration here */ }
  }

  async function toggleKillSwitch() {
    const next = !(settings.scanning_enabled !== false);
    $killBtn.disabled = true;
    try {
      const res = await fetch('/api/automation-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { scanning_enabled: next } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      settings.scanning_enabled = next;
      renderKillSwitch();
    } catch (err) {
      alert('שגיאה בעדכון: ' + err.message);
    } finally {
      $killBtn.disabled = false;
    }
  }

  async function saveSettings() {
    const updates = {};
    $settingsGrid.querySelectorAll('input[data-key]').forEach((el) => {
      const v = el.value.trim();
      if (v !== '') updates[el.dataset.key] = Number(v);
    });
    const btn = document.getElementById('saveSettingsBtn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/automation-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      Object.assign(settings, updates);
      alert('ההגדרות נשמרו.');
    } catch (err) {
      alert('שגיאה בשמירה: ' + err.message);
    } finally {
      document.getElementById('saveSettingsBtn').disabled = false;
    }
  }

  $addSourceBtn.addEventListener('click', () => openForm(null));
  $cancelFormBtn.addEventListener('click', closeForm);
  $saveSourceBtn.addEventListener('click', submitForm);
  $killBtn.addEventListener('click', toggleKillSwitch);
  $settingsToggle.addEventListener('click', () => $settingsPanel.classList.toggle('open'));
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

  async function load() {
    try {
      await loadVenues();
      const [sourcesRes, settingsRes, optionsRes] = await Promise.all([
        fetch('/api/sources'), fetch('/api/automation-settings'), fetch('/api/manage/options'),
      ]);
      const sourcesData = await sourcesRes.json();
      const settingsData = await settingsRes.json();
      const optionsData = await optionsRes.json();
      if (!sourcesRes.ok) throw new Error(sourcesData.error || 'שגיאה לא ידועה');
      if (!settingsRes.ok) throw new Error(settingsData.error || 'שגיאה לא ידועה');
      sources = sourcesData.sources;
      settings = settingsData.settings;
      options = { category: optionsData.category || [], region: optionsData.region || [] };
      $status.className = 'status';
      renderKillSwitch();
      renderSettingsPanel();
      renderList();
    } catch (err) {
      $status.textContent = 'שגיאה בטעינה: ' + err.message;
      $status.className = 'status error';
    }
  }

  load();
</script>
</body>
</html>`;
}

module.exports = { renderSourcesPage };
