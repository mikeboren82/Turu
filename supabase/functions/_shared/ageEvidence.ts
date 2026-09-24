// TuRu - TRUSTED AGE EVIDENCE (2026-09-24). Node twin: tools/import-tool/lib/ageEvidence.js (identical rules; the
// shared case table _shared/ageEvidence.cases.json runs against both, and a parity test compares the patterns).
// Pure, no I/O.
//
// WHY. The extraction model writes min_age / max_age, and the canonical relevance rule counted any max_age <= 18 or
// min_age <= 12 as explicit child evidence - so a number the MODEL guessed could publish an evening ballet (model
// min_age 2) or a live podcast (model 5+) automatically. Nothing recorded whether the number came from the source.
// (AGE-EVIDENCE-FORENSIC-2026-09-24.md: 368 of 587 aged rows in 60 days were model-only.)
//
// RULE. An age may PROVE child relevance only when event-local source text states it: the item's own title, its bound
// listing card, the content of its detail page (never header / nav / menu / footer), or a Cleaner record whose
// provenance is event-local. The raw min_age / max_age stay on the row as metadata, and a raw min_age >= 18 stays
// adult evidence (an adult age is never hidden because its provenance is weak) - that part is the relevance rule's.
//
// candidate.age_evidence (written at intake, inside extracted_data - no schema change):
//   { provenance: 'event_local_explicit_age' | 'event_local_worded_age' | 'detail_content' | 'model',
//     evidence: string | null, scope: 'name' | 'listing_card' | 'detail_page' | null,
//     min_age, max_age,            the range the SOURCE states (null for 'model')
//     model_agrees: boolean | null }  whether the model's own numbers equal it (audit only)

// ---- the age parser (the Cleaner's aade680 parser - one implementation for every path) ----
// Callers pass event-local CONTENT text only:
//   1. an age word bound to numbers: "גילאי 3-6", "לגילאי 4+", "מגיל 5", "לבני 8-12", "גילאי 6-12, 13-18"
//   2. a bare number range that is an age range - not a date, time, phone number, opening hours, grades or a price -
//      with lo < hi <= 18. Tags that lost their separator ("13-186-12") split into their ranges; ranges printed
//      together (<= 40 chars apart) are ONE audience -> their union (one min_age..max_age span).
//   3. early-childhood WORDING bound to the event ("לגיל הרך", "לפעוטות", "הורה ופעוט") -> 0-5; the bare phrase
//      "גיל הרך" (department / menu names) is not evidence, nor "האגף לגיל הרך".
const HEB = '֐-׿';
export const AGE_WORD_RE = new RegExp(`(?<![${HEB}])(?:גילאי|לגילאי|בגילאי|לגיל|בגיל|מגיל|גיל|לבני|בני)\\s*(\\d{1,2})(?:\\s*(?:[-–]|עד)\\s*(\\d{1,2}))?(\\s*\\+)?`, 'g');
export const RANGE_RE = /(\d{1,2})\s*[-–]\s*(\d{1,2})/g;
export const NOT_AGE_BEFORE_RE = /(?:שעות|בשעות|השעות|שעה|כיתות|כיתה|עמ'|₪|ש"ח|שקל|מחיר|טל'|טלפון)\s*$/;
// worded infant / toddler AGES (item titles at community centres: "לגילי זחילה עד עמידה", "גילי הליכה עד שנתיים וחצי",
// "לידה עד זחילה", "שנה וחצי עד שלוש", "לגילאי חצי שנה עד שנה") - developmental stages and number words, never a
// department name
const INFANT_WORDS = '(?:לידה|זחילה|הליכה|עמידה|חצי שנה|שנה וחצי|שנתיים וחצי|שנה|שנתיים|שלוש)';
export const TODDLER_WORDING_RE = new RegExp(`(?<![${HEB}])(?:[לב]גיל הרך|לפעוטות|לתינוקות|לקטנטנים|הורה ופעוט|הורה ותינוק|הורים ופעוטות|הורים ותינוקות|[לב]?גילי (?:ה)?(?:זחילה|הליכה|לידה)|[לב]גילאי ${INFANT_WORDS}|(?:מ)?${INFANT_WORDS} (?:ו)?עד (?:גיל )?${INFANT_WORDS})(?![${HEB}])`, 'g');
export const DEPARTMENT_BEFORE_RE = /(?:אגף|האגף|מחלקת|מחלקה|המחלקה|רשות|הרשות|תחום|מינהלת|מנהלת|המינהלת|יחידת|יחידה|היחידה|מדור|לשכת|רכזת|רכז|מנהל|מינהל|המנהל|המינהל|עמותת|העמותה|ועדת|הוועדה|מרכז|המרכז|פורום|תוכנית|התוכנית)\s*$/;

interface AgeRange { at: number; end: number; min: number; max: number | null; evidence: string }
export function ageRangesIn(text: string | null | undefined): AgeRange[] {
  const t = text || '', found: AgeRange[] = [];
  for (const m of t.matchAll(AGE_WORD_RE)) {
    // RTL pages print bound ranges reversed ("לגילאי 4 -2", Ra'anana 2026-09-14): the smaller number is the minimum
    const a = Number(m[1]), b = m[2] != null ? Number(m[2]) : null;
    const lo = b != null ? Math.min(a, b) : a, hi = b != null ? Math.max(a, b) : null;
    if (lo > 18) continue;
    found.push({ at: m.index!, end: m.index! + m[0].length, min: lo, max: hi, evidence: m[0].trim() });
  }
  let lastEnd = -1;
  for (const m of t.matchAll(RANGE_RE)) {
    const at = m.index!, lo = Number(m[1]), hi = Number(m[2]), end = at + m[0].length;
    if (at !== lastEnd && /[\d:./\-–]/.test(t[at - 1] || '')) continue; // inside a longer number / date / time
    if (/^[:./\-–]\d/.test(t.slice(end, end + 2))) continue; // a date / time / phone number continues
    if (!(lo < hi && hi <= 18)) continue;
    if (NOT_AGE_BEFORE_RE.test(t.slice(Math.max(0, at - 12), at))) continue;
    lastEnd = end;
    if (found.some((f) => at >= f.at && end <= f.end)) continue; // already part of "גילאי 6-12"
    found.push({ at, end, min: lo, max: hi, evidence: m[0].replace(/\s+/g, '') });
  }
  found.sort((a, b) => a.at - b.at);
  const cluster: AgeRange[] = [];
  for (const f of found) { if (cluster.length && f.at - cluster[cluster.length - 1].end > 40) break; cluster.push(f); }
  return cluster;
}
export interface ParsedAges { min_age: number; max_age: number | null; evidence: string; kind: 'explicit_age' | 'child_wording' }
export function agesIn(text: string | null | undefined): ParsedAges | null {
  const t = text || '';
  const ranges = ageRangesIn(t);
  if (ranges.length) {
    const open = ranges.some((r) => r.max == null); // "מגיל 5", "4+"
    const maxes = ranges.map((r) => r.max).filter((x): x is number => x != null);
    return { min_age: Math.min(...ranges.map((r) => r.min)), max_age: open || !maxes.length ? null : Math.max(...maxes), evidence: ranges.map((r) => r.evidence).join(', '), kind: 'explicit_age' };
  }
  for (const m of t.matchAll(TODDLER_WORDING_RE)) {
    if (DEPARTMENT_BEFORE_RE.test(t.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    return { min_age: 0, max_age: 5, evidence: m[0], kind: 'child_wording' };
  }
  return null;
}

// ---- trusted ages ----
export const TRUSTED_AGE_PROVENANCE = new Set(['event_local_explicit_age', 'event_local_worded_age', 'detail_content']);
// the Cleaner's own provenance (cleaner/fieldEnricher.js, aade680) - consumed as is, never duplicated
export const TRUSTED_CLEANER_PROVENANCE = new Set(['event_local_explicit_age', 'event_local_child_wording']);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
export interface TrustedAges { min_age: number | null; max_age: number | null; provenance: string; evidence: string | null }
export interface AgeEvidence { provenance: 'event_local_explicit_age' | 'event_local_worded_age' | 'detail_content' | 'model'; evidence: string | null; scope: 'name' | 'listing_card' | 'detail_page' | null; min_age: number | null; max_age: number | null; model_agrees: boolean | null }

// The age range that may count as CHILD evidence, or null. Order: the intake record (age_evidence) -> an event-local
// Cleaner record -> the item's own title (source text on every row, legacy included). Never the model's numbers,
// never the model-written description, never a Cleaner record that is legacy (no provenance), model_inference or
// invalidated.
// deno-lint-ignore no-explicit-any
export function trustedAges(c: Record<string, any> | null | undefined): TrustedAges | null {
  if (!c || typeof c !== 'object') return null;
  const ae = c.age_evidence;
  if (ae && typeof ae === 'object' && TRUSTED_AGE_PROVENANCE.has(ae.provenance) && (num(ae.min_age) || num(ae.max_age))) {
    return { min_age: num(ae.min_age) ? ae.min_age : null, max_age: num(ae.max_age) ? ae.max_age : null, provenance: ae.provenance, evidence: ae.evidence ?? null };
  }
  const a = c.cleaner_fields && c.cleaner_fields.audience;
  if (a && typeof a === 'object' && a.invalidated !== true && TRUSTED_CLEANER_PROVENANCE.has(a.provenance)) {
    const p = agesIn(str(a.evidence).replace(/^explicit ages:\s*/, ''));
    if (p) return { min_age: p.min_age, max_age: p.max_age, provenance: 'cleaner:' + a.provenance, evidence: a.evidence };
  }
  const n = agesIn(str(c.name));
  if (n) return { min_age: n.min_age, max_age: n.max_age, provenance: n.kind === 'explicit_age' ? 'event_local_explicit_age' : 'event_local_worded_age', evidence: n.evidence };
  return null;
}

// INTAKE: the age_evidence record for a candidate from its item-local source text - its title, its bound listing card
// (never the page around it) and its detail page CONTENT. First source that states an age wins. With no statement
// and a model age: provenance 'model'. With neither: null (nothing to record).
// deno-lint-ignore no-explicit-any
export function ageEvidenceFor(c: Record<string, any>, { cardText = null, detailText = null }: { cardText?: string | null; detailText?: string | null } = {}): AgeEvidence | null {
  const sources: [string, 'name' | 'listing_card' | 'detail_page'][] = [[str(c && c.name), 'name'], [str(cardText), 'listing_card'], [str(detailText), 'detail_page']];
  for (const [text, scope] of sources) {
    const a = agesIn(text);
    if (!a) continue;
    const provenance = scope === 'detail_page' ? 'detail_content' : a.kind === 'explicit_age' ? 'event_local_explicit_age' : 'event_local_worded_age';
    const modelAgrees = num(c.min_age) || num(c.max_age) ? (c.min_age ?? null) === a.min_age && (c.max_age ?? null) === a.max_age : null;
    return { provenance, evidence: a.evidence, scope, min_age: a.min_age, max_age: a.max_age, model_agrees: modelAgrees };
  }
  return num(c && c.min_age) || num(c && c.max_age) ? { provenance: 'model', evidence: null, scope: null, min_age: null, max_age: null, model_agrees: null } : null;
}
