const { renderNav, NAV_STYLES } = require('./nav');

function renderArchivePage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - ארכיון</title>
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
  .top-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0; }

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

  .archive-list { display: flex; flex-direction: column; gap: 10px; }
  .archive-card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
    display: flex; align-items: center; gap: 14px;
  }
  .archive-thumb { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; border: 1px solid oklch(0.9 0.01 230); flex-shrink: 0; background: oklch(0.95 0.01 230); }
  .archive-body { flex: 1; min-width: 0; }
  .archive-name { font-size: 14.5px; font-weight: 800; }
  .archive-meta { font-size: 12.5px; color: oklch(0.5 0.02 235); margin-top: 2px; }
  .archive-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .archive-btn {
    border: 1px solid oklch(0.88 0.01 230); color: oklch(0.4 0.02 235); background: white;
    font-weight: 700; font-size: 12px; border-radius: 999px; padding: 6px 14px; cursor: pointer; white-space: nowrap;
  }
  .restore-btn { border-color: oklch(0.45 0.12 150); color: oklch(0.45 0.12 150); }
  .delete-btn { border-color: oklch(0.5 0.18 25); color: oklch(0.5 0.18 25); }
  .delete-btn.confirming { background: oklch(0.5 0.18 25); color: white; }
  .archive-btn:disabled { opacity: 0.5; cursor: default; }
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
      <h1>ארכיון - פעילויות שהוסרו</h1>
    </div>
  </div>
  ${renderNav('archive')}

  <div class="toolbar">
    <input id="search" type="text" placeholder="חיפוש לפי שם...">
  </div>
  <div id="status" class="status">טוען...</div>
  <div id="archiveList" class="archive-list"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $search = document.getElementById('search');
  const $status = document.getElementById('status');
  const $archiveList = document.getElementById('archiveList');

  let allActivities = [];

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function activityMatchesFilter(a) {
    const q = $search.value.trim().toLowerCase();
    if (!q) return true;
    return (a.name || '').toLowerCase().includes(q);
  }

  function renderCard(a) {
    const thumbUrl = a.activity_images && a.activity_images[0] ? a.activity_images[0].url : null;
    const thumb = thumbUrl
      ? '<img class="archive-thumb" src="' + escapeHtml(thumbUrl) + '" loading="lazy">'
      : '<div class="archive-thumb"></div>';
    const city = a.location && a.location.city ? a.location.city : '';
    const meta = [city, a.category].filter(Boolean).join(' · ');

    return '<div class="archive-card" data-id="' + a.id + '">' +
      thumb +
      '<div class="archive-body">' +
        '<div class="archive-name">' + escapeHtml(a.name) + '</div>' +
        '<div class="archive-meta">' + escapeHtml(meta) + '</div>' +
      '</div>' +
      '<div class="archive-actions">' +
        '<button class="archive-btn restore-btn" data-action="restore" data-id="' + a.id + '">שחזור</button>' +
        '<button class="archive-btn delete-btn" data-action="delete" data-id="' + a.id + '">מחיקה לצמיתות</button>' +
      '</div>' +
    '</div>';
  }

  function renderAll() {
    const filtered = allActivities.filter(activityMatchesFilter);
    $status.textContent = 'מציג ' + filtered.length + ' מתוך ' + allActivities.length + ' פעילויות בארכיון.';
    $status.className = 'status';
    $archiveList.innerHTML = filtered.map(renderCard).join('') || '<div class="status">אין פעילויות בארכיון.</div>';
  }

  async function load() {
    try {
      const res = await fetch('/api/manage/activities');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      allActivities = data.activities.filter((a) => a.status === 'archived');
      renderAll();
    } catch (err) {
      $status.textContent = 'שגיאה בטעינה: ' + err.message;
      $status.className = 'status error';
    }
  }

  $search.addEventListener('input', renderAll);

  $archiveList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.archive-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'delete' && !btn.classList.contains('confirming')) {
      btn.classList.add('confirming');
      btn.textContent = 'לאשר מחיקה?';
      setTimeout(() => {
        if (btn.isConnected && btn.classList.contains('confirming')) {
          btn.classList.remove('confirming');
          btn.textContent = 'מחיקה לצמיתות';
        }
      }, 4000);
      return;
    }

    const card = btn.closest('.archive-card');
    const buttons = card.querySelectorAll('.archive-btn');
    buttons.forEach((b) => { b.disabled = true; });

    try {
      if (action === 'restore') {
        const res = await fetch('/api/manage/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, fields: { status: 'approved' } }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      } else {
        const res = await fetch('/api/manage/delete-activity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      }
      allActivities = allActivities.filter((a) => a.id !== id);
      renderAll();
    } catch (err) {
      buttons.forEach((b) => { b.disabled = false; });
      const delBtn = card.querySelector('.delete-btn');
      if (delBtn) { delBtn.classList.remove('confirming'); delBtn.textContent = 'מחיקה לצמיתות'; }
      alert('שגיאה: ' + err.message);
    }
  });

  load();
</script>
</body>
</html>`;
}

module.exports = { renderArchivePage };
