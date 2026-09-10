// TuRu - לוגיקה משותפת שחייבת להתנהג זהה בכל עמודי הניהול (דשבורד, פעילויות, איכות
// נתונים) - בניגוד ל-escapeHtml/date-format הקטנים שכל קובץ משכפל בלי בעיה, כאן דריפט בין
// עמודים יפגע ישירות באמינות "כמה פעילויות דורשות טיפול" שהדשבורד מציג. נטען כ-<script src=
// "/admin-shared.js"> (ראו express.static ב-server.js), לא module - הכל על window.

// חלון "דורש עדכון" גלובלי כשאין next_review_at מפורש (ראו 0031_activities_verification_quality.sql).
const STALE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function activityHasApprovedPhoto(a) {
  return (a.activity_images || []).some((img) => img.status === 'approved');
}

// "ללא תמונה" - נמדד ומטופל בנפרד לגמרי מ"בעיה" (ראו computeIssues למטה): יש לו תיוג/תור
// משלו ("פעילויות ללא תמונה", manage.js) שבו מנהל מאשר/דוחה, ולא אמור לנפח את מונה-הבעיות
// הכללי. photo_skipped = מנהל כבר אישר במפורש "בלי תמונה זה בסדר" לפעילות הזו - לא חסר בפועל.
// פעילות בארכיון כבר לא חיה באפליקציה - היא לא יכולה להיות "בעיה" שדורשת טיפול-דחוף, גם אם
// חסרה לה תמונה. בלי הבדיקה הזו, פעילויות שאורכבו (למשל כי לא נמצאה כתובת) עדיין מנפחות את
// המונים האלה לנצח - זה בדיוק מה שקרה בפועל עם "עם בעיות"/"ללא תמונה" לפני התיקון.
function isMissingPhoto(a) {
  return a.status !== 'archived' && !a.photo_skipped && !activityHasApprovedPhoto(a);
}

// מזהה ומחזירה את כל ה"בעיות" בפעילות בודדת - {code, label}[]. בקשת המשתמש: "פעילות בעייתית"
// נספרת אך ורק לפי כתובת חסרה - כל שאר החוסרים (גיל/מחיר/קואורדינטות/שעות/קישור שבור) לא
// חשובים מספיק כדי לסמן פעילות כ"בעיה", ו"ללא תמונה" יש לו תור נפרד משלו (isMissingPhoto למעלה),
// לא חלק מ"בעיות". בעיות ש"התעלמו" מהן (dismissed_issues, ראו 0035) עדיין מסוננות כאן.
function computeIssues(a) {
  if (a.status === 'archived') return []; // ראו הערה ב-isMissingPhoto - אותו עיקרון בדיוק.
  const dismissed = new Set((a.dismissed_issues || []).map((d) => d.issue_code));
  const issues = [];
  if (!a.location || !a.location.address || a.location.address.trim().length < 3) {
    issues.push({ code: 'missing_address', label: 'כתובת חסרה' });
  }
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

// אישור-פעולה עדין (Promise<boolean>) - לא window.confirm() המובנה. נמצא בפועל: confirm() מוחזר
// false בשקט (בלי להציג דיאלוג בכלל) בכמה הקשרי-דפדפן (webview מוטמע, כלי אוטומציה/בדיקה,
// חלק מהגדרות popup-blocker) - "לחיצה על מחק לא עושה כלום" בדיוק ככה זה מרגיש למשתמש, כי
// ה-early-return אחרי `if (!confirm(...)) return;` קורה בלי שום משוב חזותי. מודל in-page
// עצמאי (לא תלוי ב-API סינכרוני של הדפדפן) עובד תמיד, בכל הקשר.
function confirmModal(message, { danger = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:14px;padding:22px;max-width:380px;width:100%;box-shadow:0 12px 32px rgba(0,0,0,0.2);direction:rtl;text-align:right;font-family:inherit;';
    const text = document.createElement('div');
    text.style.cssText = 'font-size:15px;color:#1f2937;margin-bottom:18px;line-height:1.5;';
    text.textContent = message;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-start;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'ביטול';
    cancelBtn.style.cssText = 'padding:9px 18px;border-radius:8px;border:1px solid #d1d5db;background:#fff;color:#374151;cursor:pointer;font-size:14px;';
    const okBtn = document.createElement('button');
    okBtn.textContent = danger ? 'מחיקה' : 'אישור';
    okBtn.style.cssText = danger
      ? 'padding:9px 18px;border-radius:8px;border:none;background:oklch(0.55 0.18 25);color:#fff;cursor:pointer;font-size:14px;'
      : 'padding:9px 18px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:14px;';
    const cleanup = (result) => { document.body.removeChild(backdrop); resolve(result); };
    cancelBtn.addEventListener('click', () => cleanup(false));
    okBtn.addEventListener('click', () => cleanup(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
    row.appendChild(okBtn);
    row.appendChild(cancelBtn);
    card.appendChild(text);
    card.appendChild(row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    okBtn.focus();
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initNavDropdowns);
}
