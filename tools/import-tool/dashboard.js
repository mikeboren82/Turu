const { renderNav, NAV_STYLES } = require('./nav');

function renderDashboardPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - דשבורד ניהול</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Assistant:wght@400;500;600;700;800&display=swap">
<style>
  * { box-sizing: border-box; }
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
  .top-row { margin-bottom: 22px; }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0 0 18px; }
  ${NAV_STYLES}

  .status { margin: 12px 2px; font-size: 13.5px; color: oklch(0.5 0.02 235); }
  .status.error { color: oklch(0.5 0.18 25); font-weight: 600; }

  .cards-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .stat-card {
    display: block; text-decoration: none; text-align: right; cursor: pointer;
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 16px;
    padding: 16px 18px; box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06);
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }
  .stat-card:hover { transform: translateY(-2px); box-shadow: 0 8px 22px oklch(0.3 0.02 230 / 0.1); }
  .stat-card-icon { font-size: 20px; margin-bottom: 6px; }
  .stat-card-value { font-size: 26px; font-weight: 800; color: oklch(0.25 0.02 240); }
  .stat-card-label { font-size: 12.5px; font-weight: 700; color: oklch(0.5 0.02 235); margin-top: 2px; }
  .stat-card.tint-total { border-inline-start: 4px solid oklch(0.52 0.11 225); }
  .stat-card.tint-pending { border-inline-start: 4px solid oklch(0.55 0.14 150); }
  .stat-card.tint-issues { border-inline-start: 4px solid oklch(0.55 0.18 25); }
  .stat-card.tint-stale { border-inline-start: 4px solid oklch(0.65 0.15 60); }
  .stat-card.tint-photo { border-inline-start: 4px solid oklch(0.6 0.1 280); }

  .section-title { font-size: 15px; font-weight: 800; margin: 0 0 12px; color: oklch(0.3 0.02 235); }
  .feed-list { display: flex; flex-direction: column; gap: 8px; }
  .feed-card {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 12px;
    padding: 12px 14px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
  }
  .feed-name { font-weight: 700; font-size: 13.5px; }
  .feed-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
  .feed-tag {
    font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 2px 9px;
    background: oklch(0.95 0.05 25); color: oklch(0.5 0.15 25);
  }
  .feed-tag.stale-tag { background: oklch(0.96 0.05 70); color: oklch(0.5 0.13 60); }
  .feed-edit-link {
    font-size: 12.5px; font-weight: 700; color: white; background: oklch(0.52 0.11 225);
    text-decoration: none; border-radius: 999px; padding: 7px 14px; white-space: nowrap;
  }
  .empty-note { font-size: 13px; color: oklch(0.5 0.02 235); padding: 14px 2px; }
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
    <h1>מה דורש ממני טיפול?</h1>
    ${renderNav('dashboard')}
  </div>

  <div id="status" class="status">טוען...</div>
  <div id="cardsRow" class="cards-row"></div>

  <div class="section-title">פעילויות שדורשות טיפול</div>
  <div id="feedList" class="feed-list"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $status = document.getElementById('status');
  const $cardsRow = document.getElementById('cardsRow');
  const $feedList = document.getElementById('feedList');

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderCards(activities) {
    const total = activities.length;
    const pending = activities.filter((a) => a.status === 'pending').length;
    const withIssues = activities.filter((a) => computeIssues(a).length > 0).length;
    const stale = activities.filter((a) => isStale(a)).length;
    const noPhoto = activities.filter((a) => computeIssues(a).some((i) => i.code === 'no_photo')).length;

    const cards = [
      { key: '', tint: 'total', icon: '📋', value: total, label: 'סך כל הפעילויות' },
      { key: 'pending', tint: 'pending', icon: '🟢', value: pending, label: 'ממתינות לאישור' },
      { key: 'issues', tint: 'issues', icon: '🔴', value: withIssues, label: 'עם בעיות' },
      { key: 'stale', tint: 'stale', icon: '🟠', value: stale, label: 'דורשות עדכון' },
      { key: 'no_photo', tint: 'photo', icon: '🖼️', value: noPhoto, label: 'ללא תמונה' },
    ];
    $cardsRow.innerHTML = cards.map((c) => (
      '<a class="stat-card tint-' + c.tint + '" href="/activities' + (c.key ? '?filter=' + c.key : '') + '">' +
        '<div class="stat-card-icon">' + c.icon + '</div>' +
        '<div class="stat-card-value">' + c.value + '</div>' +
        '<div class="stat-card-label">' + c.label + '</div>' +
      '</a>'
    )).join('');
  }

  function renderFeed(activities) {
    const withProblems = activities
      .map((a) => ({ activity: a, issues: computeIssues(a), stale: isStale(a) }))
      .filter((x) => x.issues.length > 0 || x.stale)
      .sort((x, y) => (y.issues.length - x.issues.length))
      .slice(0, 20);

    if (withProblems.length === 0) {
      $feedList.innerHTML = '<div class="empty-note">אין כרגע פעילויות שדורשות טיפול. 🎉</div>';
      return;
    }

    $feedList.innerHTML = withProblems.map(({ activity: a, issues, stale }) => {
      const tags = issues.map((i) => '<span class="feed-tag">' + escapeHtml(i.label) + '</span>').join('')
        + (stale ? '<span class="feed-tag stale-tag">דורשת עדכון</span>' : '');
      return '<div class="feed-card">' +
        '<div>' +
          '<div class="feed-name">' + escapeHtml(a.name) + '</div>' +
          '<div class="feed-tags">' + tags + '</div>' +
        '</div>' +
        '<a class="feed-edit-link" href="/activities?edit=' + a.id + '">ערוך</a>' +
      '</div>';
    }).join('');
  }

  async function load() {
    try {
      const res = await fetch('/api/manage/activities');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      $status.textContent = '';
      renderCards(data.activities);
      renderFeed(data.activities);
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

module.exports = { renderDashboardPage };
