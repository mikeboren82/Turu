const { renderNav, NAV_STYLES } = require('./nav');

function renderIncomingPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - פעילויות שנמצאו</title>
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
  .top-row { margin-bottom: 20px; }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0; }

  .tabs-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 14px; }
  .tab-btn {
    border: 1px solid oklch(0.88 0.01 230); background: white; color: oklch(0.4 0.02 235);
    font-weight: 700; font-size: 12.5px; border-radius: 999px; padding: 7px 14px; cursor: pointer;
    font-family: inherit;
  }
  .tab-btn.active { background: oklch(0.52 0.11 225); border-color: oklch(0.52 0.11 225); color: white; }
  .tab-count { opacity: 0.75; }

  .status { margin: 12px 2px; font-size: 13.5px; color: oklch(0.5 0.02 235); }
  .status.error { color: oklch(0.5 0.18 25); font-weight: 600; }

  .bulk-bar {
    display: none; align-items: center; gap: 10px; margin-bottom: 12px;
    background: white; border: 1px solid oklch(0.9 0.01 230); border-radius: 12px; padding: 10px 14px;
  }
  .bulk-bar.visible { display: flex; }
  .bulk-select-all-btn {
    font-size: 12px; font-weight: 700; color: oklch(0.45 0.1 230); background: white;
    border: 1px solid oklch(0.85 0.03 230); border-radius: 999px; padding: 6px 12px; cursor: pointer;
  }
  .bulk-approve-btn {
    font-size: 12px; font-weight: 700; color: white; background: oklch(0.5 0.13 150);
    border: none; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  }
  .bulk-approve-btn:disabled { opacity: 0.45; cursor: default; }
  .item-list { display: flex; flex-direction: column; gap: 12px; }
  .item-card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
    display: flex; gap: 10px; align-items: flex-start;
  }
  .item-select-cb { width: 16px; height: 16px; flex-shrink: 0; margin-top: 3px; cursor: pointer; }
  .item-card-body { flex: 1; min-width: 0; }
  .item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .item-name { font-size: 14.5px; font-weight: 800; }
  .badge { font-size: 10.5px; font-weight: 800; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
  .badge.new { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .badge.update { background: oklch(0.95 0.07 80); color: oklch(0.5 0.13 80); }
  .badge.duplicate { background: oklch(0.93 0.005 235); color: oklch(0.5 0.02 235); }
  .badge.missing { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .badge.confidence-high { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .badge.confidence-mid { background: oklch(0.95 0.07 80); color: oklch(0.5 0.13 80); }
  .badge.confidence-low { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .badge.trust { background: oklch(0.94 0.08 250); color: oklch(0.45 0.15 260); }
  .badge.issue { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .badge.rights { background: oklch(0.96 0.05 70); color: oklch(0.5 0.13 60); }
  .item-meta { font-size: 12px; color: oklch(0.5 0.02 235); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .item-meta a { color: oklch(0.52 0.11 225); }
  .issues-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .fields-summary { font-size: 12.5px; color: oklch(0.35 0.02 235); margin-top: 8px; line-height: 1.7; }
  .fields-summary b { color: oklch(0.25 0.02 240); }

  .diff-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12.5px; }
  .diff-table td { padding: 5px 6px; border-bottom: 1px solid oklch(0.95 0.01 230); }
  .diff-table td:first-child { font-weight: 700; color: oklch(0.4 0.02 235); white-space: nowrap; width: 110px; }
  .diff-before { color: oklch(0.5 0.15 25); text-decoration: line-through; }
  .diff-after { color: oklch(0.45 0.13 150); font-weight: 700; }

  .item-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
  .primary-btn {
    background: oklch(0.52 0.11 225); color: white; border: none; border-radius: 999px;
    padding: 8px 16px; font-weight: 700; font-size: 12.5px; cursor: pointer; font-family: inherit;
  }
  .success-btn { background: oklch(0.5 0.13 150); }
  .warn-btn { background: oklch(0.55 0.13 60); }
  .secondary-btn {
    background: oklch(0.97 0.005 230); color: oklch(0.35 0.02 235); border: 1px solid oklch(0.88 0.01 230);
    border-radius: 999px; padding: 7px 14px; font-weight: 700; font-size: 12.5px; cursor: pointer; font-family: inherit;
  }
  .danger-btn { background: oklch(0.96 0.05 25); color: oklch(0.5 0.18 25); border: 1px solid oklch(0.85 0.08 25); }
  .reclassify-select {
    border: 1px solid oklch(0.88 0.01 230); border-radius: 999px; padding: 7px 10px;
    font-family: inherit; font-size: 12px; background: white; color: oklch(0.4 0.02 235);
  }
  .reviewed-note { font-size: 12px; color: oklch(0.5 0.02 235); margin-top: 8px; }
  .empty-note { font-size: 13px; color: oklch(0.5 0.02 235); padding: 20px 2px; text-align: center; }
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
    <h1>🆕 פעילויות שנמצאו - תיבת הכניסה של סריקות "מקורות מידע"</h1>
  </div>
  ${renderNav('incoming')}

  <div class="tabs-row" id="tabsRow"></div>
  <div id="status" class="status">טוען...</div>
  <div id="bulkBar" class="bulk-bar">
    <button id="bulkSelectAllBtn" class="bulk-select-all-btn" type="button">☑️ סמן הכל</button>
    <button id="bulkApproveBtn" class="bulk-approve-btn" type="button" disabled>אשר את הנבחרים</button>
  </div>
  <div id="itemList" class="item-list"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $status = document.getElementById('status');
  const $tabsRow = document.getElementById('tabsRow');
  const $list = document.getElementById('itemList');
  const $bulkBar = document.getElementById('bulkBar');
  const $bulkSelectAllBtn = document.getElementById('bulkSelectAllBtn');
  const $bulkApproveBtn = document.getElementById('bulkApproveBtn');

  let items = [];
  let activeTab = 'new';
  const selectedIds = new Set();
  // "אשר" קיים רק בטאבים האלה (ראו renderActions) - בטאבים אחרים (כפילויות/נעלמו/טופלו) אין
  // מה לאשר בכלל, אז שורת הסימון-המרוכז לא רלוונטית שם ומוסתרת.
  const BULK_APPROVABLE_TABS = new Set(['new', 'update']);

  const TABS = [
    { key: 'new', label: '🆕 חדשות', match: (r) => r.match_type === 'new' && ['new', 'needs_review'].includes(r.status) },
    { key: 'update', label: '🔄 עדכונים', match: (r) => r.match_type === 'update' && ['new', 'needs_review'].includes(r.status) },
    { key: 'duplicate', label: '👥 כפילויות', match: (r) => r.match_type === 'duplicate' && r.status !== 'rejected' },
    { key: 'missing', label: '⚠️ נעלמו מהמקור', match: (r) => r.status === 'missing_flagged' },
    { key: 'history', label: '✅ טופלו', match: (r) => ['approved', 'updated', 'rejected', 'archived_expired'].includes(r.status) },
  ];

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function formatDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('he-IL'); } catch { return iso; }
  }
  function confidenceClass(score) {
    if (score >= 0.9) return 'confidence-high';
    if (score >= 0.6) return 'confidence-mid';
    return 'confidence-low';
  }

  function renderTabs() {
    $tabsRow.innerHTML = TABS.map((t) => {
      const count = items.filter(t.match).length;
      return '<button class="tab-btn' + (t.key === activeTab ? ' active' : '') + '" data-tab="' + t.key + '">' +
        t.label + ' <span class="tab-count">(' + count + ')</span></button>';
    }).join('');
  }

  function renderFieldsSummary(c) {
    const parts = [];
    if (c.category) parts.push('<b>קטגוריה:</b> ' + escapeHtml(c.category));
    if (c.city) parts.push('<b>עיר:</b> ' + escapeHtml(c.city));
    if (c.location_name) parts.push('<b>מיקום:</b> ' + escapeHtml(c.location_name));
    if (c.price_type) parts.push('<b>מחיר:</b> ' + escapeHtml(c.price_type) + (c.price_amount != null ? ' (' + c.price_amount + ' ₪)' : ''));
    if (c.min_age != null || c.max_age != null) parts.push('<b>גילאים:</b> ' + (c.min_age ?? '?') + '-' + (c.max_age ?? '?'));
    if (c.schedule_type === 'one_time' && c.one_time_date) parts.push('<b>תאריך:</b> ' + escapeHtml(c.one_time_date));
    if (c.start_time) parts.push('<b>שעה:</b> ' + escapeHtml(c.start_time) + (c.end_time ? '-' + escapeHtml(c.end_time) : ''));
    if (c.description) parts.push('<div style="margin-top:4px;">' + escapeHtml(c.description) + '</div>');
    return '<div class="fields-summary">' + parts.join(' &nbsp;·&nbsp; ') + '</div>';
  }

  function renderDiff(diff) {
    const rows = Object.values(diff || {});
    if (!rows.length) return '';
    return '<table class="diff-table">' + rows.map((d) => (
      '<tr><td>' + escapeHtml(d.label) + '</td><td><span class="diff-before">' + escapeHtml(d.before ?? '—') +
      '</span> ← <span class="diff-after">' + escapeHtml(d.after ?? '—') + '</span></td></tr>'
    )).join('') + '</table>';
  }

  function renderImageWarnings(c) {
    const flagged = (c.images || []).filter((img) => img.needs_rights_review);
    if (!flagged.length) return '';
    return '<div class="issues-row"><span class="badge rights">⚠️ ' + flagged.length + ' תמונות ממקור חיצוני - דורש בדיקת זכויות</span></div>';
  }

  function renderActions(r) {
    if (r.match_type === 'missing') {
      const editHref = r.existingActivity ? '/activities?edit=' + r.existing_activity_id : null;
      return '<div class="item-actions">' +
        '<a class="secondary-btn" href="' + escapeHtml(r.page_url) + '" target="_blank" rel="noopener">🔍 פתיחת המקור</a>' +
        (editHref ? '<a class="secondary-btn" href="' + editHref + '" target="_blank" rel="noopener">✏️ עריכת הפעילות</a>' : '') +
        '<button class="secondary-btn" data-action="resolve-missing" data-mode="keep" data-id="' + r.id + '">✔️ השאירו כפי שהיא</button>' +
        '<button class="secondary-btn danger-btn" data-action="resolve-missing" data-mode="archive" data-id="' + r.id + '">🗄️ ארכוב</button>' +
      '</div>';
    }
    if (['approved', 'updated', 'rejected', 'archived_expired'].includes(r.status)) {
      const label = { approved: '✅ אושר', updated: '🔄 עודכן', rejected: '❌ נדחה', archived_expired: '🗄️ אורכב' }[r.status];
      return '<div class="reviewed-note">' + label + (r.reviewed_at ? ' · ' + formatDate(r.reviewed_at) : '') +
        (r.reject_reason ? ' · סיבה: ' + escapeHtml(r.reject_reason) : '') + '</div>';
    }
    const approveLabel = r.match_type === 'update' ? '✅ אשר עדכון' : '✅ אשר והוסף';
    return '<div class="item-actions">' +
      '<button class="primary-btn success-btn" data-action="approve" data-id="' + r.id + '">' + approveLabel + '</button>' +
      '<select class="reclassify-select" data-action="reclassify" data-id="' + r.id + '">' +
        '<option value="">סיווג מחדש...</option>' +
        '<option value="new">חדשה</option>' +
        '<option value="update">עדכון לפעילות קיימת</option>' +
        '<option value="duplicate">כפילות (התעלם)</option>' +
      '</select>' +
      '<button class="secondary-btn danger-btn" data-action="reject" data-id="' + r.id + '">❌ דחה</button>' +
    '</div>';
  }

  function renderCard(r) {
    const c = r.extracted_data || {};
    const conf = Math.round((r.confidence_score || 0) * 100);
    const selectable = BULK_APPROVABLE_TABS.has(activeTab);
    return '<div class="item-card">' +
      (selectable ? '<input type="checkbox" class="item-select-cb" data-id="' + r.id + '"' + (selectedIds.has(r.id) ? ' checked' : '') + '>' : '') +
      '<div class="item-card-body">' +
      '<div class="item-head">' +
        '<span class="item-name">' + escapeHtml(c.name || '(ללא שם)') + '</span>' +
        '<span class="badge ' + r.match_type + '">' + escapeHtml(r.match_type) + '</span>' +
        (r.match_type !== 'missing' ? '<span class="badge ' + confidenceClass(r.confidence_score) + '">ביטחון: ' + conf + '%</span>' : '') +
        (r.source_trust_score != null ? '<span class="badge trust">אמון מקור: ' + r.source_trust_score + '</span>' : '') +
      '</div>' +
      '<div class="item-meta">' +
        '<span>מקור: ' + escapeHtml(r.sourceName || '—') + '</span>' +
        '<span><a href="' + escapeHtml(r.page_url) + '" target="_blank" rel="noopener">🔗 הדף המקורי</a></span>' +
        '<span>נמצא: ' + formatDate(r.found_at) + '</span>' +
        (r.existingActivity ? '<span>פעילות קיימת: ' + escapeHtml(r.existingActivity.name) + '</span>' : '') +
        (c.venue_id ? '<span class="badge trust">🏬 מקום קנוני מזוהה</span>' : '') +
        (c.organizer_name ? '<span>מארגן: ' + escapeHtml(c.organizer_name) + '</span>' : '') +
      '</div>' +
      (r.validation_issues && r.validation_issues.length
        ? '<div class="issues-row">' + r.validation_issues.map((i) => '<span class="badge issue">⚠️ חסר: ' + escapeHtml(i) + '</span>').join('') + '</div>'
        : '') +
      renderImageWarnings(c) +
      (r.match_type === 'update' ? renderDiff(r.diff) : (r.match_type === 'missing' ? '' : renderFieldsSummary(c))) +
      renderActions(r) +
      '</div>' +
    '</div>';
  }

  let currentFiltered = [];

  function updateBulkBar() {
    const showBar = BULK_APPROVABLE_TABS.has(activeTab) && currentFiltered.length > 0;
    $bulkBar.classList.toggle('visible', showBar);
    if (!showBar) return;
    const validIds = new Set(currentFiltered.map((r) => r.id));
    Array.from(selectedIds).forEach((id) => { if (!validIds.has(id)) selectedIds.delete(id); });
    const allSelected = currentFiltered.every((r) => selectedIds.has(r.id));
    $bulkSelectAllBtn.textContent = allSelected ? '⬜ בטל סימון הכל' : '☑️ סמן הכל';
    $bulkApproveBtn.disabled = selectedIds.size === 0;
    $bulkApproveBtn.textContent = selectedIds.size > 0 ? 'אשר את הנבחרים (' + selectedIds.size + ')' : 'אשר את הנבחרים';
  }

  function renderList() {
    const tab = TABS.find((t) => t.key === activeTab);
    currentFiltered = items.filter(tab.match);
    $status.textContent = currentFiltered.length + ' פריטים.';
    $list.innerHTML = currentFiltered.map(renderCard).join('') || '<div class="empty-note">אין כרגע פריטים בטאב הזה. 🎉</div>';
    updateBulkBar();
  }

  $bulkSelectAllBtn.addEventListener('click', () => {
    const allSelected = currentFiltered.length > 0 && currentFiltered.every((r) => selectedIds.has(r.id));
    if (allSelected) selectedIds.clear();
    else currentFiltered.forEach((r) => selectedIds.add(r.id));
    renderList();
  });

  $bulkApproveBtn.addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    $bulkApproveBtn.disabled = true;
    $bulkApproveBtn.textContent = 'מאשר...';
    let failCount = 0;
    for (const id of ids) {
      try {
        const res = await fetch('/api/incoming/' + id + '/approve', { method: 'POST' });
        if (!res.ok) throw new Error();
      } catch {
        failCount++;
      }
    }
    selectedIds.clear();
    await load();
    if (failCount > 0) alert('אושרו בהצלחה, חוץ מ-' + failCount + ' פריטים שנכשלו.');
  });

  $list.addEventListener('change', (e) => {
    const cb = e.target.closest('.item-select-cb');
    if (cb) {
      if (cb.checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
      updateBulkBar();
      return;
    }
    const sel = e.target.closest('[data-action="reclassify"]');
    if (sel) reclassifyItem(sel.dataset.id, sel.value);
  });

  async function approveItem(id, btn) {
    btn.disabled = true;
    try {
      const res = await fetch('/api/incoming/' + id + '/approve', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      await load();
    } catch (err) {
      alert('שגיאה באישור: ' + err.message);
      btn.disabled = false;
    }
  }

  async function rejectItem(id) {
    const reason = prompt('סיבת דחייה (אופציונלי):', '');
    if (reason === null) return;
    try {
      const res = await fetch('/api/incoming/' + id + '/reject', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      await load();
    } catch (err) {
      alert('שגיאה בדחייה: ' + err.message);
    }
  }

  async function reclassifyItem(id, matchType) {
    if (!matchType) return;
    try {
      const res = await fetch('/api/incoming/' + id + '/reclassify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      await load();
    } catch (err) {
      alert('שגיאה בסיווג מחדש: ' + err.message);
    }
  }

  async function resolveMissing(id, action) {
    if (action === 'archive' && !await confirmModal('לארכב את הפעילות? היא תפסיק להופיע באפליקציה (לא נמחקת - אפשר לשחזר ידנית).', { danger: true })) return;
    try {
      const res = await fetch('/api/incoming/' + id + '/resolve-missing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      await load();
    } catch (err) {
      alert('שגיאה בטיפול: ' + err.message);
    }
  }

  $tabsRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    renderTabs();
    renderList();
  });

  $list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'approve') approveItem(id, btn);
    else if (btn.dataset.action === 'reject') rejectItem(id);
    else if (btn.dataset.action === 'resolve-missing') resolveMissing(id, btn.dataset.mode);
  });

  async function load() {
    try {
      const res = await fetch('/api/incoming');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      items = data.items;
      $status.className = 'status';
      renderTabs();
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

module.exports = { renderIncomingPage };
