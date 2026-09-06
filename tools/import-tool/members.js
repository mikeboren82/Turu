const { renderNav, NAV_STYLES } = require('./nav');

function renderMembersPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WABBIT - ניהול חברים</title>
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

  .member-list { display: flex; flex-direction: column; gap: 10px; }
  .member-card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
  }
  .member-card.is-banned { border-color: oklch(0.5 0.18 25 / 0.4); background: oklch(0.99 0.01 25); }
  .member-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .member-nickname { font-size: 14.5px; font-weight: 800; flex: 1; min-width: 140px; }
  .member-meta { font-size: 12.5px; color: oklch(0.5 0.02 235); direction: ltr; }
  .banned-badge {
    display: inline-block; font-size: 11px; font-weight: 700; border-radius: 999px; padding: 3px 10px;
    background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25);
  }
  .member-details { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; font-size: 12.5px; color: oklch(0.4 0.02 235); }
  .member-details span b { color: oklch(0.25 0.02 240); font-weight: 700; }
  .ban-btn {
    border: 1px solid oklch(0.5 0.18 25); color: oklch(0.5 0.18 25); background: white;
    font-weight: 700; font-size: 12px; border-radius: 999px; padding: 6px 14px; cursor: pointer; white-space: nowrap;
  }
  .ban-btn.is-banned { background: oklch(0.45 0.12 150); border-color: oklch(0.45 0.12 150); color: white; }
  .ban-btn.confirming { background: oklch(0.5 0.18 25); color: white; }
  .ban-btn:disabled { opacity: 0.5; cursor: default; }

  .photos-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid oklch(0.95 0.01 230); }
  .member-photo { position: relative; width: 56px; height: 56px; }
  .member-photo img { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; border: 1px solid oklch(0.9 0.01 230); display: block; }
  .member-photo .photo-status-dot {
    position: absolute; bottom: -3px; left: -3px; width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid white;
  }
  .photo-status-dot.pending { background: oklch(0.7 0.15 80); }
  .photo-status-dot.approved { background: oklch(0.55 0.14 150); }
  .photo-status-dot.rejected { background: oklch(0.55 0.18 25); }
  .no-photos-note { font-size: 12px; color: oklch(0.55 0.02 235); margin-top: 12px; padding-top: 12px; border-top: 1px solid oklch(0.95 0.01 230); }
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
      <h1>ניהול חברים - כל המשתמשים הרשומים</h1>
    </div>
  </div>
  ${renderNav('members')}

  <div class="toolbar">
    <input id="search" type="text" placeholder="חיפוש לפי כינוי, טלפון או אימייל...">
  </div>
  <div id="status" class="status">טוען...</div>
  <div id="memberList" class="member-list"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $search = document.getElementById('search');
  const $status = document.getElementById('status');
  const $memberList = document.getElementById('memberList');

  let allMembers = [];

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatDate(iso) {
    try { return new Date(iso).toLocaleDateString('he-IL'); } catch { return iso; }
  }

  function memberMatchesFilter(m) {
    const q = $search.value.trim().toLowerCase();
    if (!q) return true;
    return [m.nickname, m.phone, m.email].some((v) => (v || '').toLowerCase().includes(q));
  }

  function renderPhotos(m) {
    if (!m.images || m.images.length === 0) {
      return '<div class="no-photos-note">לא העלה/תה תמונות</div>';
    }
    return '<div class="photos-row">' +
      m.images.map((img) => (
        '<a class="member-photo" href="' + escapeHtml(img.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(img.activity ? img.activity.name : '') + '">' +
          '<img src="' + escapeHtml(img.url) + '" loading="lazy">' +
          '<span class="photo-status-dot ' + img.status + '"></span>' +
        '</a>'
      )).join('') +
    '</div>';
  }

  function renderCard(m) {
    const details = [];
    if (m.phone) details.push('<span><b>טלפון:</b> ' + escapeHtml(m.phone) + '</span>');
    if (m.email) details.push('<span><b>אימייל:</b> ' + escapeHtml(m.email) + '</span>');
    details.push('<span><b>נרשם/ה:</b> ' + formatDate(m.created_at) + '</span>');
    details.push('<span><b>תמונות שהועלו:</b> ' + (m.images ? m.images.length : 0) + '</span>');

    return '<div class="member-card' + (m.banned ? ' is-banned' : '') + '" data-member-id="' + m.id + '">' +
      '<div class="member-head">' +
        '<span class="member-nickname">' + escapeHtml(m.nickname) + '</span>' +
        (m.banned ? '<span class="banned-badge">חסום/ה</span>' : '') +
        '<button class="ban-btn' + (m.banned ? ' is-banned' : '') + '" data-id="' + m.id + '" data-banned="' + m.banned + '">' +
          (m.banned ? 'בטל חסימה' : 'חסום / הסר') +
        '</button>' +
      '</div>' +
      '<div class="member-details">' + details.join('') + '</div>' +
      renderPhotos(m) +
    '</div>';
  }

  function renderAll() {
    const filtered = allMembers.filter(memberMatchesFilter);
    $status.textContent = 'מציג ' + filtered.length + ' מתוך ' + allMembers.length + ' חברים.';
    $status.className = 'status';
    $memberList.innerHTML = filtered.map(renderCard).join('') || '<div class="status">אין חברים תואמים.</div>';
  }

  async function load() {
    try {
      const res = await fetch('/api/manage/members');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      allMembers = data.members;
      renderAll();
    } catch (err) {
      $status.textContent = 'שגיאה בטעינה: ' + err.message;
      $status.className = 'status error';
    }
  }

  $search.addEventListener('input', renderAll);

  $memberList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.ban-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const currentlyBanned = btn.dataset.banned === 'true';

    if (!currentlyBanned && !btn.classList.contains('confirming')) {
      btn.classList.add('confirming');
      btn.textContent = 'לאשר חסימה?';
      setTimeout(() => {
        if (btn.isConnected && btn.classList.contains('confirming')) {
          btn.classList.remove('confirming');
          btn.textContent = 'חסום / הסר';
        }
      }, 4000);
      return;
    }

    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await fetch('/api/manage/member-ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, banned: !currentlyBanned }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      const member = allMembers.find((m) => m.id === id);
      if (member) member.banned = data.banned;
      renderAll();
    } catch (err) {
      btn.disabled = false;
      btn.classList.remove('confirming');
      btn.textContent = currentlyBanned ? 'בטל חסימה' : 'חסום / הסר';
      alert('שגיאה: ' + err.message);
    }
  });

  load();
</script>
</body>
</html>`;
}

module.exports = { renderMembersPage };
