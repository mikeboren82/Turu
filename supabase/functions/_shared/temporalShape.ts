// TuRu - TEMPORAL SHAPE (canonical publish policy, 2026-09-24). Is a candidate that claims ONE occurrence really
// one occurrence? A month-long programme ("מיום שני 31.08 עד יום רביעי 30.09") was published-eligible as a single
// event on 09-30 because it "had its own date" (verify_location pilot re-run, f3bdec33). Pure, deterministic, no I/O.
//
// Applies ONLY to a single-occurrence representation: schedule_type one_time with at most one distinct dated
// occurrence. Recurring / fixed-hours / commitment (חוג, קייטנה) / standing (אירוע_קבוע) shapes are not this gate's
// business - their own doctrine decides them. A representation that PRESERVES the range (occurrences on two or more
// of its dates) is not collapsed.
//
// Signals (any one => the representation is ambiguous; a person may still approve it):
//   date_span          the title/description states a date range of >= 7 days (a programme), or a shorter range whose
//                      START is not the represented date (the start was lost - e.g. it was already past)
//   period_language    the text frames the item as a period: "חודש ספטמבר", "לאורך החופש", "במהלך החגים", "כל הקיץ"
//   recurring_sessions the text describes repeated sessions: "בכל יום שני", "מדי שבוע", "8 מפגשים", "סדרת מפגשים"
// Node twin: tools/import-tool/lib/temporalShape.js; shared table: _shared/temporalShape.cases.json.

const GREG = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MONTH_INDEX: Record<string, number> = { ...Object.fromEntries(GREG.map((m, i) => [m, i + 1])), 'מרס': 3 };
const HEB_MONTHS = 'תשרי|חשוון|חשון|מרחשוון|כסלו|טבת|שבט|אדר|ניסן|אייר|סיון|סיוון|תמוז|אב|אלול';
const MONTHS = `${GREG.join('|')}|מרס|${HEB_MONTHS}`;
const WEEKDAYS = 'ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת';
const SEASONS = 'החודש|הקיץ|החופש|חופשת\\s+\\S+|החגים|חגי\\s+\\S+|העונה|השנה|הסמסטר|החורף';

// "(ב|לאורך|במהלך|כל) חודש ספטמבר", "חודשי הקיץ", "לאורך החופש", "במהלך חופשת סוכות", "עד סוף הקיץ" - but not a month
// that only frames ONE event: "במסגרת / בעיצומו של / לכבוד / לקראת / בסימן חודש X" (replay false positive 2026-09-24:
// "הצגה ... בעיצומו של חודש אוקטובר")
const PERIOD_RE = new RegExp(`(?:^|(?<!(?:במסגרת|בעיצומו\\s+של|בעיצומה\\s+של|לכבוד|לקראת|בסימן|בפתח))[\\s,.(])(?:ב|ל)?(?:חודש|חודשי)\\s+(?:${MONTHS})(?=$|[\\s,.)\\d])|(?:לאורך|במהלך|בכל|כל)\\s+(?:כל\\s+)?(?:${SEASONS})(?=$|[\\s,.)])|עד\\s+סוף\\s+(?:${SEASONS})(?=$|[\\s,.)])`);
// repeated sessions: a weekday cadence, a weekly cadence, a counted series
const SESSIONS_RE = new RegExp(`(?:ב)?כל\\s+יום\\s+(?:${WEEKDAYS})|בימי\\s+(?:${WEEKDAYS})|(?:כל|מדי)\\s+שבוע|פעם\\s+בשבוע|פעמיים\\s+בשבוע|מפגשים\\s+שבועיים|סדרת\\s+(?:מפגשים|סדנאות|הרצאות)|(?:^|\\s)\\d{1,2}\\s+מפגשים|(?:מדי|בכל)\\s+(?:יום|בוקר|ערב)(?=$|[\\s,.])`);

// numeric range: 31.08.2026 ... עד ... 30.09.2026 / 25/09-27/09 / 01/09/2026 - 31/10/2026 (a time or a weekday may sit between)
const D = '(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?';
const NUM_RANGE_RE = new RegExp(`${D}(?:,?\\s*\\d{1,2}:\\d{2})?\\s*(?:-|–|—|עד)\\s*(?:יום\\s+\\S+,?\\s*)?${D}`, 'g');
// textual same-month range: "25-27 בספטמבר" / "27-25 בספטמבר" (RTL) / "25 עד 27 בספטמבר"
const TXT_RANGE_RE = new RegExp(`(\\d{1,2})\\s*(?:-|–|עד)\\s*(\\d{1,2})\\s+ב?(${GREG.join('|')}|מרס)`, 'g');

export interface TemporalShapeCandidate {
  name?: string | null; description?: string | null; schedule_type?: string | null; entity_type?: string | null;
  one_time_date?: string | null; occurrences?: { date?: string | null }[] | null;
  temporal_evidence?: { card_span?: { start: string; end: string; days: number; evidence?: string } | null } | null;
}
export interface TemporalShapeAssessment { collapsed: boolean; signals: string[]; span?: { start: string; end: string; days: number } | null; evidence?: string | null }

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const valid = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
const dayDiff = (a: string, b: string) => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
const year4 = (y: string | undefined, fallback: number) => !y ? fallback : y.length === 2 ? 2000 + Number(y) : Number(y);

// the widest explicit date range stated in the text (year from the text, else from the represented date)
export function statedDateSpan(text: string, refYear: number): { start: string; end: string; days: number; evidence: string } | null {
  let best: { start: string; end: string; days: number; evidence: string } | null = null;
  const consider = (a: string, b: string, ev: string) => {
    const [start, end] = a <= b ? [a, b] : [b, a];
    const days = dayDiff(start, end);
    if (days >= 1 && days <= 400 && (!best || days > best.days)) best = { start, end, days, evidence: ev };
  };
  for (const m of text.matchAll(NUM_RANGE_RE)) {
    const d1 = Number(m[1]), m1 = Number(m[2]), d2 = Number(m[4]), m2 = Number(m[5]);
    if (!valid(m1, d1) || !valid(m2, d2)) continue;
    const y2 = year4(m[6], year4(m[3], refYear)), y1 = year4(m[3], m1 > m2 ? y2 - 1 : y2);
    consider(iso(y1, m1, d1), iso(y2, m2, d2), m[0]);
  }
  for (const m of text.matchAll(TXT_RANGE_RE)) {
    const mo = MONTH_INDEX[m[3]]; const a = Number(m[1]), b = Number(m[2]);
    if (!mo || !valid(mo, a) || !valid(mo, b)) continue;
    consider(iso(refYear, mo, a), iso(refYear, mo, b), m[0]);
  }
  return best;
}

// The item's OWN printed date span in a listing: the FIRST date after its title must open a range (so the next card's
// range is never borrowed - replay 2026-09-24: "קמפינג עירוני 28/09-30/09" sat 100 chars before a 10/09-30/09 card).
// Computed at intake from the page text (scan-source) and, for rows stored before that, from raw_source_snapshot
// (lib/incomingEligibility.js) -> candidate.temporal_evidence.card_span.
const ANY_DATE_RE = new RegExp(`\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?|\\d{1,2}\\s*(?:-|–|עד)\\s*\\d{1,2}\\s+ב?(?:${GREG.join('|')}|מרס)|\\d{1,2}\\s+ב?(?:${GREG.join('|')}|מרס)`);
export function cardDateSpan(pageText: string | null | undefined, title: string | null | undefined, representedDate: string | null | undefined): { start: string; end: string; days: number; evidence: string } | null {
  const flat = String(pageText || '').replace(/\s+/g, ' ');
  const key = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (key.length < 4) return null;
  const i = flat.indexOf(key); if (i < 0) return null;
  const after = flat.slice(i + key.length, i + key.length + 160);
  const first = ANY_DATE_RE.exec(after); if (!first || first.index! > 80) return null;
  const refYear = representedDate ? Number(representedDate.slice(0, 4)) : new Date().getUTCFullYear();
  // a range ANCHORED at that first date (a range printed further on belongs to someone else)
  const rest = after.slice(first.index!);
  const m = NUM_RANGE_AT.exec(rest) || TXT_RANGE_AT.exec(rest);
  return m ? statedDateSpan(m[0], refYear) : null;
}
const NUM_RANGE_AT = new RegExp(`^${D}(?:,?\\s*\\d{1,2}:\\d{2})?\\s*(?:-|–|—|עד)\\s*(?:יום\\s+\\S+,?\\s*)?${D}`);
const TXT_RANGE_AT = new RegExp(`^(\\d{1,2})\\s*(?:-|–|עד)\\s*(\\d{1,2})\\s+ב?(${GREG.join('|')}|מרס)`);

export function assessTemporalShape(c: TemporalShapeCandidate): TemporalShapeAssessment {
  const dates = new Set((Array.isArray(c.occurrences) ? c.occurrences : []).map((o) => o?.date).filter((d): d is string => !!d));
  if (c.one_time_date) dates.add(c.one_time_date);
  // only a SINGLE-occurrence one-time representation is in scope
  if (c.schedule_type !== 'one_time' || dates.size > 1) return { collapsed: false, signals: [] };
  const text = `${c.name || ''}\n${c.description || ''}`.replace(/\s+/g, ' ');
  const signals: string[] = []; let evidence: string | null = null;
  const refYear = c.one_time_date ? Number(c.one_time_date.slice(0, 4)) : new Date().getUTCFullYear();
  const represented = c.one_time_date || null;
  const collapses = (sp: { start: string; end: string; days: number } | null) => !!sp && (sp.days >= 7 || (!!represented && represented !== sp.start));
  const span = statedDateSpan(text, refYear);
  if (collapses(span)) { signals.push('date_span'); evidence = span!.evidence; }
  // the listing card's own printed range (intake page text / stored snapshot) - counts only when it contains the date
  const card = c.temporal_evidence?.card_span || null;
  if (card && represented && represented >= card.start && represented <= card.end && collapses(card) && !signals.includes('date_span')) { signals.push('date_span'); evidence = card.evidence || `${card.start}..${card.end}`; }
  const p = PERIOD_RE.exec(text); if (p) { signals.push('period_language'); evidence = evidence || p[0].trim(); }
  const s = SESSIONS_RE.exec(text); if (s) { signals.push('recurring_sessions'); evidence = evidence || s[0].trim(); }
  return { collapsed: signals.length > 0, signals, span: (span || card) ? { start: (span || card)!.start, end: (span || card)!.end, days: (span || card)!.days } : null, evidence };
}
