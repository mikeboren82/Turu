const { renderNav, NAV_STYLES } = require('./nav');

function renderFeedbackPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WABBIT - דיווחי משתמשים</title>
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
  .status { margin: 12px 2px; font-size: 13.5px; color: oklch(0.5 0.02 235); }
  .status.error { color: oklch(0.5 0.18 25); font-weight: 600; }

  .feedback-list { display: flex; flex-direction: column; gap: 10px; }
  .feedback-card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
  }
  .feedback-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .feedback-date { font-size: 12px; color: oklch(0.5 0.02 235); direction: ltr; }
  .feedback-badges { display: flex; gap: 6px; }
  .badge {
    font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 3px 10px; white-space: nowrap;
  }
  .badge.page { background: oklch(0.94 0.03 230); color: oklch(0.45 0.08 230); }
  .badge.user { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .badge.anon { background: oklch(0.93 0.005 235); color: oklch(0.5 0.02 235); }
  .feedback-message { font-size: 14px; color: oklch(0.25 0.02 240); line-height: 1.5; white-space: pre-wrap; }
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
      <h1>דיווחי משתמשים - "משהו לא עובד? דווח לנו"</h1>
    </div>
  </div>
  ${renderNav('feedback')}

  <div class="toolbar">
    <input id="search" type="text" placeholder="חיפוש בתוכן הדיווח...">
  </div>
  <div id="status" class="status">טוען...</div>
  <div id="feedbackList" class="feedback-list"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $search = document.getElementById('search');
  const $status = document.getElementById('status');
  const $list = document.getElementById('feedbackList');

  let allFeedback = [];

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatDateTime(iso) {
    try { return new Date(iso).toLocaleString('he-IL'); } catch { return iso; }
  }

  function matchesFilter(f) {
    const q = $search.value.trim().toLowerCase();
    if (!q) return true;
    return (f.message || '').toLowerCase().includes(q);
  }

  function renderCard(f) {
    const badges = [];
    if (f.page) badges.push('<span class="badge page">' + escapeHtml(f.page) + '</span>');
    badges.push(f.nickname
      ? '<span class="badge user">' + escapeHtml(f.nickname) + '</span>'
      : '<span class="badge anon">אנונימי</span>');

    return '<div class="feedback-card">' +
      '<div class="feedback-head">' +
        '<div class="feedback-badges">' + badges.join('') + '</div>' +
        '<span class="feedback-date">' + formatDateTime(f.createdAt) + '</span>' +
      '</div>' +
      '<div class="feedback-message">' + escapeHtml(f.message) + '</div>' +
    '</div>';
  }

  function renderAll() {
    const filtered = allFeedback.filter(matchesFilter);
    $status.textContent = 'מציג ' + filtered.length + ' מתוך ' + allFeedback.length + ' דיווחים.';
    $status.className = 'status';
    $list.innerHTML = filtered.map(renderCard).join('') || '<div class="status">אין דיווחים תואמים.</div>';
  }

  async function load() {
    try {
      const res = await fetch('/api/manage/feedback');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      allFeedback = data.feedback;
      renderAll();
    } catch (err) {
      $status.textContent = 'שגיאה בטעינה: ' + err.message;
      $status.className = 'status error';
    }
  }

  $search.addEventListener('input', renderAll);

  load();
</script>
</body>
</html>`;
}

module.exports = { renderFeedbackPage };
