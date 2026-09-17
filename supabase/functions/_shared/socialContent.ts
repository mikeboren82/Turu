// TuRu - THE MONSTER, SOCIAL input family: one social CONTENT ITEM -> what the canonical pipeline may do with it.
// Social is a SOURCE FAMILY, not a second ingestion system: an item that survives this module is handed to the
// SAME pipeline as any web page (extraction -> sanitize -> venue -> event identity -> dedup -> provenance ->
// review / create), with the post permalink as its page_url. This module is access-agnostic: the item may come
// from a consented connection, Page Public Content Access or Business Discovery (see THE-MONSTER.md §8) -
// never from scraping. Pure functions; no network, no AI.
//
//   classifySocialItem   ACTIVITY_CANDIDATE | UPDATE | CANCELLATION | EXPIRED | IRRELEVANT | AMBIGUOUS
//   resolveRelativeDates "היום / מחר / ביום שישי / בסופ"ש / בשבוע הבא" -> absolute dates, anchored on the POST's
//                        publication timestamp in Israel time - NEVER on scan time: an old post that says
//                        "מחר" describes a day that has passed, not tomorrow.
//   toPipelinePage       the item as a page for the existing extractor (publication date + verified publisher
//                        context + resolved dates stated explicitly, so the model never guesses them)
export interface SocialItem { platform: 'instagram' | 'facebook'; account: string; permalink: string; caption: string; publishedAt: string; mediaType?: string | null }
export interface PublisherContext { name: string; venueName?: string | null; city?: string | null; verified: boolean }
export type SocialClass = 'ACTIVITY_CANDIDATE' | 'UPDATE' | 'CANCELLATION' | 'EXPIRED' | 'IRRELEVANT' | 'AMBIGUOUS';

const IL_TZ = 'Asia/Jerusalem';
const DAY_MS = 86400000;
// the calendar date in Israel of an instant (a post published 23:30 UTC is already "tomorrow" in Israel)
export function israelDate(iso: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: IL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  return p; // YYYY-MM-DD
}
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const dow = (ymd: string) => new Date(ymd + 'T12:00:00Z').getUTCDay(); // 0 = Sunday

const WEEKDAYS: [RegExp, number][] = [[/ראשון/, 0], [/שני/, 1], [/שלישי/, 2], [/רביעי/, 3], [/חמישי/, 4], [/שישי/, 5], [/שבת/, 6]];
const HE_MONTHS: Record<string, number> = { 'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'מרס': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6, 'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12 };

export interface ResolvedDate { date: string; phrase: string; kind: 'relative' | 'weekday' | 'explicit'; confidence: 'HIGH' | 'MEDIUM' }

// every date the caption names, resolved against the PUBLICATION date (Israel). Explicit dates without a year
// take the first occurrence on/after the publication date (an announcement looks forward, never a year back).
export function resolveRelativeDates(caption: string, publishedAt: string): ResolvedDate[] {
  const base = israelDate(publishedAt); const out: ResolvedDate[] = []; const seen = new Set<string>();
  const push = (date: string, phrase: string, kind: ResolvedDate['kind'], confidence: ResolvedDate['confidence']) => { const k = date + '|' + kind; if (!seen.has(k)) { seen.add(k); out.push({ date, phrase, kind, confidence }); } };
  const text = caption || '';
  if (/(^|[\s,.!:])היום([\s,.!:]|$)/.test(text) || /הערב/.test(text)) push(base, 'היום', 'relative', 'HIGH');
  if (/מחרתיים/.test(text)) push(addDays(base, 2), 'מחרתיים', 'relative', 'HIGH');
  if (/(^|[\s,.!:])מחר([\s,.!:]|$)/.test(text)) push(addDays(base, 1), 'מחר', 'relative', 'HIGH');
  // "ביום שישי" / "יום ו'" -> the NEXT such weekday on/after publication; "הבא" pushes it a week
  const wd = /(?:ב|ה)?יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי)(\s+הבא)?|(?:ב|ה)?(שבת)(\s+הבאה)?/g;
  for (const m of text.matchAll(wd)) {
    const word = m[1] || m[3]; const next = !!(m[2] || m[4]);
    const target = WEEKDAYS.find(([re]) => re.test(word))![1];
    let delta = (target - dow(base) + 7) % 7; if (next && delta < 7) delta += delta === 0 ? 7 : 7;
    push(addDays(base, delta), m[0].trim(), 'weekday', next ? 'MEDIUM' : 'HIGH');
  }
  if (/סופ"?ש|סוף השבוע|סופש/.test(text)) { const toFri = (5 - dow(base) + 7) % 7; push(addDays(base, toFri), 'סופ"ש (שישי)', 'weekday', 'MEDIUM'); push(addDays(base, toFri + 1), 'סופ"ש (שבת)', 'weekday', 'MEDIUM'); }
  if (/בשבוע הבא/.test(text) && !out.some((d) => d.kind === 'weekday')) push(addDays(base, 7 - dow(base)), 'בשבוע הבא (week start - day unknown)', 'relative', 'MEDIUM');
  // explicit: 25.9 / 25/09/2026 / 25 בספטמבר
  for (const m of text.matchAll(/(^|[^\d])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/g)) {
    const d = Number(m[2]), mo = Number(m[3]); if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    push(explicitDate(d, mo, m[4] ? Number(m[4]) : null, base), m[0].trim(), 'explicit', 'HIGH');
  }
  for (const m of text.matchAll(/(\d{1,2})\s+ב?(ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)(?:\s+(\d{4}))?/g)) push(explicitDate(Number(m[1]), HE_MONTHS[m[2]], m[3] ? Number(m[3]) : null, base), m[0], 'explicit', 'HIGH');
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function explicitDate(d: number, mo: number, y: number | null, base: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  if (y != null) return `${y < 100 ? 2000 + y : y}-${pad(mo)}-${pad(d)}`;
  const by = Number(base.slice(0, 4)); const same = `${by}-${pad(mo)}-${pad(d)}`;
  // no year: the first such date not earlier than a week before publication (a recap of yesterday stays this year)
  return same >= addDays(base, -7) ? same : `${by + 1}-${pad(mo)}-${pad(d)}`;
}

const CANCEL = /(בוטל|בוטלה|מבוטל|מבוטלת|ביטול האירוע|נאלצים לבטל|לא (?:י|ת)תקיים|נדחה|נדחתה|נדחית|דחיי?ת האירוע)/;
const UPDATE = /(שימו לב|עדכון|שינוי (?:ב)?(?:שעה|מיקום|מועד)|הועבר(?:ה)? ל|עבר(?:ה)? ל|מועד נוסף|תאריך נוסף|נפתחה? הצגה נוספת|נוסף מועד)/;
const EVENT_SIGNALS = /(הצגה|הצגת|מופע|סדנה|סדנת|שעת סיפור|פסטיבל|הפנינג|פעילות|סיור|חוג|קייטנ|הרשמה|להרשמה|כרטיסים|לרכישת|כניסה חופשית|בהרשמה מראש|לכל המשפחה|לילדים|לגילאי|בואו|מוזמנים|מזמינים)/;
const NOT_ATTENDABLE = /(דרושים|דרוש\/ה|משרה|מחפשים עובד|הגרלה|תחרות נושאת פרסים|תודה לכל|תודה רבה ל|היה מדהים|היה כיף|סיכום האירוע|תמונות מה|מזל טוב ל|ברכות ל|חג שמח|שנה טובה|שבת שלום|מבצע|% הנחה|קולקציה|סייל)/;
const RECAP = /(היה מדהים|היה כיף|היה מרגש|תודה לכל (?:מי|המשתתפ)|סיכום|אתמול|בשבוע שעבר|תמונות מ)/;

export interface SocialVerdict { klass: SocialClass; reason: string; dates: ResolvedDate[]; nextDate: string | null }

// today: the scan's date in Israel (YYYY-MM-DD) - used ONLY to decide whether the resolved dates have passed
export function classifySocialItem(item: SocialItem, today: string): SocialVerdict {
  const text = (item.caption || '').trim();
  const dates = resolveRelativeDates(text, item.publishedAt);
  const upcoming = dates.filter((d) => d.date >= today);
  const nextDate = upcoming[0]?.date ?? null;
  const v = (klass: SocialClass, reason: string): SocialVerdict => ({ klass, reason, dates, nextDate });
  if (text.length < 25) return v('IRRELEVANT', 'no usable caption (an image alone is evidence, never an activity)');
  // a cancellation / change is judged BEFORE relevance: it matters even when the post is short
  if (CANCEL.test(text)) return v('CANCELLATION', 'cancellation / postponement wording - needs a strong association with ONE canonical event before anything is changed');
  if (RECAP.test(text) && !upcoming.length) return v('IRRELEVANT', 'a recap of something that already happened');
  if (NOT_ATTENDABLE.test(text) && !EVENT_SIGNALS.test(text)) return v('IRRELEVANT', 'marketing / staff / greeting / contest - nothing to attend');
  if (dates.length && !upcoming.length) return v('EXPIRED', `every date it names has passed (latest ${dates[dates.length - 1].date}, resolved from the publication date ${israelDate(item.publishedAt)})`);
  if (UPDATE.test(text) && EVENT_SIGNALS.test(text)) return v('UPDATE', 'change / additional-date wording - needs a strong association with ONE canonical event');
  if (!EVENT_SIGNALS.test(text)) return v('IRRELEVANT', 'no attendable activity wording');
  if (!dates.length) {
    // an undated post older than three weeks announcing "an event" is stale, not a standing activity
    const ageDays = (Date.parse(today) - Date.parse(israelDate(item.publishedAt))) / DAY_MS;
    return ageDays > 21 ? v('EXPIRED', `undated post ${Math.round(ageDays)} days old`) : v('AMBIGUOUS', 'attendable wording but no date in the caption (the date may be inside the image) - SOCIAL_AMBIGUOUS_DATE');
  }
  if (upcoming.every((d) => d.confidence === 'MEDIUM')) return v('AMBIGUOUS', 'only a loosely resolvable date (weekend / next week) - SOCIAL_AMBIGUOUS_DATE');
  return v('ACTIVITY_CANDIDATE', 'attendable wording with a resolvable upcoming date');
}

// A later post may change or cancel an event ONLY when it is tied to exactly one canonical event by strong
// evidence: same verified publisher AND (the same resolved date, or a distinctive title word) - never by loose
// title similarity. Anything weaker is review (SOCIAL_UPDATE_ASSOCIATION_UNCERTAIN), never a write.
export function associateWithCanonical(verdict: SocialVerdict, caption: string, candidates: { id: string; name: string; dates: string[]; samePublisher: boolean }[], distinctiveShared: (a: string, b: string) => number): { eventId: string | null; confidence: 'HIGH' | 'NONE'; reason: string } {
  const dateSet = new Set(verdict.dates.map((d) => d.date));
  const strong = candidates.filter((c) => c.samePublisher && distinctiveShared(caption, c.name) >= 1 && (c.dates.some((d) => dateSet.has(d)) || distinctiveShared(caption, c.name) >= 2));
  if (strong.length === 1) return { eventId: strong[0].id, confidence: 'HIGH', reason: 'same verified publisher + distinctive title words' + (strong[0].dates.some((d) => dateSet.has(d)) ? ' + same date' : '') };
  return { eventId: null, confidence: 'NONE', reason: strong.length > 1 ? `${strong.length} canonical events fit - SOCIAL_EVENT_ASSOCIATION_UNCERTAIN` : 'no canonical event is strongly tied to this post - SOCIAL_UPDATE_ASSOCIATION_UNCERTAIN' };
}

// The item as a PAGE for the existing extractor. Everything the model must not guess is stated: when the post
// was published, which dates its relative words mean, and - only for a VERIFIED publisher/venue relation -
// where it takes place (a post rarely repeats its own address). An unverified relation states nothing.
export function toPipelinePage(item: SocialItem, verdict: SocialVerdict, publisher: PublisherContext): { url: string; text: string } {
  const lines = [`פוסט ${item.platform === 'instagram' ? 'אינסטגרם' : 'פייסבוק'} של ${publisher.name}`, `תאריך פרסום הפוסט: ${israelDate(item.publishedAt)} (כל ביטוי יחסי בטקסט - "היום", "מחר", "ביום שישי" - מתייחס לתאריך זה, לא להיום)`];
  if (verdict.dates.length) lines.push('תאריכים שחושבו מהטקסט: ' + verdict.dates.map((d) => `${d.phrase} = ${d.date}`).join('; '));
  if (publisher.verified && publisher.venueName) lines.push(`מקום ברירת-מחדל (חשבון מאומת של המקום): ${publisher.venueName}${publisher.city ? ', ' + publisher.city : ''}. אם הטקסט מציין מקום אחר - המקום שבטקסט קובע.`);
  lines.push('', 'טקסט הפוסט:', item.caption.trim());
  return { url: item.permalink, text: lines.join('\n') };
}
