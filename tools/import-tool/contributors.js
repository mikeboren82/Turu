const { renderNav, NAV_STYLES } = require('./nav');

function renderContributorsPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WABBIT - תורמי פעילויות</title>
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
  .wrap { max-width: 900px; margin: 0 auto; padding: 32px 20px 60px; }
  .logo-lockup { display: flex; align-items: center; gap: 8px; direction: ltr; margin-bottom: 4px; }
  .logo { font-family: 'Fredoka', 'Assistant', sans-serif; font-size: 26px; font-weight: 700; }
  .logo .wab { color: oklch(0.3 0.03 235); }
  .logo .bit { color: oklch(0.52 0.11 225); }
  .top-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 10px; }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0; }
  .back-link { font-size: 13px; font-weight: 700; color: oklch(0.52 0.11 225); text-decoration: none; }

  .toolbar {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 16px;
    padding: 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06); margin-bottom: 18px;
  }
  .toolbar input[type=text] {
    flex: 1; min-width: 160px; border: 1px solid oklch(0.88 0.01 230); border-radius: 10px;
    padding: 10px 14px; font-family: inherit; font-size: 13.5px;
  }
  .toolbar select {
    border: 1px solid oklch(0.88 0.01 230); border-radius: 10px; padding: 10px 14px;
    font-family: inherit; font-size: 13.5px; background: white;
  }
  .status { margin: 12px 2px; font-size: 13.5px; color: oklch(0.5 0.02 235); }
  .status.error { color: oklch(0.5 0.18 25); font-weight: 600; }

  .contributor-list { display: flex; flex-direction: column; gap: 10px; }
  .contributor-card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
  }
  .contributor-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .contributor-nickname { font-size: 14.5px; font-weight: 800; }
  .stars-badge {
    display: inline-flex; align-items: center; gap: 3px; font-size: 12.5px; font-weight: 800;
    background: oklch(0.96 0.05 90); color: oklch(0.5 0.13 80); border-radius: 999px; padding: 3px 10px;
  }
  .activity-count { font-size: 12px; color: oklch(0.5 0.02 235); flex: 1; }
  .contributor-meta { font-size: 12.5px; color: oklch(0.5 0.02 235); direction: ltr; margin-right: auto; }
  .contributor-details { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; font-size: 12.5px; color: oklch(0.4 0.02 235); }
  .contributor-details span b { color: oklch(0.25 0.02 240); font-weight: 700; }

  .activities-list { margin-top: 12px; padding-top: 12px; border-top: 1px solid oklch(0.95 0.01 230); display: flex; flex-direction: column; gap: 6px; }
  .activity-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; flex-wrap: wrap; }
  .activity-name { font-weight: 700; color: oklch(0.25 0.02 240); }
  .activity-sub { color: oklch(0.55 0.02 235); }
  .status-badge {
    font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 2px 9px; white-space: nowrap;
  }
  .status-badge.approved { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .status-badge.pending { background: oklch(0.95 0.07 80); color: oklch(0.5 0.13 80); }
  .status-badge.rejected { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .status-badge.archived { background: oklch(0.93 0.005 235); color: oklch(0.5 0.02 235); }
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
      <h1>תורמי פעילויות - משתמשים שהוסיפו פעילויות, כוכבים והפעילויות שלהם</h1>
    </div>
  </div>
  ${renderNav('contributors')}

  <div class="toolbar">
    <input id="search" type="text" placeholder="חיפוש לפי כינוי, טלפון או אימייל...">
    <select id="sort">
      <option value="stars">מיון: הכי הרבה כוכבים</option>
      <option value="count">מיון: הכי הרבה פעילויות</option>
      <option value="recent">מיון: נרשם/ה לאחרונה</option>
    </select>
  </div>
  <div id="status" class="status">טוען...</div>
  <div id="contributorList" class="contributor-list"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $search = document.getElementById('search');
  const $sort = document.getElementById('sort');
  const $status = document.getElementById('status');
  const $list = document.getElementById('contributorList');

  let allContributors = [];

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatDate(iso) {
    try { return new Date(iso).toLocaleDateString('he-IL'); } catch { return iso; }
  }

  const STATUS_LABELS = { approved: 'מאושר', pending: 'ממתין', rejected: 'נדחה', archived: 'בארכיון' };

  function matchesFilter(c) {
    const q = $search.value.trim().toLowerCase();
    if (!q) return true;
    return [c.nickname, c.phone, c.email].some((v) => (v || '').toLowerCase().includes(q));
  }

  function sortContributors(list) {
    const mode = $sort.value;
    const copy = [...list];
    if (mode === 'count') return copy.sort((a, b) => b.activities.length - a.activities.length);
    if (mode === 'recent') return copy.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return copy.sort((a, b) => b.stars - a.stars);
  }

  function renderActivities(c) {
    if (!c.activities || c.activities.length === 0) {
      return '<div class="activity-sub">עדיין לא תרם/ה פעילות</div>';
    }
    return '<div class="activities-list">' +
      c.activities.map((a) => (
        '<div class="activity-row">' +
          '<span class="status-badge ' + a.status + '">' + (STATUS_LABELS[a.status] || a.status) + '</span>' +
          '<span class="activity-name">' + escapeHtml(a.name) + '</span>' +
          '<span class="activity-sub">' + [a.category, a.city].filter(Boolean).map(escapeHtml).join(' · ') + '</span>' +
          '<span class="activity-sub" style="margin-right: auto;">' + formatDate(a.createdAt) + '</span>' +
        '</div>'
      )).join('') +
    '</div>';
  }

  function renderCard(c) {
    const details = [];
    if (c.phone) details.push('<span><b>טלפון:</b> ' + escapeHtml(c.phone) + '</span>');
    if (c.email) details.push('<span><b>אימייל:</b> ' + escapeHtml(c.email) + '</span>');
    details.push('<span><b>נרשם/ה:</b> ' + formatDate(c.createdAt) + '</span>');

    return '<div class="contributor-card">' +
      '<div class="contributor-head">' +
        '<span class="contributor-nickname">' + escapeHtml(c.nickname) + '</span>' +
        '<span class="stars-badge">⭐ ' + c.stars + '</span>' +
        '<span class="activity-count">' + c.activities.length + ' פעילויות</span>' +
      '</div>' +
      '<div class="contributor-details">' + details.join('') + '</div>' +
      renderActivities(c) +
    '</div>';
  }

  function renderAll() {
    const filtered = sortContributors(allContributors.filter(matchesFilter));
    $status.textContent = 'מציג ' + filtered.length + ' מתוך ' + allContributors.length + ' תורמים.';
    $status.className = 'status';
    $list.innerHTML = filtered.map(renderCard).join('') || '<div class="status">אין תורמים תואמים.</div>';
  }

  async function load() {
    try {
      const res = await fetch('/api/manage/contributors');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      allContributors = data.contributors;
      renderAll();
    } catch (err) {
      $status.textContent = 'שגיאה בטעינה: ' + err.message;
      $status.className = 'status error';
    }
  }

  $search.addEventListener('input', renderAll);
  $sort.addEventListener('change', renderAll);

  load();
</script>
</body>
</html>`;
}

module.exports = { renderContributorsPage };
