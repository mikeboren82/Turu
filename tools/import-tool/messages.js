const { renderNav, NAV_STYLES } = require('./nav');

function renderMessagesPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WABBIT - הודעות ממשתמשים</title>
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

  .msg-list { display: flex; flex-direction: column; gap: 10px; }
  .msg-card {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
  }
  .msg-card.replied { border-color: oklch(0.85 0.05 150); background: oklch(0.99 0.02 150); }
  .msg-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .msg-email { font-size: 13.5px; font-weight: 800; direction: ltr; text-align: right; }
  .msg-date { font-size: 12px; color: oklch(0.5 0.02 235); direction: ltr; }
  .badge {
    font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 3px 10px; white-space: nowrap;
  }
  .badge.new { background: oklch(0.95 0.07 80); color: oklch(0.5 0.13 80); }
  .badge.replied { background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); }
  .msg-message { font-size: 14px; color: oklch(0.25 0.02 240); line-height: 1.5; white-space: pre-wrap; margin-bottom: 10px; }

  .reply-box { border-top: 1px solid oklch(0.95 0.01 230); padding-top: 10px; margin-top: 10px; }
  .reply-existing { background: oklch(0.97 0.01 150); border-radius: 10px; padding: 10px 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
  .reply-existing b { display: block; font-size: 11.5px; color: oklch(0.5 0.02 235); margin-bottom: 4px; }
  .reply-input {
    width: 100%; border: 1px solid oklch(0.88 0.01 230); border-radius: 10px; padding: 10px 12px;
    font-family: inherit; font-size: 13.5px; min-height: 70px; resize: vertical;
  }
  .reply-actions { display: flex; justify-content: flex-start; margin-top: 8px; }
  .reply-btn {
    background: oklch(0.52 0.11 225); color: white; border: none; border-radius: 999px;
    font-weight: 700; font-size: 13px; padding: 9px 18px; cursor: pointer;
  }
  .reply-btn:disabled { opacity: 0.5; cursor: default; }
  .reply-error { color: oklch(0.5 0.18 25); font-size: 12.5px; margin-top: 6px; }
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
      <h1>הודעות ממשתמשים - פניות מ"צרו קשר"</h1>
    </div>
  </div>
  ${renderNav('messages')}

  <div class="toolbar">
    <input id="search" type="text" placeholder="חיפוש באימייל או בתוכן ההודעה...">
    <select id="filterStatus">
      <option value="all">הכל</option>
      <option value="new">ממתינות לתשובה</option>
      <option value="replied">נענו</option>
    </select>
  </div>
  <div id="status" class="status">טוען...</div>
  <div id="msgList" class="msg-list"></div>
</div>

<script src="/admin-shared.js"></script>
<script>
  const $search = document.getElementById('search');
  const $filterStatus = document.getElementById('filterStatus');
  const $status = document.getElementById('status');
  const $list = document.getElementById('msgList');

  let allMessages = [];
  const replyDrafts = {};

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatDateTime(iso) {
    try { return new Date(iso).toLocaleString('he-IL'); } catch { return iso; }
  }

  function matchesFilter(m) {
    if ($filterStatus.value !== 'all' && m.status !== $filterStatus.value) return false;
    const q = $search.value.trim().toLowerCase();
    if (!q) return true;
    return (m.email || '').toLowerCase().includes(q) || (m.message || '').toLowerCase().includes(q);
  }

  function renderCard(m) {
    const replied = m.status === 'replied';
    const draft = replyDrafts[m.id] ?? '';
    return '<div class="msg-card' + (replied ? ' replied' : '') + '" data-id="' + m.id + '">' +
      '<div class="msg-head">' +
        '<span class="msg-email">' + escapeHtml(m.email) + '</span>' +
        '<span class="badge ' + (replied ? 'replied' : 'new') + '">' + (replied ? 'נענתה' : 'ממתינה לתשובה') + '</span>' +
        '<span class="msg-date">' + formatDateTime(m.created_at) + '</span>' +
      '</div>' +
      '<div class="msg-message">' + escapeHtml(m.message) + '</div>' +
      (replied
        ? '<div class="reply-box"><div class="reply-existing"><b>התשובה שנשלחה (' + formatDateTime(m.replied_at) + '):</b>' + escapeHtml(m.admin_reply) + '</div></div>'
        : '<div class="reply-box">' +
            '<textarea class="reply-input" placeholder="כתבו תשובה שתישלח למייל של הפונה...">' + escapeHtml(draft) + '</textarea>' +
            '<div class="reply-actions"><button class="reply-btn">שליחת תשובה</button></div>' +
            '<div class="reply-error" hidden></div>' +
          '</div>') +
    '</div>';
  }

  function renderAll() {
    const filtered = allMessages.filter(matchesFilter);
    $status.textContent = 'מציג ' + filtered.length + ' מתוך ' + allMessages.length + ' הודעות.';
    $status.className = 'status';
    $list.innerHTML = filtered.map(renderCard).join('') || '<div class="status">אין הודעות תואמות.</div>';
  }

  async function load() {
    try {
      const res = await fetch('/api/manage/contact-messages');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      allMessages = data.messages;
      renderAll();
    } catch (err) {
      $status.textContent = 'שגיאה בטעינה: ' + err.message;
      $status.className = 'status error';
    }
  }

  $search.addEventListener('input', renderAll);
  $filterStatus.addEventListener('change', renderAll);

  $list.addEventListener('input', (e) => {
    if (!e.target.classList.contains('reply-input')) return;
    const id = e.target.closest('.msg-card').dataset.id;
    replyDrafts[id] = e.target.value;
  });

  $list.addEventListener('click', async (e) => {
    const btn = e.target.closest('.reply-btn');
    if (!btn) return;
    const card = btn.closest('.msg-card');
    const id = card.dataset.id;
    const textarea = card.querySelector('.reply-input');
    const errorBox = card.querySelector('.reply-error');
    const replyText = textarea.value.trim();
    if (!replyText) { errorBox.hidden = false; errorBox.textContent = 'כתבו תשובה לפני השליחה'; return; }

    btn.disabled = true;
    btn.textContent = 'שולח...';
    errorBox.hidden = true;
    try {
      const res = await fetch('/api/manage/contact-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, replyText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      const msg = allMessages.find((m) => m.id === id);
      if (msg) { msg.status = 'replied'; msg.admin_reply = replyText; msg.replied_at = new Date().toISOString(); }
      delete replyDrafts[id];
      renderAll();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'שליחת תשובה';
      errorBox.hidden = false;
      errorBox.textContent = 'שגיאה: ' + err.message;
    }
  });

  load();
</script>
</body>
</html>`;
}

module.exports = { renderMessagesPage };
