const { renderNav, NAV_STYLES } = require('./nav');

function renderPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - גילוי וייבוא אתרים חדשים</title>
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
  .wrap { max-width: 720px; margin: 0 auto; padding: 32px 20px 60px; }
  .top-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .back-link { font-size: 13px; font-weight: 700; color: oklch(0.52 0.11 225); text-decoration: none; }
  .logo-lockup { display: flex; align-items: center; gap: 8px; direction: ltr; }
  .logo { font-family: 'Fredoka', 'Assistant', sans-serif; font-size: 26px; font-weight: 700; }
  .logo .wab { color: oklch(0.3 0.03 235); }
  .logo .bit { color: oklch(0.52 0.11 225); }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0 0 28px; }
  .import-box {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 18px;
    padding: 18px; display: flex; gap: 10px; box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06);
  }
  .import-box input {
    flex: 1; border: 1px solid oklch(0.88 0.01 230); border-radius: 10px; padding: 12px 14px;
    font-family: inherit; font-size: 14px; direction: ltr; text-align: left;
  }
  .import-box button {
    border: none; background: oklch(0.52 0.11 225); color: white; font-weight: 700; font-size: 14.5px;
    border-radius: 10px; padding: 12px 22px; cursor: pointer; white-space: nowrap;
  }
  .import-box button:disabled { opacity: 0.5; cursor: default; }
  .status { margin: 16px 2px; font-size: 13.5px; color: oklch(0.5 0.02 235); }
  .status.error { color: oklch(0.5 0.18 25); font-weight: 600; }
  .results { margin-top: 22px; display: flex; flex-direction: column; gap: 14px; }
  .card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 16px;
    padding: 16px 18px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.06);
  }
  .card-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
  .card-title { font-size: 16px; font-weight: 800; }
  .source-link {
    font-size: 12px; font-weight: 700; color: oklch(0.52 0.11 225); text-decoration: none;
    white-space: nowrap; flex-shrink: 0; direction: ltr;
  }
  .source-link:hover { text-decoration: underline; }
  .badge {
    display: inline-block; font-size: 11.5px; font-weight: 700; color: oklch(0.52 0.11 225);
    background: oklch(0.95 0.02 225); border-radius: 7px; padding: 3px 9px; margin-inline-end: 6px;
  }
  .field-row { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; font-size: 13px; }
  .field { color: oklch(0.4 0.02 235); }
  .field b { color: oklch(0.22 0.02 240); font-weight: 700; }
  .field.empty { color: oklch(0.7 0.01 230); font-style: italic; }
  .desc { margin-top: 8px; font-size: 13.5px; color: oklch(0.45 0.02 235); line-height: 1.5; }
  .card-actions { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid oklch(0.93 0.01 230); }
  .save-status { font-size: 13px; color: oklch(0.5 0.02 235); }
  .save-status.success { color: oklch(0.45 0.1 150); font-weight: 700; }
  .save-status.error { color: oklch(0.5 0.18 25); font-weight: 600; }
  .select-wrap { display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; min-width: 0; }
  .select-box { width: 18px; height: 18px; flex-shrink: 0; accent-color: oklch(0.52 0.11 225); cursor: pointer; }
  .card.is-saved { opacity: 0.55; }
  .bulk-bar {
    display: none; align-items: center; justify-content: space-between; gap: 12px;
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 12px 16px; margin-top: 18px; position: sticky; top: 12px; z-index: 5;
    box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.08);
  }
  .select-all-wrap { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; cursor: pointer; }
  .save-selected-btn {
    border: none; background: oklch(0.52 0.11 225); color: white; font-weight: 700; font-size: 13.5px;
    border-radius: 999px; padding: 10px 18px; cursor: pointer; white-space: nowrap;
  }
  .save-selected-btn:disabled { opacity: 0.4; cursor: default; }
  .thumbs { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; border: 1px solid oklch(0.9 0.01 230); }
  .thumbs-label { font-size: 11.5px; color: oklch(0.5 0.02 235); width: 100%; margin-bottom: -2px; }

  .dup-summary { font-size: 13.5px; color: oklch(0.5 0.02 235); margin-bottom: 10px; }
  .dup-item {
    display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 12.5px;
    color: oklch(0.4 0.02 235); border-top: 1px solid oklch(0.95 0.01 230);
  }
  .dup-item:first-of-type { border-top: none; }
  .dup-item-info { flex: 1; min-width: 0; }
  .dup-item-error { color: oklch(0.5 0.18 25); font-weight: 600; }
  .archive-badge {
    display: inline-block; font-size: 11px; font-weight: 700; color: oklch(0.45 0.03 260);
    background: oklch(0.94 0.01 260); border-radius: 7px; padding: 3px 9px; margin-bottom: 8px;
  }
  .toggle-status-btn {
    border: 1px solid oklch(0.88 0.01 230); background: oklch(1 0 0); font-weight: 700; font-size: 12px;
    border-radius: 999px; padding: 6px 14px; cursor: pointer; white-space: nowrap;
  }
  .toggle-status-btn:disabled { opacity: 0.5; cursor: default; }
  .discover-snippet { color: oklch(0.55 0.02 235); display: block; margin-top: 2px; }
  .paste-box {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 18px;
    padding: 18px; margin-top: 12px; box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06);
    display: flex; flex-direction: column; gap: 10px;
  }
  .paste-box-label { font-size: 13px; font-weight: 700; color: oklch(0.4 0.02 235); }
  .paste-box textarea {
    width: 100%; border: 1px solid oklch(0.88 0.01 230); border-radius: 10px; padding: 12px 14px;
    font-family: inherit; font-size: 13px; direction: ltr; text-align: left; resize: vertical;
  }
  .paste-box input[type=text] {
    width: 100%; border: 1px solid oklch(0.88 0.01 230); border-radius: 10px; padding: 12px 14px;
    font-family: inherit; font-size: 13px; direction: rtl; text-align: right;
  }
  .paste-box .queries-used {
    font-size: 12px; color: oklch(0.5 0.02 235); direction: rtl;
  }
  .paste-box button {
    align-self: flex-start; border: none; background: oklch(0.52 0.11 225); color: white;
    font-weight: 700; font-size: 14px; border-radius: 10px; padding: 10px 20px; cursor: pointer;
  }
  .paste-box button:disabled { opacity: 0.5; cursor: default; }
  .match-banner {
    background: oklch(0.97 0.03 80); border: 1px solid oklch(0.85 0.06 80); border-radius: 12px;
    padding: 10px 12px; margin-bottom: 10px; font-size: 12.5px;
  }
  .match-banner-text { color: oklch(0.4 0.08 80); margin-bottom: 6px; }
  .match-check-btn {
    border: 1px solid oklch(0.5 0.12 80); background: oklch(1 0 0); color: oklch(0.4 0.1 80);
    font-weight: 700; font-size: 12px; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  }
  .match-check-btn:disabled { opacity: 0.5; cursor: default; }
  .match-result { margin-top: 8px; }
  .merge-reasoning { color: oklch(0.45 0.02 235); font-size: 12px; margin-bottom: 6px; }
  .merge-preview { color: oklch(0.4 0.02 235); font-size: 12px; margin-bottom: 4px; }
  .merge-confirm-btn {
    border: none; background: oklch(0.45 0.12 150); color: white; font-weight: 700; font-size: 12.5px;
    border-radius: 999px; padding: 8px 16px; cursor: pointer; margin-top: 4px;
  }
  .merge-confirm-btn:disabled { opacity: 0.5; cursor: default; }
  .match-no { color: oklch(0.5 0.02 235); font-size: 12px; }
  .match-no.error { color: oklch(0.5 0.18 25); }
  .match-merged { color: oklch(0.4 0.12 150); font-weight: 700; font-size: 12.5px; }
  .card { transition: opacity 0.4s ease; }
  .card.is-leaving { opacity: 0; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top-row">
    <div class="logo-lockup">
      <svg width="26" height="26" viewBox="0 0 24 24">
        <ellipse cx="9" cy="7" rx="3" ry="7.5" fill="oklch(0.62 0.16 40)" transform="rotate(-18 9 7)"/>
        <ellipse cx="15" cy="7" rx="3" ry="7.5" fill="oklch(0.52 0.11 225)" transform="rotate(18 15 7)"/>
      </svg>
      <div class="logo"><span class="wab">WAB</span><span class="bit">BIT</span></div>
    </div>
  </div>
  ${renderNav('import')}
  <h1>גילוי וייבוא אתרים חדשים</h1>

  <div class="import-box">
    <input id="url" type="text" placeholder="https://example.com/events" dir="ltr">
    <button id="go">ייבא</button>
  </div>
  <div id="status" class="status"></div>
  <div id="bulkBar" class="bulk-bar">
    <label class="select-all-wrap">
      <input type="checkbox" id="selectAll" class="select-box">
      <span>סמן הכל</span>
    </label>
    <button id="saveSelected" class="save-selected-btn" disabled>שמור פעילויות שנבחרו</button>
  </div>
  <div id="results" class="results"></div>

  <div id="discoverSection">
    <div class="paste-box">
      <div class="paste-box-label">כתבו תיאור כללי של מה שמחפשים (למשל "גן שעשועים בלב השרון") - נחפש בגוגל, נעבור כמה עמודי תוצאות, וגם ננסה ניסוחים דומים כדי למצוא עוד אפשרויות</div>
      <input id="discoverSearchQuery" type="text" placeholder="לדוגמה: גן שעשועים בלב השרון">
      <button id="discoverSearchGo">חפש בגוגל</button>
      <div id="discoverQueriesUsed" class="queries-used"></div>
    </div>
    <div class="paste-box">
      <div class="paste-box-label">הדביקו כאן קישורים שמצאתם או שקלוד מצא עבורכם (קישור אחד בכל שורה) - כל קישור ייבדק מול מה שכבר נסרק בעבר</div>
      <textarea id="discoverPaste" rows="5" placeholder="https://example1.co.il/events&#10;https://example2.co.il/kids" dir="ltr"></textarea>
      <button id="discoverPasteGo">בדוק קישורים</button>
    </div>
    <div id="discoverStatus" class="status"></div>
    <div id="discoverAlreadySeen" class="dup-summary"></div>
    <div id="discoverBar" class="bulk-bar">
      <label class="select-all-wrap">
        <input type="checkbox" id="discoverSelectAll" class="select-box">
        <span>סמן הכל</span>
      </label>
      <button id="discoverScrapeSelected" class="save-selected-btn" disabled>ייבא את הנבחרים</button>
    </div>
    <div id="discoverResults" class="results"></div>
  </div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $url = document.getElementById('url');
  const $go = document.getElementById('go');
  const $status = document.getElementById('status');
  const $results = document.getElementById('results');
  const $bulkBar = document.getElementById('bulkBar');
  const $selectAll = document.getElementById('selectAll');
  const $saveSelected = document.getElementById('saveSelected');

  const fieldLabels = {
    entity_type: 'סוג', schedule_type: 'לוח זמנים', recurring_days: 'ימים',
    start_time: 'משעה', end_time: 'עד שעה', one_time_date: 'תאריך',
    min_age: 'גיל מ-', max_age: 'גיל עד', price_type: 'מחיר',
    price_amount: 'סכום', location_name: 'מיקום', location_detail: 'פרטי מיקום',
    city: 'עיר/יישוב', region: 'אזור בארץ',
    category: 'קטגוריה', duration_minutes: 'משך (דקות)', indoor_outdoor: 'מקום',
    booking_requirement: 'הזמנה', weather_suitable: 'מזג אוויר מתאים',
    amenities: 'מתקנים', family_fit: 'התאמה למשפחה'
  };

  const valueLabels = {
    recurring: 'חוזר על עצמו', one_time: 'חד פעמי', fixed_hours: 'שעות פתיחה קבועות',
    free: 'חינם', fixed: 'מחיר קבוע', range: 'טווח מחירים',
    'מקום_קבוע': 'מקום קבוע', 'אירוע_קבוע': 'אירוע קבוע',
    indoor: 'בתוך מבנה', outdoor: 'בחוץ', both: 'בפנים ובחוץ',
    none: 'אין צורך להזמין', walk_in: 'ללא הרשמה', registration_required: 'דורש הרשמה',
    advance_booking: 'דורש הזמנה מראש', available_now: 'יש מקום פנוי'
  };

  function fieldHtml(key, value) {
    const label = fieldLabels[key] || key;
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      return '<span class="field empty">' + label + ': לא צוין</span>';
    }
    const shown = Array.isArray(value) ? value.join(', ') : (valueLabels[value] || value);
    return '<span class="field"><b>' + label + ':</b> ' + shown + '</span>';
  }

  function renderActivity(a, sourceUrl, index) {
    const fields = Object.keys(fieldLabels).map((k) => fieldHtml(k, a[k])).join('');
    const images = Array.isArray(a.image_urls) ? a.image_urls.filter((u) => typeof u === 'string' && u.trim()) : [];
    const thumbs = images.length
      ? '<div class="thumbs"><span class="thumbs-label">תמונות שזוהו (יישמרו אוטומטית):</span>' +
        images.map((url) => '<img src="' + url + '" loading="lazy" alt="">').join('') +
        '</div>'
      : '';
    const archiveBadge = a.willArchive
      ? '<span class="archive-badge">📦 חוג/קייטנה - יישמר בארכיון, לא יוצג באפליקציה</span>'
      : '';
    const topMatch = Array.isArray(a.possibleMatches) && a.possibleMatches.length > 0 ? a.possibleMatches[0] : null;
    const matchBanner = topMatch
      ? '<div class="match-banner">' +
          '<div class="match-banner-text">❓ יכול להיות שזו פעילות שכבר קיימת במאגר: <b>' + escapeHtml(topMatch.name) + '</b></div>' +
          '<button class="match-check-btn" data-index="' + index + '" data-existing-id="' + escapeHtml(topMatch.id) + '">בדוק אם כדאי לשלב במקום ליצור כפול</button>' +
          '<div class="match-result" data-match-result="' + index + '"></div>' +
        '</div>'
      : '';
    return '<div class="card" data-card-index="' + index + '">' +
      '<div class="card-title-row">' +
        '<label class="select-wrap">' +
          '<input type="checkbox" class="select-box" data-index="' + index + '">' +
          '<span class="card-title">' + (a.name || 'ללא שם') + '</span>' +
        '</label>' +
        '<a class="source-link" href="' + sourceUrl + '" target="_blank" rel="noopener noreferrer">🔗 מקור</a>' +
      '</div>' +
      archiveBadge +
      matchBanner +
      (a.description ? '<div class="desc">' + a.description + '</div>' : '') +
      '<div class="field-row">' + fields + '</div>' +
      thumbs +
      '<div class="card-actions">' +
        '<span class="save-status"></span>' +
      '</div>' +
      '</div>';
  }

  let currentActivities = [];
  let currentSourceUrls = [];
  let selectedIndexes = new Set();
  let savedIndexes = new Set();

  function cardStatusEl(index) {
    const card = $results.querySelector('.card[data-card-index="' + index + '"]');
    return card ? card.querySelector('.save-status') : null;
  }

  function scheduleCardRemoval(index) {
    setTimeout(() => {
      const card = $results.querySelector('.card[data-card-index="' + index + '"]');
      if (!card) return;
      card.classList.add('is-leaving');
      setTimeout(() => card.remove(), 400);
    }, 900);
  }

  function updateBulkBar() {
    const count = selectedIndexes.size;
    $saveSelected.disabled = count === 0;
    $saveSelected.textContent = count > 0 ? 'שמור ' + count + ' פעילויות שנבחרו' : 'שמור פעילויות שנבחרו';
    const selectableCount = currentActivities.length - savedIndexes.size;
    $selectAll.checked = selectableCount > 0 && count === selectableCount;
  }

  async function runImport() {
    const url = $url.value.trim();
    if (!url) return;
    $go.disabled = true;
    $status.textContent = 'טוען וקורא את הדף...';
    $status.className = 'status';
    $results.innerHTML = '';
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      currentActivities = data.activities;
      currentSourceUrls = data.activities.map(() => data.sourceUrl);
      selectedIndexes = new Set();
      savedIndexes = new Set();
      $status.textContent = 'נמצאו ' + data.activities.length + ' פעילויות. סמנו את הפעילויות שנראות תקינות ולחצו "שמור פעילויות שנבחרו".' +
        (data.truncated ? ' ⚠️ ייתכן שיש עוד פעילויות בעמוד הזה שלא נכנסו - התשובה נקטעה.' : '');
      if (data.truncated) $status.className = 'status error';
      $results.innerHTML = data.activities.map((a, i) => renderActivity(a, data.sourceUrl, i)).join('');
      $bulkBar.style.display = data.activities.length > 0 ? 'flex' : 'none';
      $selectAll.checked = false;
      updateBulkBar();
    } catch (err) {
      $status.textContent = 'שגיאה: ' + err.message;
      $status.className = 'status error';
      $bulkBar.style.display = 'none';
    } finally {
      $go.disabled = false;
    }
  }

  async function saveOne(index) {
    const activity = currentActivities[index];
    const statusEl = cardStatusEl(index);
    if (statusEl) {
      statusEl.className = 'save-status';
      statusEl.textContent = 'שומר...';
    }
    try {
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUrl: currentSourceUrls[index], activity }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      savedIndexes.add(index);
      selectedIndexes.delete(index);
      if (statusEl) {
        statusEl.className = 'save-status success';
        statusEl.textContent = data.archived ? '✓ נשמר בארכיון (לא יוצג באפליקציה)' : '✓ נשמר ופעיל באפליקציה';
      }
      const card = $results.querySelector('.card[data-card-index="' + index + '"]');
      if (card) {
        card.classList.add('is-saved');
        const checkbox = card.querySelector('.select-box');
        if (checkbox) { checkbox.checked = false; checkbox.disabled = true; }
      }
      scheduleCardRemoval(index);
      return true;
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'save-status error';
        statusEl.textContent = 'שגיאה: ' + err.message;
      }
      return false;
    }
  }

  async function saveSelected() {
    const indexes = Array.from(selectedIndexes);
    if (indexes.length === 0) return;
    $saveSelected.disabled = true;
    for (const index of indexes) {
      await saveOne(index);
    }
    updateBulkBar();
  }

  $go.addEventListener('click', runImport);
  $url.addEventListener('keydown', (e) => { if (e.key === 'Enter') runImport(); });

  $results.addEventListener('change', (e) => {
    const box = e.target.closest('.select-box');
    if (!box) return;
    const index = Number(box.dataset.index);
    if (box.checked) selectedIndexes.add(index);
    else selectedIndexes.delete(index);
    updateBulkBar();
  });

  $selectAll.addEventListener('change', () => {
    if ($selectAll.checked) {
      currentActivities.forEach((_, i) => { if (!savedIndexes.has(i)) selectedIndexes.add(i); });
    } else {
      selectedIndexes.clear();
    }
    $results.querySelectorAll('.select-box:not(:disabled)').forEach((box) => {
      box.checked = $selectAll.checked;
    });
    updateBulkBar();
  });

  $saveSelected.addEventListener('click', saveSelected);

  $results.addEventListener('click', async (e) => {
    const checkBtn = e.target.closest('.match-check-btn');
    if (checkBtn) {
      const index = Number(checkBtn.dataset.index);
      const existingId = checkBtn.dataset.existingId;
      const activity = currentActivities[index];
      const resultEl = $results.querySelector('.match-result[data-match-result="' + index + '"]');
      checkBtn.disabled = true;
      checkBtn.textContent = 'בודק...';
      try {
        const res = await fetch('/api/suggest-merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ existingActivityId: existingId, candidate: activity }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        if (!data.isMatch) {
          resultEl.innerHTML = '<div class="match-no">לא זוהתה התאמה אמיתית - אפשר לשמור כרגיל כפעילות נפרדת.' +
            (data.reasoning ? ' (' + escapeHtml(data.reasoning) + ')' : '') + '</div>';
          checkBtn.style.display = 'none';
          return;
        }
        const mergedFields = data.mergedFields || {};
        const imagesToAdd = data.image_urls_to_add || [];
        const fieldsPreview = Object.keys(mergedFields).length
          ? '<div class="merge-preview">שדות שיתעדכנו: ' + escapeHtml(Object.keys(mergedFields).map((k) => fieldLabels[k] || k).join(', ')) + '</div>'
          : '<div class="merge-preview">אין שדות טקסט לעדכן.</div>';
        const imagesPreview = imagesToAdd.length
          ? '<div class="merge-preview">תמונות שיתווספו: ' + imagesToAdd.length + '</div>'
          : '';
        resultEl.innerHTML =
          (data.reasoning ? '<div class="merge-reasoning">' + escapeHtml(data.reasoning) + '</div>' : '') +
          fieldsPreview + imagesPreview +
          '<button class="merge-confirm-btn" data-index="' + index + '" data-existing-id="' + escapeHtml(existingId) + '">אשר שילוב לפעילות הקיימת</button>';
        resultEl.dataset.mergedFields = JSON.stringify(mergedFields);
        resultEl.dataset.imagesToAdd = JSON.stringify(imagesToAdd);
        checkBtn.style.display = 'none';
      } catch (err) {
        resultEl.innerHTML = '<div class="match-no error">שגיאה: ' + escapeHtml(err.message) + '</div>';
        checkBtn.disabled = false;
        checkBtn.textContent = 'בדוק אם כדאי לשלב במקום ליצור כפול';
      }
      return;
    }

    const mergeBtn = e.target.closest('.merge-confirm-btn');
    if (mergeBtn) {
      const index = Number(mergeBtn.dataset.index);
      const existingId = mergeBtn.dataset.existingId;
      const resultEl = $results.querySelector('.match-result[data-match-result="' + index + '"]');
      const mergedFields = JSON.parse(resultEl.dataset.mergedFields || '{}');
      const imageUrlsToAdd = JSON.parse(resultEl.dataset.imagesToAdd || '[]');
      mergeBtn.disabled = true;
      mergeBtn.textContent = 'משלב...';
      try {
        const res = await fetch('/api/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ existingActivityId: existingId, mergedFields, imageUrlsToAdd }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        resultEl.innerHTML = '<div class="match-merged">✓ שולב לתוך הפעילות הקיימת. לא נשמר כפעילות כפולה.</div>';
        savedIndexes.add(index);
        selectedIndexes.delete(index);
        const card = $results.querySelector('.card[data-card-index="' + index + '"]');
        if (card) {
          card.classList.add('is-saved');
          const checkbox = card.querySelector('.select-box');
          if (checkbox) { checkbox.checked = false; checkbox.disabled = true; }
        }
        scheduleCardRemoval(index);
        updateBulkBar();
      } catch (err) {
        mergeBtn.disabled = false;
        mergeBtn.textContent = 'אשר שילוב לפעילות הקיימת';
        resultEl.innerHTML += '<div class="match-no error">שגיאה: ' + escapeHtml(err.message) + '</div>';
      }
      return;
    }
  });

  const $discoverStatus = document.getElementById('discoverStatus');
  const $discoverAlreadySeen = document.getElementById('discoverAlreadySeen');
  const $discoverResults = document.getElementById('discoverResults');
  const $discoverBar = document.getElementById('discoverBar');
  const $discoverSelectAll = document.getElementById('discoverSelectAll');
  const $discoverScrapeSelected = document.getElementById('discoverScrapeSelected');

  let discoverCandidates = [];
  let discoverSelectedUrls = new Set();
  let lastSearchQuery = '';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderDiscoverCandidate(c) {
    const selected = discoverSelectedUrls.has(c.url);
    return '<div class="dup-item">' +
      '<input type="checkbox" class="select-box discover-select-box" data-url="' + escapeHtml(c.url) + '"' + (selected ? ' checked' : '') + '>' +
      '<span class="dup-item-info">' +
        '<a class="source-link" href="' + escapeHtml(c.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(c.title || c.url) + '</a>' +
        ' · ' + escapeHtml(c.domain || '') +
        '<span class="discover-snippet">' + escapeHtml(c.snippet || '') + '</span>' +
        (c.error ? '<span class="dup-item-error"> - ' + escapeHtml(c.error) + '</span>' : '') +
      '</span>' +
      '<button class="toggle-status-btn discover-skip-btn" data-url="' + escapeHtml(c.url) + '">דלג</button>' +
    '</div>';
  }

  const sourceStatusLabels = { scraped: 'נסרק בעבר', error: 'נכשל בעבר', skipped: 'דולג בעבר', pending: 'ממתין' };

  function renderAlreadySeen(list) {
    if (!list || list.length === 0) {
      $discoverAlreadySeen.innerHTML = '';
      return;
    }
    $discoverAlreadySeen.innerHTML = 'קישורים שכבר מוכרים למערכת (לא נבדקו שוב):<br>' +
      list.map((x) => '· ' + escapeHtml(x.url) + ' <span class="field empty">(' + (sourceStatusLabels[x.status] || x.status) + ')</span>').join('<br>');
  }

  function renderDiscoverList() {
    $discoverResults.innerHTML = discoverCandidates.length === 0
      ? '<div class="dup-summary">אין תוצאות חדשות להצגה.</div>'
      : discoverCandidates.map(renderDiscoverCandidate).join('');
  }

  function updateDiscoverBar() {
    const count = discoverSelectedUrls.size;
    $discoverScrapeSelected.disabled = count === 0;
    $discoverScrapeSelected.textContent = count > 0 ? 'ייבא ' + count + ' אתרים שנבחרו' : 'ייבא את הנבחרים';
    $discoverSelectAll.checked = discoverCandidates.length > 0 && count === discoverCandidates.length;
  }

  const $discoverPaste = document.getElementById('discoverPaste');
  const $discoverPasteGo = document.getElementById('discoverPasteGo');
  const $discoverSearchQuery = document.getElementById('discoverSearchQuery');
  const $discoverSearchGo = document.getElementById('discoverSearchGo');
  const $discoverQueriesUsed = document.getElementById('discoverQueriesUsed');

  async function runDiscoverSearch() {
    const query = $discoverSearchQuery.value.trim();
    if (!query) return;
    lastSearchQuery = query;
    $discoverSearchGo.disabled = true;
    $discoverSearchGo.textContent = 'מחפש בגוגל... (יכול לקחת כדקה)';
    $discoverStatus.textContent = 'מחפש בגוגל ומנסה כמה ניסוחים...';
    $discoverStatus.className = 'status';
    $discoverAlreadySeen.innerHTML = '';
    $discoverQueriesUsed.textContent = '';
    discoverSelectedUrls = new Set();
    $discoverBar.style.display = 'none';
    try {
      const res = await fetch('/api/discover/google-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      discoverCandidates = data.candidates;
      $discoverStatus.textContent = 'נמצאו ' + data.totalFound + ' קישורים, ' + data.candidates.length + ' מהם חדשים' +
        (data.alreadySeen ? ' (' + data.alreadySeen + ' כבר נסרקו בעבר ולא מוצגים שוב)' : '') + '.';
      if (Array.isArray(data.queriesUsed) && data.queriesUsed.length > 1) {
        $discoverQueriesUsed.textContent = 'ניסוחים שנבדקו: ' + data.queriesUsed.join(' · ');
      }
      renderAlreadySeen(data.alreadySeenList);
      renderDiscoverList();
      $discoverBar.style.display = discoverCandidates.length > 0 ? 'flex' : 'none';
      updateDiscoverBar();
    } catch (err) {
      $discoverStatus.textContent = 'שגיאה: ' + err.message;
      $discoverStatus.className = 'status error';
    } finally {
      $discoverSearchGo.disabled = false;
      $discoverSearchGo.textContent = 'חפש בגוגל';
    }
  }

  $discoverSearchGo.addEventListener('click', runDiscoverSearch);
  $discoverSearchQuery.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runDiscoverSearch();
  });

  async function runDiscoverPaste() {
    const lines = $discoverPaste.value.split('\\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    lastSearchQuery = 'ידני';
    $discoverPasteGo.disabled = true;
    $discoverStatus.textContent = 'בודק מול המאגר הקיים...';
    $discoverStatus.className = 'status';
    $discoverAlreadySeen.innerHTML = '';
    discoverSelectedUrls = new Set();
    $discoverBar.style.display = 'none';
    try {
      const res = await fetch('/api/discover/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: lines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      discoverCandidates = data.candidates;
      $discoverStatus.textContent = 'נבדקו ' + data.totalFound + ' קישורים, ' + data.candidates.length + ' מהם חדשים' +
        (data.alreadySeen ? ' (' + data.alreadySeen + ' כבר נסרקו בעבר ולא מוצגים שוב)' : '') + '.';
      renderAlreadySeen(data.alreadySeenList);
      renderDiscoverList();
      $discoverBar.style.display = discoverCandidates.length > 0 ? 'flex' : 'none';
      updateDiscoverBar();
      $discoverPaste.value = '';
    } catch (err) {
      $discoverStatus.textContent = 'שגיאה: ' + err.message;
      $discoverStatus.className = 'status error';
    } finally {
      $discoverPasteGo.disabled = false;
    }
  }

  $discoverPasteGo.addEventListener('click', runDiscoverPaste);

  $discoverResults.addEventListener('change', (e) => {
    const box = e.target.closest('.discover-select-box');
    if (!box) return;
    const url = box.dataset.url;
    if (box.checked) discoverSelectedUrls.add(url);
    else discoverSelectedUrls.delete(url);
    updateDiscoverBar();
  });

  $discoverSelectAll.addEventListener('change', () => {
    if ($discoverSelectAll.checked) {
      discoverCandidates.forEach((c) => discoverSelectedUrls.add(c.url));
    } else {
      discoverSelectedUrls.clear();
    }
    $discoverResults.querySelectorAll('.discover-select-box').forEach((box) => { box.checked = $discoverSelectAll.checked; });
    updateDiscoverBar();
  });

  $discoverResults.addEventListener('click', async (e) => {
    const skipBtn = e.target.closest('.discover-skip-btn');
    if (!skipBtn) return;
    const url = skipBtn.dataset.url;
    const c = discoverCandidates.find((x) => x.url === url);
    skipBtn.disabled = true;
    skipBtn.textContent = '...';
    try {
      const res = await fetch('/api/discover/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: c ? c.title : '', searchQuery: lastSearchQuery }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      discoverCandidates = discoverCandidates.filter((x) => x.url !== url);
      discoverSelectedUrls.delete(url);
      renderDiscoverList();
      updateDiscoverBar();
    } catch (err) {
      skipBtn.disabled = false;
      skipBtn.textContent = 'דלג';
      if (c) c.error = err.message;
      renderDiscoverList();
    }
  });

  $discoverScrapeSelected.addEventListener('click', async () => {
    const urls = Array.from(discoverSelectedUrls);
    if (urls.length === 0) return;
    $discoverScrapeSelected.disabled = true;
    $discoverScrapeSelected.textContent = 'סורק וממיין...';
    try {
      const res = await fetch('/api/discover/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, searchQuery: lastSearchQuery }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');

      const combinedActivities = [];
      const combinedSourceUrls = [];
      let errorCount = 0;
      data.results.forEach((r) => {
        if (r.error) { errorCount++; return; }
        r.activities.forEach((a) => { combinedActivities.push(a); combinedSourceUrls.push(r.sourceUrl); });
      });

      currentActivities = combinedActivities;
      currentSourceUrls = combinedSourceUrls;
      selectedIndexes = new Set();
      savedIndexes = new Set();
      $status.textContent = 'נמצאו ' + combinedActivities.length + ' פעילויות מתוך ' + urls.length + ' אתרים' +
        (errorCount ? ' (נכשלו לסרוק ' + errorCount + ' מהם)' : '') + '. סמנו את הפעילויות שנראות תקינות ולחצו "שמור פעילויות שנבחרו".';
      $status.className = errorCount ? 'status error' : 'status';
      $results.innerHTML = combinedActivities.map((a, i) => renderActivity(a, combinedSourceUrls[i], i)).join('');
      $bulkBar.style.display = combinedActivities.length > 0 ? 'flex' : 'none';
      $selectAll.checked = false;
      updateBulkBar();

      discoverCandidates = discoverCandidates.filter((c) => !urls.includes(c.url));
      discoverSelectedUrls = new Set();
      renderDiscoverList();
      updateDiscoverBar();

      $results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      $discoverStatus.textContent = 'שגיאה: ' + err.message;
      $discoverStatus.className = 'status error';
    } finally {
      $discoverScrapeSelected.disabled = false;
      $discoverScrapeSelected.textContent = 'ייבא את הנבחרים';
    }
  });
</script>
</body>
</html>`;
}

module.exports = { renderPage };
