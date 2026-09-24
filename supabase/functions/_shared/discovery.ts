// TuRu - גילוי-קישורים חסום לאותו דומיין בלבד, בשביל שסריקת מקור תמצא גם דפי-רשימה/לוח-שנה
// נוספים מעבר ל-seed URL המדויק (הוחלט מפורשות עם המשתמש). זה *לא* crawler כללי: עומק 1
// בלבד (רק קישורים מהדף שנסרק ישירות, בלי רקורסיה), אותו host בלבד (בלי www./https vs http
// משנה זהות), ותקרת-עמודים קשיחה. בלי שום ניסיון לעקוף CAPTCHA/הגנות - דף חסום פשוט לא יניב
// טקסט שימושי ומדולג בשלב החילוץ.

// A bare 'page' / 'עמוד' is NOT evidence: every SharePoint URL has /Pages/ (115 of 573 links, 29 sources, 2026-09-24).
// Node twin: tools/import-tool/lib/discovery.js - keep behaviourally identical.
export const DISCOVERY_KEYWORDS = [
  'אירוע', 'אירועים', 'לוח אירועים', 'פעילויות', 'פעילות', 'חוגים', 'קייטנה', 'הצגות', 'הופעות',
  'event', 'events', 'calendar', 'activities', 'activity', 'קטגוריה', 'category',
];
// Whole-anchor category labels only: a bare 'ילדים'/'משפחה' substring admits kindergarten registration and welfare pages.
const KIDS_CATEGORY_LABELS = new Set(['ילדים', 'לילדים', 'ילדים ונוער', 'ילדים ומשפחה', 'הורים וילדים']);
const PAGINATION_PATTERNS = [/[?&]page=\d+/i, /\/page\/\d+/i, /[?&]p=\d+/i];
const PAGINATION_TEXT = /(?:^|\s)(?:page|עמוד)\s*\d+(?:\s|$)/i;
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid)$/i;

// Identity of a page for dedupe: host without www, case-folded path, no trailing slash / fragment / tracking params.
// Query values are kept verbatim - they often identify distinct event pages.
export function canonicalPageKey(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return String(url); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  const query = params.length ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  return `${host}${path}${query}`;
}

function sameHost(a: URL, b: URL): boolean {
  const norm = (h: string) => h.replace(/^www\./, '').toLowerCase();
  return norm(a.hostname) === norm(b.hostname);
}

export function looksLikeListingLink(href: string, text: string): boolean {
  const lowerText = (text || '').toLowerCase();
  const lowerHref = (href || '').toLowerCase();
  if (PAGINATION_PATTERNS.some((p) => p.test(lowerHref))) return true;
  if (PAGINATION_TEXT.test(lowerText.trim())) return true;
  if (KIDS_CATEGORY_LABELS.has(lowerText.replace(/\s+/g, ' ').trim())) return true;
  return DISCOVERY_KEYWORDS.some((kw) => lowerText.includes(kw.toLowerCase()) || lowerHref.includes(kw.toLowerCase()));
}

// deno-lint-ignore no-explicit-any
export function discoverListingLinks($: any, baseUrl: string, maxExtraPages: number, maxLinksScanned = 200): string[] {
  const base = new URL(baseUrl);
  const found: string[] = [];
  const seen = new Set<string>([canonicalPageKey(base.toString())]);

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
    const key = canonicalPageKey(absolute.toString());
    if (seen.has(key)) return;
    const text = $el.text() || '';
    if (!looksLikeListingLink(href, text)) return;
    seen.add(key);
    found.push(absolute.toString());
  });

  return found.slice(0, maxExtraPages);
}
