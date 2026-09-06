// WABBIT/TuRu - לוגיקה משותפת שחייבת להתנהג זהה בכל עמודי הניהול (דשבורד, פעילויות, איכות
// נתונים) - בניגוד ל-escapeHtml/date-format הקטנים שכל קובץ משכפל בלי בעיה, כאן דריפט בין
// עמודים יפגע ישירות באמינות "כמה פעילויות דורשות טיפול" שהדשבורד מציג. נטען כ-<script src=
// "/admin-shared.js"> (ראו express.static ב-server.js), לא module - הכל על window.

// חלון "דורש עדכון" גלובלי כשאין next_review_at מפורש (ראו 0031_activities_verification_quality.sql).
const STALE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function activityHasApprovedPhoto(a) {
  return (a.activity_images || []).some((img) => img.status === 'approved');
}

// מזהה ומחזירה את כל ה"בעיות" בפעילות בודדת - {code, label}[]. no_photo מוגדר בדיוק כמו
// activityHasApprovedPhoto/photo_skipped ב-manage.js, לא הגדרה חדשה ונפרדת.
// בעיות ש"התעלמו" מהן (dismissed_issues, ראו 0035) מסוננות כאן - במקום אחד, אז דשבורד/פעילויות/
// איכות-נתונים כולם מפסיקים לספור אותן אוטומטית, בלי שהבעיה בפועל "נפתרה" בנתון עצמו.
function computeIssues(a) {
  const dismissed = new Set((a.dismissed_issues || []).map((d) => d.issue_code));
  const issues = [];
  if (a.min_age == null && a.max_age == null) issues.push({ code: 'missing_age', label: 'חסרים גילאים' });
  if (!a.price_type) issues.push({ code: 'missing_price', label: 'חסר מחיר' });
  if (!a.location || !a.location.address || a.location.address.trim().length < 3) {
    issues.push({ code: 'missing_address', label: 'כתובת חסרה' });
  }
  if (!a.location || a.location.lat == null || a.location.lng == null) {
    issues.push({ code: 'missing_coords', label: 'קואורדינטות חסרות' });
  }
  const schedules = a.activity_schedules || [];
  if (schedules.length === 0 || schedules.every((s) => !s.start_time)) {
    issues.push({ code: 'missing_hours', label: 'שעות פעילות חסרות' });
  }
  if (a.link_broken === true) issues.push({ code: 'broken_link', label: 'קישור שבור' });
  if (!a.photo_skipped && !activityHasApprovedPhoto(a)) issues.push({ code: 'no_photo', label: 'ללא תמונה' });
  return issues.filter((i) => !dismissed.has(i.code));
}

// "דורשת עדכון" - יש תזכורת מפורשת שעברה, או (בהעדר תזכורת) לא נבדקה 90 יום.
function isStale(a) {
  if (a.next_review_at) return new Date(a.next_review_at).getTime() <= Date.now();
  if (!a.last_verified_at) return true;
  return Date.now() - new Date(a.last_verified_at).getTime() > STALE_WINDOW_MS;
}

// טוגל גנרי לתפריטים נפתחים בסרגל הניווט (למשל "👥 משתמשים") - קליק על הכפתור פותח/סוגר,
// קליק בחוץ סוגר. פועל על כל אלמנט עם [data-dropdown-toggle] בעמוד.
function initNavDropdowns() {
  document.querySelectorAll('[data-dropdown-toggle]').forEach((btn) => {
    const menu = document.getElementById(btn.dataset.dropdownToggle);
    if (!menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains('open');
      document.querySelectorAll('.nav-dropdown-menu.open').forEach((m) => m.classList.remove('open'));
      if (willOpen) menu.classList.add('open');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-dropdown-menu.open').forEach((m) => m.classList.remove('open'));
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initNavDropdowns);
}
