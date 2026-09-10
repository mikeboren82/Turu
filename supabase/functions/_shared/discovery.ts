// TuRu - גילוי-קישורים חסום לאותו דומיין בלבד, בשביל שסריקת מקור תמצא גם דפי-רשימה/לוח-שנה
// נוספים מעבר ל-seed URL המדויק (הוחלט מפורשות עם המשתמש). זה *לא* crawler כללי: עומק 1
// בלבד (רק קישורים מהדף שנסרק ישירות, בלי רקורסיה), אותו host בלבד (בלי www./https vs http
// משנה זהות), ותקרת-עמודים קשיחה. בלי שום ניסיון לעקוף CAPTCHA/הגנות - דף חסום פשוט לא יניב
// טקסט שימושי ומדולג בשלב החילוץ.

const DISCOVERY_KEYWORDS = [
  'אירוע', 'אירועים', 'לוח אירועים', 'פעילויות', 'פעילות', 'חוגים', 'קייטנה',
  'event', 'events', 'calendar', 'activities', 'activity', 'קטגוריה', 'category', 'עמוד', 'page',
];
const PAGINATION_PATTERNS = [/[?&]page=\d+/i, /\/page\/\d+/i, /[?&]p=\d+/i];

function sameHost(a: URL, b: URL): boolean {
  const norm = (h: string) => h.replace(/^www\./, '');
  return norm(a.hostname) === norm(b.hostname);
}

function looksLikeListingLink(href: string, text: string, base: URL): boolean {
  const lowerText = (text || '').toLowerCase();
  const lowerHref = href.toLowerCase();
  if (PAGINATION_PATTERNS.some((p) => p.test(lowerHref))) return true;
  return DISCOVERY_KEYWORDS.some((kw) => lowerText.includes(kw.toLowerCase()) || lowerHref.includes(kw.toLowerCase()));
}

// deno-lint-ignore no-explicit-any
export function discoverListingLinks($: any, baseUrl: string, maxExtraPages: number, maxLinksScanned = 200): string[] {
  const base = new URL(baseUrl);
  const found: string[] = [];
  const seen = new Set<string>([base.toString()]);

  // אתרים רבים מגדירים <base href> שונה מכתובת-העמוד עצמה - קישורים יחסיים (./xxx) חייבים
  // להיפתר מולו, לא מול כתובת ה-seed הגולמית, אחרת מתקבלות כתובות שגויות (נצפה בפועל: קישור
  // "./events/" באתר עם <base href="https://example.com/"> הפך שגויות ל-.../category/70/events/
  // במקום https://example.com/events/ - כל 7 הדפים המדולגים של אותה סריקה קיבלו 404 בגלל זה).
  // בדיקת "אותו דומיין" נשארת בכל זאת מול ה-seed המקורי, לא מול ה-base - זו עדיין ההגנה
  // "אותו דומיין בלבד" שהמשתמש דרש, לא קשורה לבסיס-הרזולוציה של קישורים יחסיים.
  let resolveBase = base;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    try { resolveBase = new URL(baseHref, base); } catch { /* base לא תקין - נשארים עם ה-seed */ }
  }

  let scanned = 0;
  $('a[href]').each((_: number, el: unknown) => {
    if (scanned >= maxLinksScanned || found.length >= maxExtraPages) return false;
    scanned++;
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;
    let absolute: URL;
    try {
      absolute = new URL(href, resolveBase);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(absolute.protocol)) return;
    if (!sameHost(absolute, base)) return;
    absolute.hash = '';
    const key = absolute.toString();
    if (seen.has(key)) return;
    const text = $el.text() || '';
    if (!looksLikeListingLink(href, text, base)) return;
    seen.add(key);
    found.push(key);
  });

  return found.slice(0, maxExtraPages);
}
