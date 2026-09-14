// TuRu - "🔎 בדיקת פעילויות שנמצאו" - דשבורד לבדיקת settlement_scan_review_cases (282 מקרים,
// שנצברו מהסריקה הארצית שהושלמה ב-2026-09-14: 1,204/1,204 יישובים, cursor=1204, הסורק כבוי
// לצמיתות). אותו דפוס בדיוק כמו incoming.js (עמוד סטטי + <script> וניל בסוף, בלי framework/
// build step) - ראו incoming.js להשוואה, זה העמוד הכי-קרוב מבחינת מבנה (טאבים+כרטיסים+bulk).
// ההבדל המרכזי: אין כאן "אישור" שיוצר פעילות אוטומטית בשום מקרה - כל שלוש הפעולות (כפילות/
// פעילות חדשה/השאר לבדיקה) רק *רושמות החלטת-מנהל* על settlement_scan_review_cases עצמו +
// שורת-audit נפרדת (settlement_scan_review_decisions, 0085) - אף אחת מהן לא נוגעת בטבלת
// activities/locations. "פעילות חדשה" לא יוצרת רשומה אוטומטית (בקשה מפורשת: "Do NOT
// automatically publish") - במקום זה מציגה את הפרטים הידועים + קישור לטופס ההוספה הידני הקיים
// (/import) שהמנהל ממלא/שומר בעצמו, בדיוק כמו כל הוספה ידנית אחרת בכלי הזה.

const { renderNav, NAV_STYLES } = require('./nav');

function renderSettlementReviewPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - בדיקת פעילויות שנמצאו (סריקה ארצית)</title>
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
  .wrap { max-width: 1180px; margin: 0 auto; padding: 32px 20px 60px; }
  .logo-lockup { display: flex; align-items: center; gap: 8px; direction: ltr; margin-bottom: 4px; }
  .logo { font-family: 'Fredoka', 'Assistant', sans-serif; font-size: 26px; font-weight: 700; }
  .logo .wab { color: oklch(0.3 0.03 235); }
  .logo .bit { color: oklch(0.52 0.11 225); }
  .top-row { margin-bottom: 20px; }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0; }
  .subtitle { font-size: 13px; color: oklch(0.5 0.02 235); margin: 4px 0 0; }

  .summary-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 18px 0; }
  .summary-card {
    background: white; border: 1px solid oklch(0.9 0.01 230); border-radius: 14px; padding: 14px;
    text-align: center; cursor: pointer; user-select: none;
  }
  .summary-card.active { border-color: oklch(0.52 0.11 225); box-shadow: 0 0 0 2px oklch(0.52 0.11 225 / 0.25); }
  .summary-card .n { font-size: 22px; font-weight: 800; }
  .summary-card .lbl { font-size: 11.5px; color: oklch(0.5 0.02 235); margin-top: 2px; }

  .filter-bar {
    background: white; border: 1px solid oklch(0.9 0.01 230); border-radius: 14px; padding: 14px;
    display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-bottom: 14px;
  }
  .filter-field { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: oklch(0.5 0.02 235); font-weight: 700; }
  .filter-field input, .filter-field select {
    border: 1px solid oklch(0.88 0.01 230); border-radius: 8px; padding: 6px 8px; font-family: inherit; font-size: 12.5px;
    background: white; color: oklch(0.3 0.02 235); min-width: 110px;
  }
  .filter-field.dist-pair { flex-direction: row; align-items: flex-end; gap: 6px; }
  .filter-field.dist-pair input { min-width: 60px; }
  .filter-field.checkbox-field { flex-direction: row; align-items: center; gap: 6px; font-weight: 600; }
  .clear-filters-btn {
    font-size: 12px; font-weight: 700; color: oklch(0.5 0.02 235); background: white;
    border: 1px solid oklch(0.85 0.01 230); border-radius: 999px; padding: 7px 14px; cursor: pointer; height: fit-content;
  }

  .status { margin: 4px 2px 12px; font-size: 13px; color: oklch(0.5 0.02 235); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .status.error { color: oklch(0.5 0.18 25); font-weight: 600; }
  .pager { display: flex; gap: 6px; align-items: center; }
  .pager button {
    border: 1px solid oklch(0.88 0.01 230); background: white; border-radius: 999px; padding: 5px 12px;
    font-size: 12px; font-weight: 700; cursor: pointer; color: oklch(0.4 0.02 235);
  }
  .pager button:disabled { opacity: 0.4; cursor: default; }

  .item-list { display: flex; flex-direction: column; gap: 14px; }
  .review-card { background: white; border: 1px solid oklch(0.9 0.01 230); border-radius: 14px; padding: 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05); }
  .card-top { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; cursor: pointer; }
  .badge { font-size: 10.5px; font-weight: 800; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
  .badge.case-strong_match { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .badge.case-possible_duplicate { background: oklch(0.95 0.07 60); color: oklch(0.5 0.13 55); }
  .badge.case-needs_review_possible_duplicate { background: oklch(0.95 0.07 80); color: oklch(0.5 0.13 80); }
  .badge.case-same_street_review { background: oklch(0.93 0.06 260); color: oklch(0.45 0.14 260); }
  .badge.case-needs_review_uncertain_type { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .badge.case-duplicate_exact_place_id { background: oklch(0.93 0.005 235); color: oklch(0.5 0.02 235); }
  .badge.status-needs_review { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .badge.status-approved_duplicate { background: oklch(0.93 0.005 235); color: oklch(0.4 0.02 235); }
  .badge.status-approved_distinct { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .badge.status-dismissed { background: oklch(0.96 0.01 230); color: oklch(0.55 0.02 235); }
  .badge.recurring { background: oklch(0.94 0.08 250); color: oklch(0.45 0.15 260); }
  .badge.samestreet { background: oklch(0.93 0.06 260); color: oklch(0.45 0.14 260); }
  .badge.warn5060 { background: oklch(0.55 0.16 55); color: white; }
  .card-spacer { flex: 1; }

  .warn-banner {
    background: oklch(0.97 0.09 55); border: 1px solid oklch(0.75 0.14 55); color: oklch(0.4 0.13 55);
    border-radius: 10px; padding: 8px 12px; font-size: 12.5px; font-weight: 700; margin-bottom: 10px;
  }
  .samestreet-banner {
    background: oklch(0.96 0.03 260); border: 1px solid oklch(0.8 0.08 260); color: oklch(0.4 0.12 260);
    border-radius: 10px; padding: 8px 12px; font-size: 12.5px; font-weight: 700; margin-bottom: 10px;
  }

  .compare-row { direction: ltr; display: grid; grid-template-columns: 1fr auto 1fr; gap: 14px; align-items: start; }
  .compare-side { direction: rtl; background: oklch(0.98 0.004 230); border-radius: 12px; padding: 12px; min-width: 0; }
  .compare-side h4 { margin: 0 0 6px; font-size: 12px; color: oklch(0.5 0.02 235); }
  .compare-side .name { font-size: 14px; font-weight: 800; margin-bottom: 4px; }
  .compare-side .field { font-size: 12px; color: oklch(0.4 0.02 235); margin-top: 2px; word-break: break-word; }
  .compare-side .field b { color: oklch(0.3 0.02 235); }
  .compare-side img.thumb { width: 100%; max-height: 110px; object-fit: cover; border-radius: 8px; margin-bottom: 6px; }
  .no-image { width: 100%; height: 60px; display: flex; align-items: center; justify-content: center; background: oklch(0.94 0.005 230); border-radius: 8px; margin-bottom: 6px; color: oklch(0.6 0.01 230); font-size: 20px; }

  .compare-center { direction: rtl; width: 190px; text-align: center; padding-top: 6px; }
  .distance-big { font-size: 22px; font-weight: 800; color: oklch(0.4 0.1 225); }
  .signals { text-align: right; font-size: 11.5px; color: oklch(0.4 0.02 235); margin-top: 10px; line-height: 1.9; }
  .signals .sig-row { display: flex; justify-content: space-between; gap: 6px; }
  .signals b { color: oklch(0.25 0.02 240); }

  .card-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
  .primary-btn { border: none; border-radius: 999px; padding: 8px 16px; font-weight: 700; font-size: 12.5px; cursor: pointer; font-family: inherit; color: white; }
  .btn-dup { background: oklch(0.55 0.18 25); }
  .btn-new { background: oklch(0.5 0.13 150); }
  .btn-hold { background: oklch(0.6 0.13 80); }
  .secondary-btn {
    background: oklch(0.97 0.005 230); color: oklch(0.35 0.02 235); border: 1px solid oklch(0.88 0.01 230);
    border-radius: 999px; padding: 7px 14px; font-weight: 700; font-size: 12.5px; cursor: pointer; font-family: inherit;
  }
  .note-input {
    flex: 1 1 220px; border: 1px solid oklch(0.88 0.01 230); border-radius: 8px; padding: 7px 10px;
    font-family: inherit; font-size: 12px; min-width: 180px;
  }
  .decided-note { font-size: 12px; color: oklch(0.5 0.02 235); margin-top: 10px; }
  .empty-note { font-size: 13px; color: oklch(0.5 0.02 235); padding: 30px 2px; text-align: center; }

  /* detail drawer */
  .drawer-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,0.5); z-index: 500; display: none; align-items: flex-start; justify-content: center; overflow-y: auto; padding: 30px 16px; }
  .drawer-backdrop.open { display: flex; }
  .drawer {
    background: white; border-radius: 16px; max-width: 880px; width: 100%; padding: 22px; direction: rtl;
    box-shadow: 0 20px 60px rgba(0,0,0,0.25);
  }
  .drawer-close { float: left; background: none; border: none; font-size: 20px; cursor: pointer; color: oklch(0.5 0.02 235); }
  .drawer h2 { margin: 0 0 4px; font-size: 17px; }
  .drawer-section { margin-top: 18px; border-top: 1px solid oklch(0.93 0.01 230); padding-top: 14px; }
  .drawer-section h3 { font-size: 13px; margin: 0 0 8px; color: oklch(0.4 0.02 235); }
  .raw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; font-size: 12px; }
  .raw-grid .k { color: oklch(0.5 0.02 235); }
  .raw-grid .v { color: oklch(0.25 0.02 240); font-weight: 600; word-break: break-word; }
  .map-row { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
  .map-frame { flex: 1 1 260px; min-width: 240px; height: 220px; border-radius: 10px; overflow: hidden; border: 1px solid oklch(0.9 0.01 230); }
  .map-frame iframe { width: 100%; height: 100%; border: 0; }
  .map-label { font-size: 11px; font-weight: 700; color: oklch(0.5 0.02 235); margin-bottom: 4px; }
  .nearby-list { font-size: 12px; }
  .nearby-list li { margin-bottom: 4px; }
  .history-list { font-size: 12px; list-style: none; padding: 0; margin: 0; }
  .history-list li { padding: 6px 0; border-bottom: 1px solid oklch(0.95 0.01 230); }
</style>
</head>
<body>
<div class="wrap">
  <div class="top-row">
    <div class="logo-lockup">
      <svg width="24" height="24" viewBox="0 0 24 24">
        <ellipse cx="9" cy="7" rx="3" ry="7.5" fill="oklch(0.62 0.16 40)" transform="rotate(-18 9 7)"/>
        <ellipse cx="15" cy="7" rx="3" ry="7.5" fill="oklch(0.52 0.11 225)" transform="rotate(18 15 7)"/>
      </svg>
      <div class="logo"><span class="wab">WAB</span><span class="bit">BIT</span></div>
    </div>
    <h1>🔎 בדיקת פעילויות שנמצאו</h1>
    <p class="subtitle">עברו על מועמדים שהמערכת זיהתה במהלך הסריקה הארצית.</p>
  </div>
  ${renderNav('settlement-review')}

  <div class="summary-row" id="summaryRow"></div>

  <div class="filter-bar" id="filterBar">
    <div class="filter-field">
      <label>סוג בדיקה</label>
      <select id="fCaseType">
        <option value="">הכל</option>
        <option value="strong_match">🔴 strong_match</option>
        <option value="possible_duplicate">🟠 possible_duplicate</option>
        <option value="needs_review_possible_duplicate">🟠 needs_review_possible_duplicate</option>
        <option value="same_street_review">📍 same_street_review</option>
        <option value="needs_review_uncertain_type">🟢 needs_review_uncertain_type</option>
      </select>
    </div>
    <div class="filter-field">
      <label>חדש / חוזר</label>
      <select id="fRecurring"><option value="">הכל</option><option value="recurring">רק חוזרים</option><option value="new">רק חדשים</option></select>
    </div>
    <div class="filter-field dist-pair">
      <label>מרחק (מ')</label>
      <input type="number" id="fDistMin" placeholder="מ-">
      <input type="number" id="fDistMax" placeholder="עד">
    </div>
    <div class="filter-field"><label>יישוב</label><input type="text" id="fSettlement" placeholder="שם יישוב..."></div>
    <div class="filter-field">
      <label>אזור</label>
      <select id="fRegion"><option value="">הכל</option></select>
    </div>
    <div class="filter-field">
      <label>סטטוס</label>
      <select id="fStatus">
        <option value="needs_review">🔴 ממתין לבדיקה</option>
        <option value="">הכל</option>
        <option value="approved_duplicate">🔁 סומן ככפילות</option>
        <option value="approved_distinct">🆕 סומן כחדש</option>
        <option value="dismissed">🟡 הושאר לבדיקה</option>
        <option value="resolved_invalid">⛔ לא ישות TuRu</option>
      </select>
    </div>
    <div class="filter-field"><label>חיפוש - שם מועמד</label><input type="text" id="fQCandidate" placeholder="שם..."></div>
    <div class="filter-field"><label>חיפוש - פעילות קיימת</label><input type="text" id="fQExisting" placeholder="שם..."></div>
    <div class="filter-field">
      <label>מיון</label>
      <select id="fSort">
        <option value="strongest">התאמה חזקה ביותר</option>
        <option value="closest">מרחק - הקרוב ביותר</option>
        <option value="recurring">חוזרים ראשית</option>
        <option value="newest">חדש ביותר</option>
        <option value="oldest">ישן ביותר</option>
        <option value="az">א-ב (שם מועמד)</option>
        <option value="settlement">יישוב</option>
      </select>
    </div>
    <button class="clear-filters-btn" id="clearFiltersBtn" type="button">נקה סינון</button>
  </div>

  <div class="status" id="statusRow">
    <span id="statusText">טוען...</span>
    <div class="pager" id="pagerRow"></div>
  </div>
  <div class="item-list" id="itemList"></div>
</div>

<div class="drawer-backdrop" id="drawerBackdrop">
  <div class="drawer" id="drawerBody"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const REGIONS = ${JSON.stringify(require('../../constants/categoryValues.json').regions)};
  const CASE_LABELS = {
    strong_match: '🔴 התאמה חזקה', possible_duplicate: '🟠 חשוד בכפילות (30-50מ\\')',
    needs_review_possible_duplicate: '🟠 חשוד בכפילות (מעל 50מ\\')', same_street_review: '📍 אותו רחוב',
    needs_review_uncertain_type: '🟢 מועמד חדש - סוג לא ודאי', duplicate_exact_place_id: '⚪ כפילות מזהה מדויק',
  };
  const STATUS_LABELS = {
    needs_review: '🔴 ממתין לבדיקה', approved_duplicate: '🔁 סומן ככפילות',
    approved_distinct: '🆕 סומן כחדש', dismissed: '🟡 הושאר לבדיקה', resolved_invalid: '⛔ לא ישות TuRu',
  };
  // "resolved by THE CLEANER" indicator + its analysis note - driven by existing decision metadata only
  const cleanerBadge = (r) => (r.resolved_by === 'cleaner' ? ' <span class="badge" title="' + escapeHtml(r.resolution_note || '') + '">🤖 נפתר אוטומטית ע״י המנקה</span>' : (r.status === 'needs_review' && r.resolution && r.resolution.outcome ? ' <span class="badge" title="' + escapeHtml(r.resolution_note || '') + '">🤖 המנקה: ' + escapeHtml(r.resolution.outcome) + ' (' + escapeHtml(r.resolution.confidence || '') + ')</span>' : ''));

  const $summaryRow = document.getElementById('summaryRow');
  const $list = document.getElementById('itemList');
  const $statusText = document.getElementById('statusText');
  const $pagerRow = document.getElementById('pagerRow');
  const $drawerBackdrop = document.getElementById('drawerBackdrop');
  const $drawerBody = document.getElementById('drawerBody');

  document.getElementById('fRegion').innerHTML = '<option value="">הכל</option>' + REGIONS.map((r) => '<option value="' + r + '">' + r + '</option>').join('');

  let page = 1;
  const pageSize = 20;
  let summary = null;
  let activeSummaryCard = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function formatDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('he-IL'); } catch { return iso; }
  }
  function fmtBool(v) { return v === true ? 'כן' : v === false ? 'לא' : '—'; }
  function fmtNum(v, digits) { return v == null ? '—' : Number(v).toFixed(digits == null ? 2 : digits); }

  function currentFilters() {
    return {
      case_type: document.getElementById('fCaseType').value,
      recurring: document.getElementById('fRecurring').value,
      dist_min: document.getElementById('fDistMin').value,
      dist_max: document.getElementById('fDistMax').value,
      settlement: document.getElementById('fSettlement').value.trim(),
      region: document.getElementById('fRegion').value,
      status: document.getElementById('fStatus').value,
      q_candidate: document.getElementById('fQCandidate').value.trim(),
      q_existing: document.getElementById('fQExisting').value.trim(),
      sort: document.getElementById('fSort').value,
    };
  }

  function qs(obj) {
    const p = new URLSearchParams();
    Object.entries(obj).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); });
    return p.toString();
  }

  async function loadSummary() {
    const res = await fetch('/api/settlement-review/summary');
    summary = await res.json();
    const cards = [
      { key: 'needs_review', label: '🔴 לבדיקה', n: summary.needs_review, icon: '🔴' },
      { key: 'recurring', label: '🔁 חוזרים', n: summary.recurring },
      { key: 'suspected_duplicate', label: '🟠 חשודים בכפילות', n: summary.suspected_duplicate },
      { key: 'new_candidates', label: '🟢 מועמדים חדשים', n: summary.new_candidates },
      { key: 'same_street', label: '📍 SAME STREET', n: summary.same_street },
    ];
    $summaryRow.innerHTML = cards.map((c) => (
      '<div class="summary-card' + (activeSummaryCard === c.key ? ' active' : '') + '" data-summary="' + c.key + '">' +
        '<div class="n">' + c.n + '</div><div class="lbl">' + c.label + '</div></div>'
    )).join('');
  }

  $summaryRow.addEventListener('click', (e) => {
    const card = e.target.closest('[data-summary]');
    if (!card) return;
    const key = card.dataset.summary;
    activeSummaryCard = activeSummaryCard === key ? null : key;
    page = 1;
    // כרטיסי-הסיכום הם קיצורי-דרך לסינון נפוץ, לא state נפרד - ממפים לאותם שדות סינון רגילים.
    if (key === 'needs_review') { document.getElementById('fStatus').value = activeSummaryCard ? 'needs_review' : ''; document.getElementById('fRecurring').value = ''; document.getElementById('fCaseType').value = ''; }
    else if (key === 'recurring') { document.getElementById('fRecurring').value = activeSummaryCard ? 'recurring' : ''; }
    else if (key === 'suspected_duplicate') { document.getElementById('fCaseType').value = ''; document.getElementById('fStatus').value = activeSummaryCard ? 'needs_review' : ''; }
    else if (key === 'new_candidates') { document.getElementById('fCaseType').value = activeSummaryCard ? 'needs_review_uncertain_type' : ''; }
    else if (key === 'same_street') { document.getElementById('fCaseType').value = activeSummaryCard ? 'same_street_review' : ''; }
    loadSummary();
    loadList();
  });

  ['fCaseType','fRecurring','fDistMin','fDistMax','fSettlement','fRegion','fStatus','fQCandidate','fQExisting','fSort'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { page = 1; loadList(); });
  });
  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    document.querySelectorAll('#filterBar input').forEach((i) => i.value = '');
    document.querySelectorAll('#filterBar select').forEach((s) => s.value = '');
    document.getElementById('fStatus').value = 'needs_review';
    activeSummaryCard = null;
    page = 1;
    loadSummary();
    loadList();
  });

  function renderSignals(c) {
    const rows = [
      ['🏷️ דמיון שם', c.name_similarity_score],
      ['🛣️ דמיון רחוב', c.street_similarity_score],
      ['🔢 מספר בית תואם', fmtBool(c.house_number_match != null ? c.house_number_match > 0 : null)],
      ['🏙️ עיר תואמת', fmtBool(c.city_match)],
      ['📍 שכונה תואמת', fmtBool(c.neighborhood_match)],
      ['🧭 יישוב קנוני תואם', fmtBool(c.canonical_settlement_match)],
      ['🏷️ סוג מקום', c.place_kind || '—'],
      ['📌 SAME_STREET', c.same_street ? 'כן' : 'לא'],
      ['🔁 זוהה', c.detection_count + ' פעמים'],
    ];
    return rows.map(([label, val]) => (
      '<div class="sig-row"><span>' + label + '</span><b>' + (typeof val === 'number' ? fmtNum(val) : escapeHtml(val)) + '</b></div>'
    )).join('');
  }

  function renderCard(r) {
    const borderline = r.latest_distance_m != null && r.latest_distance_m >= 50 && r.latest_distance_m <= 60;
    const hasExisting = !!r.existingActivity;
    return '<div class="review-card" data-id="' + r.id + '">' +
      '<div class="card-top" data-open="' + r.id + '">' +
        '<span class="badge case-' + r.case_type + '">' + (CASE_LABELS[r.case_type] || r.case_type) + '</span>' +
        '<span class="badge status-' + r.status + '">' + STATUS_LABELS[r.status] + '</span>' + cleanerBadge(r) +
        (r.detection_count > 1 ? '<span class="badge recurring">🔁 זוהה ' + r.detection_count + ' פעמים</span>' : '') +
        (r.same_street ? '<span class="badge samestreet">🛣️ התאמת רחוב</span>' : '') +
        (borderline ? '<span class="badge warn5060">⚠️ מרחק גבולי</span>' : '') +
        '<span class="card-spacer"></span>' +
        '<span style="font-size:11px;color:oklch(0.5 0.02 235)">' + escapeHtml(r.candidate_settlement || '') + '</span>' +
      '</div>' +
      (borderline ? '<div class="warn-banner">⚠️ מרחק גבולי: ' + fmtNum(r.latest_distance_m, 1) + ' מטר - זהו סימון חזותי בלבד, לא שינוי בסיווג.</div>' : '') +
      (r.same_street ? '<div class="samestreet-banner">🛣️ אותו רחוב זוהה — נדרשת בדיקה ידנית. (מידע ייעוצי בלבד)</div>' : '') +
      '<div class="compare-row">' +
        '<div class="compare-side">' +
          '<h4>מועמד (Google)</h4>' +
          (r.candidate_image ? '<img class="thumb" src="' + escapeHtml(r.candidate_image) + '">' : '<div class="no-image">📷</div>') +
          '<div class="name">' + escapeHtml(r.candidate_name || '(ללא שם)') + '</div>' +
          '<div class="field"><b>כתובת:</b> ' + escapeHtml(r.candidate_address || '—') + '</div>' +
          '<div class="field"><b>יישוב:</b> ' + escapeHtml(r.candidate_settlement || '—') + '</div>' +
          '<div class="field"><b>סוג:</b> ' + escapeHtml(r.place_kind || '—') + '</div>' +
          '<div class="field"><b>Place ID:</b> ' + escapeHtml(r.google_place_id || '—') + '</div>' +
          '<div class="field"><b>מקור:</b> ' + escapeHtml(r.source || '—') + (r.source_url ? ' · <a href="' + escapeHtml(r.source_url) + '" target="_blank" rel="noopener">קישור</a>' : '') + '</div>' +
        '</div>' +
        '<div class="compare-center">' +
          (r.latest_distance_m != null ? '<div class="distance-big">' + fmtNum(r.latest_distance_m, 1) + ' מטר</div>' : '<div class="distance-big" style="font-size:13px;color:oklch(0.5 0.02 235)">אין פעילות קיימת תואמת</div>') +
          '<div class="signals">' + renderSignals(r) + '</div>' +
        '</div>' +
        '<div class="compare-side">' +
          '<h4>פעילות קיימת</h4>' +
          (hasExisting ? (
            (r.existingActivity.image ? '<img class="thumb" src="' + escapeHtml(r.existingActivity.image) + '">' : '<div class="no-image">📷</div>') +
            '<div class="name">' + escapeHtml(r.existingActivity.name) + '</div>' +
            '<div class="field"><b>כתובת:</b> ' + escapeHtml(r.existingActivity.address || '—') + '</div>' +
            '<div class="field"><b>קטגוריה:</b> ' + escapeHtml(r.existingActivity.category || '—') + '</div>' +
            '<div class="field"><b>מזהה פעילות:</b> ' + escapeHtml(r.existingActivity.id) + '</div>' +
            '<div class="field"><b>Place ID:</b> ' + escapeHtml(r.existingActivity.google_place_id || '—') + '</div>'
          ) : '<div class="field">אין פעילות קיימת מתאימה - זה מועמד לפעילות חדשה.</div>') +
        '</div>' +
      '</div>' +
      renderCardActions(r) +
      '</div>';
  }

  function renderCardActions(r) {
    if (r.status !== 'needs_review') {
      return '<div class="decided-note">' + STATUS_LABELS[r.status] + (r.resolved_by === 'cleaner' ? ' · 🤖 המנקה' : '') + (r.resolved_at ? ' · ' + formatDate(r.resolved_at) : '') +
        (r.resolution_note ? ' · "' + escapeHtml(r.resolution_note) + '"' : '') +
        ' &nbsp; <button class="secondary-btn" data-action="redecide" data-id="' + r.id + '">שנה החלטה</button></div>';
    }
    return '<div class="card-actions">' +
      (r.existingActivity ? '<button class="primary-btn btn-dup" data-action="decide" data-decision="approved_duplicate" data-id="' + r.id + '">🔴 כפילות</button>' : '') +
      '<button class="primary-btn btn-new" data-action="decide" data-decision="approved_distinct" data-id="' + r.id + '">🟢 פעילות חדשה</button>' +
      '<button class="primary-btn btn-hold" data-action="decide" data-decision="dismissed" data-id="' + r.id + '">🟡 להשאיר לבדיקה</button>' +
      '<input type="text" class="note-input" placeholder="הערה (אופציונלי)..." id="note-' + r.id + '">' +
    '</div>';
  }

  async function loadList() {
    $statusText.textContent = 'טוען...';
    $statusText.parentElement.classList.remove('error');
    try {
      const f = currentFilters();
      const res = await fetch('/api/settlement-review?' + qs({ ...f, page, page_size: pageSize }));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      $list.innerHTML = data.items.map(renderCard).join('') || '<div class="empty-note">אין מקרים התואמים לסינון הנוכחי. 🎉</div>';
      $statusText.textContent = data.total + ' מקרים (עמוד ' + data.page + ' מתוך ' + Math.max(1, Math.ceil(data.total / pageSize)) + ')';
      $pagerRow.innerHTML =
        '<button ' + (data.page <= 1 ? 'disabled' : '') + ' data-page="prev">← הקודם</button>' +
        '<button ' + (data.page * pageSize >= data.total ? 'disabled' : '') + ' data-page="next">הבא →</button>';
    } catch (err) {
      $statusText.textContent = 'שגיאה בטעינה: ' + err.message;
      $statusText.parentElement.classList.add('error');
    }
  }

  $pagerRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    page += btn.dataset.page === 'next' ? 1 : -1;
    loadList();
  });

  async function decide(id, decision, note) {
    const messages = {
      approved_duplicate: 'אתם עומדים לסמן את המועמד ככפילות של הפעילות הקיימת.',
      approved_distinct: 'אתם עומדים לסמן את המועמד כפעילות חדשה ושונה. פעולה זו לא יוצרת פעילות אוטומטית - תפתח עבורכם טופס הוספה ידני.',
      dismissed: 'להשאיר את המקרה הזה פתוח לבדיקה מאוחרת יותר?',
    };
    // בלי danger:true בכלל - שלוש ההחלטות האלה אף פעם לא מוחקות שום דבר (confirmModal מציג
    // "מחיקה" קבוע במצב danger, שהיה מטעה כאן - "כפילות" רק רושם החלטה, לא מוחק את המועמד).
    const ok = await confirmModal(messages[decision]);
    if (!ok) return;
    try {
      const res = await fetch('/api/settlement-review/' + id + '/decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      if (decision === 'approved_distinct' && data.prefillUrl) {
        window.open(data.prefillUrl, '_blank', 'noopener');
      }
      await loadSummary();
      await loadList();
    } catch (err) {
      alert('שגיאה: ' + err.message);
    }
  }

  $list.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open]');
    if (openBtn && !e.target.closest('[data-action]')) { openDrawer(openBtn.dataset.open); return; }
    const actionBtn = e.target.closest('[data-action="decide"]');
    if (actionBtn) {
      const id = actionBtn.dataset.id;
      const noteEl = document.getElementById('note-' + id);
      decide(id, actionBtn.dataset.decision, noteEl ? noteEl.value.trim() : '');
      return;
    }
    const redecideBtn = e.target.closest('[data-action="redecide"]');
    if (redecideBtn) openDrawer(redecideBtn.dataset.id, true);
  });

  function renderRawGrid(pairs) {
    return '<div class="raw-grid">' + pairs.map(([k, v]) => (
      '<div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v == null ? '—' : v) + '</div>'
    )).join('') + '</div>';
  }

  function mapEmbed(lat, lon) {
    if (lat == null || lon == null) return '<div class="no-image" style="height:100%">אין קואורדינטות</div>';
    return '<iframe loading="lazy" src="https://www.google.com/maps?q=' + lat + ',' + lon + '&z=17&output=embed"></iframe>';
  }

  async function openDrawer(id, forceActions) {
    $drawerBody.innerHTML = '<div style="padding:30px;text-align:center;color:oklch(0.5 0.02 235)">טוען...</div>';
    $drawerBackdrop.classList.add('open');
    try {
      const res = await fetch('/api/settlement-review/' + id);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'שגיאה לא ידועה');
      const dirUrl = (d.candidate.lat != null && d.existingActivity)
        ? 'https://www.google.com/maps/dir/?api=1&origin=' + d.candidate.lat + ',' + d.candidate.lon + '&destination=' + d.existingActivity.lat + ',' + d.existingActivity.lng
        : null;
      $drawerBody.innerHTML =
        '<button class="drawer-close" id="drawerCloseBtn">✕</button>' +
        '<h2>' + escapeHtml(d.candidate_name) + '</h2>' +
        '<div style="font-size:12px;color:oklch(0.5 0.02 235)">' + (CASE_LABELS[d.case_type] || d.case_type) + ' · ' + STATUS_LABELS[d.status] + '</div>' +

        '<div class="drawer-section"><h3>מועמד - כל הפרטים</h3>' + renderRawGrid([
          ['שם', d.candidate_name], ['כתובת', d.candidate_address], ['יישוב', d.candidate.settlement_name],
          ['סוג מקום', d.candidate.place_kind], ['Google Place ID', d.google_place_id],
          ['קואורדינטות', d.candidate.lat != null ? d.candidate.lat + ', ' + d.candidate.lon : null],
          ['מקור', d.candidate.source], ['קישור מקור', d.candidate.source_url],
          ['נמצא לראשונה', formatDate(d.first_seen_at)], ['נמצא לאחרונה', formatDate(d.last_seen_at)],
          ['מספר זיהויים', d.detection_count],
        ]) + '</div>' +

        (d.existingActivity ? '<div class="drawer-section"><h3>פעילות קיימת - כל הפרטים</h3>' + renderRawGrid([
          ['שם', d.existingActivity.name], ['כתובת', d.existingActivity.address], ['עיר', d.existingActivity.city],
          ['אזור', d.existingActivity.region], ['קטגוריה', d.existingActivity.category], ['מזהה', d.existingActivity.id],
          ['Google Place ID', d.existingActivity.google_place_id],
          ['קואורדינטות', d.existingActivity.lat != null ? d.existingActivity.lat + ', ' + d.existingActivity.lng : null],
        ]) + '</div>' : '') +

        '<div class="drawer-section"><h3>התאמה</h3>' + renderRawGrid([
          ['מרחק', d.latest_distance_m != null ? fmtNum(d.latest_distance_m, 1) + ' מ\\'' : null],
          ['דמיון שם', d.name_similarity_score], ['דמיון רחוב', d.street_similarity_score],
          ['דמיון כתובת מלאה', d.address_similarity_score], ['מספר בית תואם', fmtBool(d.house_number_match != null ? d.house_number_match > 0 : null)],
          ['עיר תואמת', fmtBool(d.city_match)], ['שכונה תואמת', fmtBool(d.neighborhood_match)],
          ['SAME_STREET_REVIEW', d.same_street ? 'כן' : 'לא'], ['case_type', d.case_type], ['detection_count', d.detection_count],
        ]) + '</div>' +

        '<div class="drawer-section"><h3>מפה</h3><div class="map-row">' +
          '<div class="map-frame"><div class="map-label">מועמד</div>' + mapEmbed(d.candidate.lat, d.candidate.lon) + '</div>' +
          (d.existingActivity ? '<div class="map-frame"><div class="map-label">פעילות קיימת</div>' + mapEmbed(d.existingActivity.lat, d.existingActivity.lng) + '</div>' : '') +
        '</div>' + (dirUrl ? '<div style="margin-top:8px"><a href="' + dirUrl + '" target="_blank" rel="noopener">↗ פתחו מסלול/מרחק במפות גוגל</a></div>' : '') + '</div>' +

        (d.nearby && d.nearby.length ? '<div class="drawer-section"><h3>פעילויות קרובות נוספות</h3><ul class="nearby-list">' +
          d.nearby.map((n) => '<li>' + escapeHtml(n.name) + ' - ' + fmtNum(n.distance_m, 1) + ' מ\\'</li>').join('') + '</ul></div>' : '') +

        (d.detectedSettlements && d.detectedSettlements.length ? '<div class="drawer-section"><h3>זוהה מחיפושים ביישובים</h3><div style="font-size:12px">' +
          d.detectedSettlements.map(escapeHtml).join(', ') + '</div></div>' : '') +

        '<div class="drawer-section"><h3>היסטוריית החלטות</h3>' +
          (d.decisions && d.decisions.length ? '<ul class="history-list">' + d.decisions.map((h) => (
            '<li>' + formatDate(h.decided_at) + ' - ' + STATUS_LABELS[h.new_status] + (h.note ? ' · "' + escapeHtml(h.note) + '"' : '') + '</li>'
          )).join('') + '</ul>' : '<div style="font-size:12px;color:oklch(0.5 0.02 235)">עדיין לא התקבלה החלטה.</div>') +
        '</div>' +

        (d.status === 'needs_review' || forceActions ? '<div class="drawer-section"><h3>החלטה</h3><div class="card-actions">' +
          (d.existingActivity ? '<button class="primary-btn btn-dup" data-drawer-decide="approved_duplicate">🔴 כפילות</button>' : '') +
          '<button class="primary-btn btn-new" data-drawer-decide="approved_distinct">🟢 פעילות חדשה</button>' +
          '<button class="primary-btn btn-hold" data-drawer-decide="dismissed">🟡 להשאיר לבדיקה</button>' +
          '<input type="text" class="note-input" id="drawerNote" placeholder="הערה (אופציונלי)...">' +
        '</div></div>' : '');

      document.getElementById('drawerCloseBtn').addEventListener('click', closeDrawer);
      $drawerBody.querySelectorAll('[data-drawer-decide]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const note = document.getElementById('drawerNote');
          await decide(id, btn.dataset.drawerDecide, note ? note.value.trim() : '');
          closeDrawer();
        });
      });
    } catch (err) {
      $drawerBody.innerHTML = '<button class="drawer-close" id="drawerCloseBtn2">✕</button><div style="padding:30px;color:oklch(0.5 0.18 25)">שגיאה: ' + escapeHtml(err.message) + '</div>';
      document.getElementById('drawerCloseBtn2').addEventListener('click', closeDrawer);
    }
  }

  function closeDrawer() { $drawerBackdrop.classList.remove('open'); }
  $drawerBackdrop.addEventListener('click', (e) => { if (e.target === $drawerBackdrop) closeDrawer(); });

  document.getElementById('fStatus').value = 'needs_review';
  loadSummary();
  loadList();
</script>
</body>
</html>`;
}

module.exports = { renderSettlementReviewPage };
