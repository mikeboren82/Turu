// TuRu - Node mirror of supabase/functions/_shared/extraction.ts assessChildRelevance (same
// two-runtime copy pattern as cityNaming/venueNaming). Keep the marker lists identical.
// 2026-09-24: the rules were NOT identical - this copy lacked the explicit-child-age evidence ("לגיל 2-4",
// max_age <= 12) and the min_age >= 18 adult signal, so the Cleaner hand-back held rows as relevance
// 'review' that intake had judged 'ok'. Now line-for-line the Deno rule; tests/publishPolicy.test.js
// asserts the marker lists and the regex against extraction.ts.
// 2026-09-24 (pilot #4, "שלום בית"): EVIDENCE HIERARCHY - item-local publisher context outranks the model's audience;
// "family" alone never publishes automatically; time is never used. See the Deno twin's comment.
const { hasExplicitChildAge } = require('./lib/autoPublishSafety');

const ADULT_MARKERS = [
  'הרצאה', 'הרצאת', 'סטנדאפ', 'סטנד אפ', 'מנוי', 'סדרת', 'גיל הזהב', 'ותיקים', 'ותיקות', 'אזרחים ותיקים', 'גמלאים', 'פנסיונרים',
  'קפה עסקי', 'נטוורקינג', 'צ׳יקונג', "צ'יקונג", 'טאי צ׳י', "טאי צ'י", 'יוגה למבוגרים', 'פילאטיס', 'הכר את הנייד', 'סמארטפון למבוגרים',
  'ערב נשים', 'לנשים בלבד', 'מסיבת רווקים', 'טעימות יין', 'סיור יין', 'יקב', 'אלכוהול', 'בירה', 'מועדון לילה', 'קונצרט ערב', 'ישיבת מועצה',
  'קורס', 'סדנת הורים', 'הורים בלבד', 'ערב הורים', 'קבלת קהל', 'הודעה לתושבים', 'סיור מקצועי', '18+', 'למבוגרים בלבד', 'לגיל השלישי',
];
const CHILD_MARKERS = [
  'ילדים', 'ילדה', 'לילד', 'פעוט', 'תינוק', 'משפחה', 'משפחות', 'הורים וילדים', 'גיל הרך', 'גני ילדים', 'שעת סיפור', 'הצגת ילדים',
  'תיאטרון ילדים', 'סדנת יצירה', 'קטנטנים', 'בייבי', 'לכל הגילאים', 'לכל המשפחה', 'הפעלה', 'מתנפחים', 'קוסם', 'ליצן', 'בובות',
  'כיתות', 'נוער', 'קייטנה', 'חופש הגדול', 'חנוכה לילדים', 'פורים', 'סוכות', 'שעשועים', 'משחקים', 'משחקייה',
  // 2026-09-24 relevance replay: child evidence the model's "family" label was standing in for
  'קידס', 'kids', 'הורה וילד', 'הורה ופעוט', 'הורה ותינוק', 'הצגה משפחתית', 'מופע משפחתי', 'פסטיבל משפחתי', 'הצגת חנוכה', 'קסמים', 'גן החיות', 'פינת ליטוף',
];
const STRONG_CHILD_MARKERS = [
  'ילדים', 'ילדה', 'לילד', 'פעוט', 'תינוק', 'הורים וילדים', 'גיל הרך', 'גני ילדים', 'שעת סיפור', 'הצגת ילדים',
  'תיאטרון ילדים', 'קטנטנים', 'בייבי', 'כיתות', 'נוער', 'קייטנה', 'חנוכה לילדים', 'משחקייה',
  'קידס', 'kids', 'הורה וילד', 'הורה ופעוט', 'הורה ותינוק',
];
const ADULT_CONTEXT_RE = /עונת\s+(?:ה)?תיאטרון|עונת\s+(?:ה)?מנויים|מנויי?\s+(?:ה)?(?:תיאטרון|מבוגרים)|סדרת\s+(?:ה)?מנויים|סדרת\s+מבוגרים|מופעי\s+בחירה|למבוגרים|מבוגרים\s+בלבד|18\+|הרצאות|סטנד\s?אפ|stand.?up|אזרחים\s+ותיקים|גיל\s+הזהב|ותיקים/i;
const CHILD_CONTEXT_RE = /ילדים|לילדים|פעוט|גיל\s+הרך|קטנטנים|משפחות|נוער|גילאי\s*\d|לגיל\s*\d/;
function sourceContextAudience(sc) {
  const labels = sc && sc.labels;
  if (!Array.isArray(labels) || !labels.length) return null;
  const t = labels.filter((l) => typeof l === 'string').join(' | ');
  if (CHILD_CONTEXT_RE.test(t)) return 'child';
  return ADULT_CONTEXT_RE.test(t) ? 'adult' : null;
}
const INHERENTLY_CHILD_CATEGORIES = new Set(['גן שעשועים', 'משחקייה']);
// subscription vocabulary is an adult MARKER only without the item's own child context ("מנויים וסדרות ילדים")
const SUBSCRIPTION_MARKERS = new Set(['מנוי', 'סדרת']);

function childRelevanceEvidence(candidate) {
  const text = `${candidate.name ?? ''} ${candidate.description ?? ''}`.toLowerCase();
  const explicitChildAge = hasExplicitChildAge(text) || (typeof candidate.max_age === 'number' && candidate.max_age <= 12);
  const hasChild = CHILD_MARKERS.some((m) => text.includes(m.toLowerCase())) || (typeof candidate.max_age === 'number' && candidate.max_age <= 18) || (typeof candidate.min_age === 'number' && candidate.min_age <= 12) || explicitChildAge;
  const strongChild = explicitChildAge || STRONG_CHILD_MARKERS.some((m) => text.includes(m.toLowerCase()));
  const hasAdult = ADULT_MARKERS.some((m) => text.includes(m.toLowerCase())) || (typeof candidate.min_age === 'number' && candidate.min_age >= 18);
  const context = sourceContextAudience(candidate.source_context);
  const hardAdult = ADULT_MARKERS.some((m) => !SUBSCRIPTION_MARKERS.has(m) && text.includes(m.toLowerCase())) || (typeof candidate.min_age === 'number' && candidate.min_age >= 18);
  if (candidate.audience === 'adults') return explicitChildAge ? { verdict: 'review', reason: 'adult_label_vs_child_age' } : { verdict: 'reject', reason: 'adult_label' };
  if (hasAdult && !hasChild) return { verdict: 'reject', reason: 'adult_marker' };
  if (context === 'adult' && !strongChild) return { verdict: 'review', reason: 'first_party_adult_context' };
  if (context === 'child' && hasChild && !hardAdult) return { verdict: 'ok', reason: 'child_evidence' };
  if (candidate.audience === 'children' || candidate.audience === 'family') {
    if (hasAdult) return { verdict: 'review', reason: 'adult_marker_with_child_evidence' };
    if (!hasChild && context !== 'child' && !INHERENTLY_CHILD_CATEGORIES.has(String(candidate.category ?? ''))) return { verdict: 'review', reason: 'model_audience_label_only' };
    return { verdict: 'ok', reason: hasChild || context === 'child' ? 'child_evidence' : 'child_category' };
  }
  return hasChild || context === 'child' ? { verdict: 'ok', reason: 'child_evidence' } : { verdict: 'review', reason: 'no_child_evidence' };
}
function assessChildRelevance(candidate) { return childRelevanceEvidence(candidate).verdict; }

module.exports = { assessChildRelevance, childRelevanceEvidence, sourceContextAudience, ADULT_MARKERS, CHILD_MARKERS, STRONG_CHILD_MARKERS, ADULT_CONTEXT_RE, CHILD_CONTEXT_RE, INHERENTLY_CHILD_CATEGORIES, SUBSCRIPTION_MARKERS };
