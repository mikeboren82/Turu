// TuRu - Node mirror of supabase/functions/_shared/extraction.ts assessChildRelevance (same
// two-runtime copy pattern as cityNaming/venueNaming). Keep the marker lists identical.
// 2026-09-24: the rules were NOT identical - this copy lacked the explicit-child-age evidence ("לגיל 2-4",
// max_age <= 12) and the min_age >= 18 adult signal, so the Cleaner hand-back held rows as relevance
// 'review' that intake had judged 'ok'. Now line-for-line the Deno rule; tests/publishPolicy.test.js
// asserts the marker lists and the regex against extraction.ts.
// 2026-09-24 (pilot #4, "שלום בית"): EVIDENCE HIERARCHY - item-local publisher context outranks the model's audience;
// "family" alone never publishes automatically; time is never used. See the Deno twin's comment.
const { hasExplicitChildAge } = require('./lib/autoPublishSafety');
const { trustedAges } = require('./lib/ageEvidence');
const { markersIn, hasMarker } = require('./lib/markerMatch');

const ADULT_MARKERS = [
  'הרצאה', 'הרצאת', 'סטנדאפ', 'סטנד אפ', 'מנוי', 'מנויים', 'מנויי', 'סדרת', 'גיל הזהב', 'ותיקים', 'ותיקות', 'אזרחים ותיקים', 'גמלאים', 'פנסיונרים',
  'קפה עסקי', 'נטוורקינג', 'צ׳יקונג', "צ'יקונג", 'טאי צ׳י', "טאי צ'י", 'יוגה למבוגרים', 'פילאטיס', 'הכר את הנייד', 'סמארטפון למבוגרים',
  'ערב נשים', 'לנשים בלבד', 'מסיבת רווקים', 'טעימות יין', 'סיור יין', 'יקב', 'יקבים', 'אלכוהול', 'בירה', 'מועדון לילה', 'קונצרט ערב', 'ישיבת מועצה',
  'קורס', 'קורסים', 'קורסי', 'סדנת הורים', 'הורים בלבד', 'ערב הורים', 'קבלת קהל', 'הודעה לתושבים', 'סיור מקצועי', '18+', 'למבוגרים בלבד', 'לגיל השלישי',
];
const CHILD_MARKERS = [
  'ילדים', 'ילד', 'ילדה', 'ילדי', 'לילדות', 'פעוט', 'פעוטות', 'פעוטים', 'תינוק', 'תינוקות', 'תינוקת', 'הורים וילדים', 'גיל הרך', 'גני ילדים', 'גן ילדים',
  'שעת סיפור', 'הצגת ילדים', 'הצגות ילדים', 'תיאטרון ילדים', 'קטנטנים', 'קטנטנות', 'בייבי', 'לכל המשפחה', 'למשפחות', 'מתנפחים', 'קוסם', 'קוסמת', 'ליצן', 'ליצנים', 'בובות',
  'גן שעשועים', 'גני שעשועים', 'כיתות', 'נוער', 'קייטנה', 'קייטנות', 'חנוכה לילדים', 'משחקייה', 'משחקיה',
  // 2026-09-24 relevance replay: child evidence the model's "family" label was standing in for
  'קידס', 'kids', 'הורה וילד', 'הורה ופעוט', 'הורה ותינוק', 'הצגה משפחתית', 'מופע משפחתי', 'פסטיבל משפחתי', 'הצגת חנוכה', 'פינת ליטוף',
];
// CONTEXT words (holidays, family as a topic, generic activity words): never child evidence on their own - a Purim
// lecture, a Sukkot concert, "משפחות שכולות" at a memorial. An item with them publishes only on independent child
// evidence; they only name the reason (weak_child_context_only).
const WEAK_CHILD_CONTEXT = [
  'משפחה', 'משפחות', 'משפחתי', 'משפחתית', 'לכל הגילאים', 'פורים', 'סוכות', 'חנוכה', 'חופש הגדול', 'שעשועים', 'משחקים', 'סדנת יצירה', 'הפעלה', 'הפעלות', 'קסמים', 'גן החיות',
];
const STRONG_CHILD_MARKERS = [
  'ילדים', 'ילד', 'ילדה', 'ילדי', 'לילדות', 'פעוט', 'פעוטות', 'פעוטים', 'תינוק', 'תינוקות', 'תינוקת', 'הורים וילדים', 'גיל הרך', 'גני ילדים', 'גן ילדים', 'שעת סיפור',
  'הצגת ילדים', 'הצגות ילדים', 'תיאטרון ילדים', 'קטנטנים', 'קטנטנות', 'בייבי', 'כיתות', 'נוער', 'קייטנה', 'קייטנות', 'חנוכה לילדים', 'משחקייה', 'משחקיה',
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
const SUBSCRIPTION_MARKERS = new Set(['מנוי', 'מנויים', 'מנויי', 'סדרת']);

function childRelevanceEvidence(candidate) {
  const text = `${candidate.name ?? ''} ${candidate.description ?? ''}`.toLowerCase();
  // AGES (2026-09-24, trusted age evidence - ageEvidence twin): an age PROVES child relevance only when event-local
  // source text states it (the item's title, its bound card, its detail-page content, an event-local Cleaner record).
  // The model's own min/max and an age phrase in the model-written description are metadata, not proof. A raw
  // min_age >= 18 stays adult evidence below - an adult age is never hidden because its provenance is weak.
  const ages = trustedAges(candidate);
  const explicitChildAge = hasExplicitChildAge(`${candidate.name ?? ''}`.toLowerCase()) || (ages != null && typeof ages.max_age === 'number' && ages.max_age <= 12);
  // MARKERS (2026-09-24, markerMatch twin): whole words only - never a substring of another word ("פורים" is not in
  // "סיפורים"); holiday / family-topic / activity CONTEXT words are weak and never make hasChild on their own
  const weakContext = markersIn(text, WEAK_CHILD_CONTEXT);
  const hasChild = hasMarker(text, CHILD_MARKERS) || (ages != null && ((typeof ages.max_age === 'number' && ages.max_age <= 18) || (typeof ages.min_age === 'number' && ages.min_age <= 12))) || explicitChildAge;
  // an UNVERIFIED child age (the model's numbers, an age phrase in the model-written description) proves nothing, but
  // it keeps an adult-looking row reviewable - at intake a reject is a silent drop ("קורס שחייה" + model 5-10)
  const unverifiedChildAge = (typeof candidate.max_age === 'number' && candidate.max_age <= 18) || (typeof candidate.min_age === 'number' && candidate.min_age <= 12) || hasExplicitChildAge(text);
  const strongChild = explicitChildAge || hasMarker(text, STRONG_CHILD_MARKERS);
  const hasAdult = hasMarker(text, ADULT_MARKERS) || (typeof candidate.min_age === 'number' && candidate.min_age >= 18);
  const context = sourceContextAudience(candidate.source_context);
  const hardAdult = hasMarker(text, ADULT_MARKERS.filter((m) => !SUBSCRIPTION_MARKERS.has(m))) || (typeof candidate.min_age === 'number' && candidate.min_age >= 18);
  if (candidate.audience === 'adults') return explicitChildAge || unverifiedChildAge ? { verdict: 'review', reason: 'adult_label_vs_child_age' } : { verdict: 'reject', reason: 'adult_label' };
  // an unverified age or weak child CONTEXT (a holiday, family as a topic) proves nothing, but keeps an adult-looking row
  // reviewable instead of silently rejected ("קורס משפחה בטוחה")
  if (hasAdult && !hasChild) return unverifiedChildAge ? { verdict: 'review', reason: 'adult_marker_with_unverified_age' } : weakContext.length ? { verdict: 'review', reason: 'adult_marker_with_weak_child_context' } : { verdict: 'reject', reason: 'adult_marker' };
  if (context === 'adult' && !strongChild) return { verdict: 'review', reason: 'first_party_adult_context' };
  if (context === 'child' && hasChild && !hardAdult) return { verdict: 'ok', reason: 'child_evidence' };
  if (candidate.audience === 'children' || candidate.audience === 'family') {
    if (hasAdult) return { verdict: 'review', reason: 'adult_marker_with_child_evidence' };
    if (!hasChild && context !== 'child' && !INHERENTLY_CHILD_CATEGORIES.has(String(candidate.category ?? ''))) return { verdict: 'review', reason: weakContext.length ? 'weak_child_context_only' : 'model_audience_label_only' };
    return { verdict: 'ok', reason: hasChild || context === 'child' ? 'child_evidence' : 'child_category' };
  }
  return hasChild || context === 'child' ? { verdict: 'ok', reason: 'child_evidence' } : { verdict: 'review', reason: weakContext.length ? 'weak_child_context_only' : 'no_child_evidence' };
}
function assessChildRelevance(candidate) { return childRelevanceEvidence(candidate).verdict; }

module.exports = { assessChildRelevance, childRelevanceEvidence, sourceContextAudience, ADULT_MARKERS, CHILD_MARKERS, WEAK_CHILD_CONTEXT, STRONG_CHILD_MARKERS, ADULT_CONTEXT_RE, CHILD_CONTEXT_RE, INHERENTLY_CHILD_CATEGORIES, SUBSCRIPTION_MARKERS };
