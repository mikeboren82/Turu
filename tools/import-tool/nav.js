// WABBIT/TuRu - סרגל ניווט משותף לכל עמודי הניהול: 5 קטגוריות (דשבורד/פעילויות/הוספת תוכן/
// איכות נתונים/משתמשים - dropdown ל-4 העמודים הקיימים). קודם לזה כל קובץ שכפל ידנית רשימת
// קישורים משלו (.tools-row/.back-link) - שינוי ניווט עתידי קורה כאן במקום ב-8 קבצים.
// לא כולל את לוגו ה-WABBIT/כותרת העמוד - אלה נשארים בכל קובץ כמו שהיו, כדי שהשינוי בקבצים
// הקיימים יישאר ממוקד רק בהחלפת רשימת הקישורים.

const NAV_STYLES = `
  .main-nav { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; align-items: center; }
  .main-nav-link {
    display: inline-flex; align-items: center; gap: 5px; text-decoration: none;
    border: 1px solid oklch(0.88 0.01 230); background: oklch(1 0 0); color: oklch(0.4 0.02 235);
    font-weight: 700; font-size: 13px; border-radius: 999px; padding: 8px 16px; cursor: pointer;
    font-family: 'Assistant', 'Segoe UI', Arial, sans-serif;
  }
  .main-nav-link.active { background: oklch(0.52 0.11 225); border-color: oklch(0.52 0.11 225); color: white; }
  .nav-dropdown { position: relative; display: inline-block; }
  .nav-dropdown-menu {
    display: none; position: absolute; top: calc(100% + 6px); inset-inline-start: 0; z-index: 20;
    min-width: 190px; background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230);
    border-radius: 14px; padding: 6px; box-shadow: 0 8px 24px oklch(0.3 0.02 230 / 0.14);
  }
  .nav-dropdown-menu.open { display: block; }
  .nav-dropdown-item {
    display: block; padding: 9px 12px; border-radius: 9px; text-decoration: none;
    font-family: 'Assistant', 'Segoe UI', Arial, sans-serif; font-weight: 600; font-size: 13px;
    color: oklch(0.3 0.02 235);
  }
  .nav-dropdown-item:hover { background: oklch(0.96 0.02 225); }
  .nav-dropdown-item.active { color: oklch(0.52 0.11 225); }
`;

const PRIMARY_ITEMS = [
  { key: 'dashboard', href: '/', label: '📊 דשבורד' },
  { key: 'activities', href: '/activities', label: '🎪 פעילויות' },
  { key: 'import', href: '/import', label: '➕ הוספת תוכן' },
];

const USER_ITEMS = [
  { key: 'members', href: '/members', label: 'ניהול חברים' },
  { key: 'contributors', href: '/contributors', label: '⭐ תורמי פעילויות' },
  { key: 'feedback', href: '/feedback', label: '💬 דיווחי משתמשים' },
  { key: 'messages', href: '/messages', label: '📬 הודעות ממשתמשים' },
];

function renderNav(activePage) {
  const primaryHtml = PRIMARY_ITEMS.map((item) => (
    `<a href="${item.href}" class="main-nav-link${item.key === activePage ? ' active' : ''}">${item.label}</a>`
  )).join('');

  const isUsersActive = USER_ITEMS.some((item) => item.key === activePage);
  const usersMenuHtml = USER_ITEMS.map((item) => (
    `<a href="${item.href}" class="nav-dropdown-item${item.key === activePage ? ' active' : ''}">${item.label}</a>`
  )).join('');

  return `<nav class="main-nav">
    ${primaryHtml}
    <div class="nav-dropdown">
      <button type="button" class="main-nav-link${isUsersActive ? ' active' : ''}" data-dropdown-toggle="usersNavMenu">👥 משתמשים ▾</button>
      <div class="nav-dropdown-menu" id="usersNavMenu">${usersMenuHtml}</div>
    </div>
  </nav>`;
}

module.exports = { renderNav, NAV_STYLES };
