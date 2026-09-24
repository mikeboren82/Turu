// TuRu - AUTO-PUBLISH CONTENT SAFETY, Node twin of supabase/functions/_shared/autoPublishSafety.ts (identical
// rules; tests/autoPublishSafety.test.js asserts parity). Independent of source trust: a trusted publisher's
// tenant directory is still not a children's activity. Used by the Cleaner hand-back and
// reprocess-review-queue.js - every automated publish path outside scan-source.
const SAFETY_ISSUE_LABEL = 'רלוונטיות לילדים לא הוכחה';

const STRONG_CHILD_WORDS = ['ילדים', 'ילדה', 'לילד', 'פעוט', 'תינוק', 'גיל הרך', 'קטנטנים', 'בייבי', 'הורה וילד', 'הצגת ילדים', 'תיאטרון ילדים', 'שעת סיפור', 'סדנת יצירה', 'קייטנה', 'מתנפחים', 'קוסם', 'ליצן', 'משחקייה', "ג'ימבורי", 'ג׳ימבורי', 'גני ילדים'];
const CHILD_INTRINSIC_CATEGORIES = new Set(['קולנוע לילדים', 'שעת סיפור', 'משחקייה', "ג'ימבורי", 'גן שעשועים', 'מוזיאון לילדים', 'פינת חי', 'טרמפולינות', 'הצגה']);
const FAMILY_WORDS = ['משפחה', 'משפחות', 'משפחתי', 'לכל המשפחה', 'הורים וילדים'];
const COMMERCIAL_CONTEXT_RE = /קניון|קניוני|אאוטלט|סינמה|סינמול|מתחם קניות|פאוור סנטר|סנטר|\bmall\b|outlet|cinema|shopping/i;
const BUSINESS_RE = /(?:^|[\s\-–|(:!,"׳'])[הו]?(?:חנות|חנויות|רשת(?! (?:ה)?מתנ)|מסעד|בית קפה|בתי קפה|קונדיטור|פודטראק|פוד טראק|עגלת קפה|מלון|אופנה|קניון|מתחם קניות|פאוור סנטר|שייקים)/;
const B = '(?:^|[\\s\\-–|(:!,])', E = '(?=$|[\\s\\-–|):!,])';
const PROMO_RE = new RegExp(`${B}(?:מבצע|הנחה|הנחות|קופון|שובר|sale)${E}|קנה\\s*[-–]?\\s*קבל|בקנייה מעל|מתנה בקנייה`, 'i');
const MARKET_RE = new RegExp(`${B}(?:ה|ב)?(?:שוק|יריד|מרקט|market)${E}`, 'i');
const openingWords = (s, n = 3) => s.trim().split(/\s+/).slice(0, n).join(' ');
// same rule as supabase/functions/_shared/extraction.ts hasExplicitChildAge
const CHILD_AGE_RE = /(?:לגיל|לגילאי|גילאי|גיל|בני)\s*(\d{1,2})\s*(?:[-–]|עד)?\s*(\d{1,2})?/;
function hasExplicitChildAge(text) {
  const m = CHILD_AGE_RE.exec(text); if (!m) return false;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : NaN;
  const lo = Number.isNaN(b) ? a : Math.min(a, b), hi = Number.isNaN(b) ? a : Math.max(a, b);
  return lo <= 12 && hi <= 16;
}

const str = (v) => (typeof v === 'string' ? v : '');

function childAgeEvidence(c) {
  const min = typeof c.min_age === 'number' ? c.min_age : null, max = typeof c.max_age === 'number' ? c.max_age : null;
  if (max != null && max <= 12) return `ages ${min ?? '?'}-${max}`;
  if (min != null && min <= 12 && max != null && max <= 16) return `ages ${min}-${max}`;
  if (hasExplicitChildAge(`${str(c.name)} ${str(c.description)}`)) return 'age phrase in text';
  return null;
}
function strongChildWords(c) {
  const text = `${str(c.name)} ${str(c.description)}`;
  return STRONG_CHILD_WORDS.filter((w) => text.includes(w));
}
function isCommercialContext(source) {
  return COMMERCIAL_CONTEXT_RE.test(`${source?.name || ''} ${source?.url || ''}`);
}

function assessAutoPublishSafety(c, source) {
  const category = str(c.category) || null;
  const ages = childAgeEvidence(c);
  const words = strongChildWords(c);
  const commercialContext = isCommercialContext(source);
  const evidence = [];
  if (ages) evidence.push(ages);
  if (words.length) evidence.push('words: ' + words.slice(0, 4).join(', '));
  if (category) evidence.push('category: ' + category);
  const verdict = (allow, code) => ({ allow, code, commercialContext, evidence });
  if (PROMO_RE.test(str(c.name)) && !ages) return verdict(false, 'promotion_without_child_evidence');
  const selfDescription = `${str(c.name)} ${openingWords(str(c.description))}`;
  if (c.entity_type === 'מקום_קבוע' && BUSINESS_RE.test(selfDescription) && !(category && CHILD_INTRINSIC_CATEGORIES.has(category))) return verdict(false, 'business_listing');
  if (!category || category === 'אחר') return ages ? verdict(true, 'other_category_with_child_age') : verdict(false, 'other_category_without_child_evidence');
  const strong = !!ages || words.length > 0 || CHILD_INTRINSIC_CATEGORIES.has(category);
  if (MARKET_RE.test(str(c.name))) return strong ? verdict(true, 'market_with_child_evidence') : verdict(false, 'market_without_child_evidence');
  if (commercialContext) {
    const text = `${str(c.name)} ${str(c.description)}`;
    const family = FAMILY_WORDS.filter((w) => text.includes(w));
    if (family.length) evidence.push('family words: ' + family.slice(0, 3).join(', '));
    return strong || family.length ? verdict(true, 'commercial_with_child_evidence') : verdict(false, 'commercial_without_child_evidence');
  }
  return verdict(true, 'general');
}

module.exports = {
  SAFETY_ISSUE_LABEL, STRONG_CHILD_WORDS, FAMILY_WORDS, CHILD_INTRINSIC_CATEGORIES, CHILD_AGE_RE,
  hasExplicitChildAge, childAgeEvidence, strongChildWords, isCommercialContext, assessAutoPublishSafety,
};
