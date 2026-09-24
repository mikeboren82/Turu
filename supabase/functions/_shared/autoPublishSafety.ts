// TuRu - AUTO-PUBLISH CONTENT SAFETY (2026-09-24). Answers ONE question, independently of source trust:
// "does this candidate carry positive evidence that the listing itself is for children / families?"
// Trust answers "how much do we believe this publisher"; it never answers this - a trusted mall's tenant
// directory is still McDonald's. Every automated publish path runs this gate: scan-source autoApproveEligible
// (through a gating issue), the Cleaner hand-back and reprocess-review-queue.js (Node twin
// tools/import-tool/lib/autoPublishSafety.js, parity tests). It never rejects and never archives - a held
// candidate waits for a person with the evidence attached.
//
// WHY (production, 2026-09-24): 35 live auto-published rows of category 'אחר', 20 of them shops, food trucks,
// hotels, malls and markets. Every one passed assessChildRelevance as 'ok' because the model labelled it
// audience 'family' (168 of 290 auto-published rows carry that label) or its copy said "לכל המשפחה"; the
// model's family_fit ("מתאים לילד ולהורה") is the same boilerplate. autoApproveEligible had no category check.
// So: the model's audience / family_fit labels and generic family wording are NOT evidence here.
import { hasExplicitChildAge } from './extraction.ts';
import { trustedAges } from './ageEvidence.ts';

export const SAFETY_ISSUE_LABEL = 'רלוונטיות לילדים לא הוכחה';

// listing-level child wording (not "משפחה" / "לכל המשפחה" / a holiday name: marketing copy says those about shops)
export const STRONG_CHILD_WORDS = ['ילדים', 'ילדה', 'לילד', 'פעוט', 'תינוק', 'גיל הרך', 'קטנטנים', 'בייבי', 'הורה וילד', 'הצגת ילדים', 'תיאטרון ילדים', 'שעת סיפור', 'סדנת יצירה', 'קייטנה', 'מתנפחים', 'קוסם', 'ליצן', 'משחקייה', "ג'ימבורי", 'ג׳ימבורי', 'גני ילדים'];
// canonical categories that are children's things by definition (a kids' screening, a playroom, a story hour)
export const CHILD_INTRINSIC_CATEGORIES = new Set(['קולנוע לילדים', 'שעת סיפור', 'משחקייה', "ג'ימבורי", 'גן שעשועים', 'מוזיאון לילדים', 'פינת חי', 'טרמפולינות', 'הצגה']);
// family wording TIED TO THE LISTING counts in a commercial context once the business / 'אחר' rules have run
// (a mall's family festival); it never rescues a business description or an 'אחר' row
export const FAMILY_WORDS = ['משפחה', 'משפחות', 'משפחתי', 'לכל המשפחה', 'הורים וילדים'];
// publisher / venue contexts where most listings are commerce: malls, outlets, cinema-malls, shopping centres.
// Raises the evidence bar per candidate - never disables a source. (A tourism board is NOT one: its parks and
// beaches are family places; its restaurants and hotels are caught by the business rule.)
const COMMERCIAL_CONTEXT_RE = /קניון|קניוני|אאוטלט|סינמה|סינמול|מתחם קניות|פאוור סנטר|סנטר|\bmall\b|outlet|cinema|shopping/i;
// a PLACE that DESCRIBES ITSELF as a business - in its name or the opening words of its description ("חנות
// אופנה...", "רשת קונדיטוריות...", "מלון 4 כוכבים...", "פודטראק...", "קניון מודרני..."). A park or farm that
// merely HAS a café further down its description is not one. ("רשת המתנ״סים" = community centres, not a chain.)
// Whole words only (חנות is not the end of "טחנות"), optionally with ה/ו - never ב/ל: "בקניון" says WHERE the
// listing is, not WHAT it is. "סניף" is not here: a library branch (סניף ספרייה) is a family place.
const BUSINESS_RE = /(?:^|[\s\-–|(:!,"׳'])[הו]?(?:חנות|חנויות|רשת(?! (?:ה)?מתנ)|מסעד|בית קפה|בתי קפה|קונדיטור|פודטראק|פוד טראק|עגלת קפה|מלון|אופנה|קניון|מתחם קניות|פאוור סנטר|שייקים)/;
// a sale / promotion / market listing is commerce - judged on its TITLE ("20% הנחה לתושבים" inside a show's
// description is not a promotion listing; "שוקולד" is not a market)
const B = '(?:^|[\\s\\-–|(:!,])', E = '(?=$|[\\s\\-–|):!,])';
const PROMO_RE = new RegExp(`${B}(?:מבצע|הנחה|הנחות|קופון|שובר|sale)${E}|קנה\\s*[-–]?\\s*קבל|בקנייה מעל|מתנה בקנייה`, 'i');
const MARKET_RE = new RegExp(`${B}(?:ה|ב)?(?:שוק|יריד|מרקט|market)${E}`, 'i');
const openingWords = (s: string, n = 3) => s.trim().split(/\s+/).slice(0, n).join(' ');

export interface SafetyCandidate { name?: unknown; description?: unknown; category?: unknown; entity_type?: unknown; min_age?: unknown; max_age?: unknown; location_name?: unknown; age_evidence?: unknown; cleaner_fields?: unknown }
export interface SafetySource { name?: string | null; url?: string | null }
export interface SafetyVerdict { allow: boolean; code: string; commercialContext: boolean; evidence: string[] }

const str = (v: unknown) => (typeof v === 'string' ? v : '');

// explicit child ages - the SAME trusted-age rule as the relevance gate (ageEvidence twin, 2026-09-24): an age the
// source states for this item (title / bound card / detail-page content / event-local Cleaner record), or an age
// phrase in the item's own title. Never the model's min/max alone, never the model-written description: category
// 'אחר', a promotion or a mall item cannot pass because the model guessed 0-5.
export function childAgeEvidence(c: SafetyCandidate): string | null {
  // deno-lint-ignore no-explicit-any
  const t = trustedAges(c as Record<string, any>);
  const min = t ? t.min_age : null, max = t ? t.max_age : null;
  if (max != null && max <= 12) return `ages ${min ?? '?'}-${max}`;
  if (min != null && min <= 12 && max != null && max <= 16) return `ages ${min}-${max}`;
  if (hasExplicitChildAge(str(c.name))) return 'age phrase in title';
  return null;
}
export function strongChildWords(c: SafetyCandidate): string[] {
  const text = `${str(c.name)} ${str(c.description)}`;
  return STRONG_CHILD_WORDS.filter((w) => text.includes(w));
}
// the PUBLISHER's context (source name / URL) - never the event's own location: a municipal nature tour whose
// meeting point is a shopping centre is not mall content
export function isCommercialContext(source: SafetySource | null | undefined): boolean {
  return COMMERCIAL_CONTEXT_RE.test(`${source?.name || ''} ${source?.url || ''}`);
}

export function assessAutoPublishSafety(c: SafetyCandidate, source?: SafetySource | null): SafetyVerdict {
  const category = str(c.category) || null;
  const ages = childAgeEvidence(c);
  const words = strongChildWords(c);
  const commercialContext = isCommercialContext(source);
  const evidence: string[] = [];
  if (ages) evidence.push(ages);
  if (words.length) evidence.push('words: ' + words.slice(0, 4).join(', '));
  if (category) evidence.push('category: ' + category);
  const verdict = (allow: boolean, code: string): SafetyVerdict => ({ allow, code, commercialContext, evidence });

  // (1) a sale / promotion is not an activity unless the listing states a child age
  if (PROMO_RE.test(str(c.name)) && !ages) return verdict(false, 'promotion_without_child_evidence');
  // (2) a PLACE that describes itself as a business (shop, chain, restaurant, café, food truck, hotel, mall) is
  //     not an activity - unless its canonical category is a children's place by definition (a playroom chain)
  const selfDescription = `${str(c.name)} ${openingWords(str(c.description))}`;
  if (c.entity_type === 'מקום_קבוע' && BUSINESS_RE.test(selfDescription) && !(category && CHILD_INTRINSIC_CATEGORIES.has(category))) return verdict(false, 'business_listing');
  // (3) 'אחר' (or no category) never publishes on model labels alone: only an explicit child age will do
  if (!category || category === 'אחר') return ages ? verdict(true, 'other_category_with_child_age') : verdict(false, 'other_category_without_child_evidence');
  // (4) a market / fair needs child evidence (an age, strong child wording, a children's category)
  const strong = !!ages || words.length > 0 || CHILD_INTRINSIC_CATEGORIES.has(category);
  if (MARKET_RE.test(str(c.name))) return strong ? verdict(true, 'market_with_child_evidence') : verdict(false, 'market_without_child_evidence');
  // (5) a commercial context (mall / outlet / cinema-mall) needs listing-level child OR family evidence
  if (commercialContext) {
    const text = `${str(c.name)} ${str(c.description)}`;
    const family = FAMILY_WORDS.filter((w) => text.includes(w));
    if (family.length) evidence.push('family words: ' + family.slice(0, 3).join(', '));
    return strong || family.length ? verdict(true, 'commercial_with_child_evidence') : verdict(false, 'commercial_without_child_evidence');
  }
  return verdict(true, 'general');
}
