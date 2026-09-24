// TuRu - TEMPORAL SHAPE, Node twin of supabase/functions/_shared/temporalShape.ts (identical rules; the shared table
// _shared/temporalShape.cases.json runs against both). Is a candidate that claims ONE occurrence really one occurrence?
// A month-long programme ("מיום שני 31.08 עד יום רביעי 30.09") was publish-eligible as a single event on 09-30 because
// it "had its own date" (verify_location pilot re-run, f3bdec33). Pure, deterministic, no I/O. See the Deno twin's
// header for the scope and the three signals (date_span / period_language / recurring_sessions).

const GREG = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MONTH_INDEX = { ...Object.fromEntries(GREG.map((m, i) => [m, i + 1])), 'מרס': 3 };
const HEB_MONTHS = 'תשרי|חשוון|חשון|מרחשוון|כסלו|טבת|שבט|אדר|ניסן|אייר|סיון|סיוון|תמוז|אב|אלול';
const MONTHS = `${GREG.join('|')}|מרס|${HEB_MONTHS}`;
const WEEKDAYS = 'ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת';
const SEASONS = 'החודש|הקיץ|החופש|חופשת\\s+\\S+|החגים|חגי\\s+\\S+|העונה|השנה|הסמסטר|החורף';

// a month that only frames ONE event ("במסגרת / בעיצומו של / לכבוד / לקראת / בסימן חודש X") is not a period
const PERIOD_RE = new RegExp(`(?:^|(?<!(?:במסגרת|בעיצומו\\s+של|בעיצומה\\s+של|לכבוד|לקראת|בסימן|בפתח))[\\s,.(])(?:ב|ל)?(?:חודש|חודשי)\\s+(?:${MONTHS})(?=$|[\\s,.)\\d])|(?:לאורך|במהלך|בכל|כל)\\s+(?:כל\\s+)?(?:${SEASONS})(?=$|[\\s,.)])|עד\\s+סוף\\s+(?:${SEASONS})(?=$|[\\s,.)])`);
const SESSIONS_RE = new RegExp(`(?:ב)?כל\\s+יום\\s+(?:${WEEKDAYS})|בימי\\s+(?:${WEEKDAYS})|(?:כל|מדי)\\s+שבוע|פעם\\s+בשבוע|פעמיים\\s+בשבוע|מפגשים\\s+שבועיים|סדרת\\s+(?:מפגשים|סדנאות|הרצאות)|(?:^|\\s)\\d{1,2}\\s+מפגשים|(?:מדי|בכל)\\s+(?:יום|בוקר|ערב)(?=$|[\\s,.])`);

const D = '(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?';
const NUM_RANGE_RE = new RegExp(`${D}(?:,?\\s*\\d{1,2}:\\d{2})?\\s*(?:-|–|—|עד)\\s*(?:יום\\s+\\S+,?\\s*)?${D}`, 'g');
const TXT_RANGE_RE = new RegExp(`(\\d{1,2})\\s*(?:-|–|עד)\\s*(\\d{1,2})\\s+ב?(${GREG.join('|')}|מרס)`, 'g');

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const valid = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
const year4 = (y, fallback) => !y ? fallback : y.length === 2 ? 2000 + Number(y) : Number(y);

function statedDateSpan(text, refYear) {
  let best = null;
  const consider = (a, b, ev) => {
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

// the item's OWN printed date span in a listing: the FIRST date after its title must open a range (see the Deno twin)
const ANY_DATE_RE = new RegExp(`\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?|\\d{1,2}\\s*(?:-|–|עד)\\s*\\d{1,2}\\s+ב?(?:${GREG.join('|')}|מרס)|\\d{1,2}\\s+ב?(?:${GREG.join('|')}|מרס)`);
const NUM_RANGE_AT = new RegExp(`^${D}(?:,?\\s*\\d{1,2}:\\d{2})?\\s*(?:-|–|—|עד)\\s*(?:יום\\s+\\S+,?\\s*)?${D}`);
const TXT_RANGE_AT = new RegExp(`^(\\d{1,2})\\s*(?:-|–|עד)\\s*(\\d{1,2})\\s+ב?(${GREG.join('|')}|מרס)`);
function cardDateSpan(pageText, title, representedDate) {
  const flat = String(pageText || '').replace(/\s+/g, ' ');
  const key = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (key.length < 4) return null;
  const i = flat.indexOf(key); if (i < 0) return null;
  const after = flat.slice(i + key.length, i + key.length + 160);
  const first = ANY_DATE_RE.exec(after); if (!first || first.index > 80) return null;
  const refYear = representedDate ? Number(representedDate.slice(0, 4)) : new Date().getUTCFullYear();
  const rest = after.slice(first.index);
  const m = NUM_RANGE_AT.exec(rest) || TXT_RANGE_AT.exec(rest);
  return m ? statedDateSpan(m[0], refYear) : null;
}

function assessTemporalShape(c) {
  const dates = new Set((Array.isArray(c.occurrences) ? c.occurrences : []).map((o) => o && o.date).filter(Boolean));
  if (c.one_time_date) dates.add(c.one_time_date);
  if (c.schedule_type !== 'one_time' || dates.size > 1) return { collapsed: false, signals: [] };
  const text = `${c.name || ''}\n${c.description || ''}`.replace(/\s+/g, ' ');
  const signals = []; let evidence = null;
  const refYear = c.one_time_date ? Number(c.one_time_date.slice(0, 4)) : new Date().getUTCFullYear();
  const represented = c.one_time_date || null;
  const collapses = (sp) => !!sp && (sp.days >= 7 || (!!represented && represented !== sp.start));
  const span = statedDateSpan(text, refYear);
  if (collapses(span)) { signals.push('date_span'); evidence = span.evidence; }
  const card = (c.temporal_evidence && c.temporal_evidence.card_span) || null;
  if (card && represented && represented >= card.start && represented <= card.end && collapses(card) && !signals.includes('date_span')) { signals.push('date_span'); evidence = card.evidence || `${card.start}..${card.end}`; }
  const p = PERIOD_RE.exec(text); if (p) { signals.push('period_language'); evidence = evidence || p[0].trim(); }
  const s = SESSIONS_RE.exec(text); if (s) { signals.push('recurring_sessions'); evidence = evidence || s[0].trim(); }
  const sp = span || card;
  return { collapsed: signals.length > 0, signals, span: sp ? { start: sp.start, end: sp.end, days: sp.days } : null, evidence };
}

// a stored row without intake-time card evidence: derive it from the listing text it was extracted from
// (incoming_activities.raw_source_snapshot) so every Node evaluation path sees the same evidence scan-source did
function withCardEvidence(c, pageText) {
  if (!c || c.schedule_type !== 'one_time' || !pageText || (c.temporal_evidence && c.temporal_evidence.card_span !== undefined)) return c;
  const cs = cardDateSpan(pageText, c.name, c.one_time_date);
  return cs ? { ...c, temporal_evidence: { ...(c.temporal_evidence || {}), card_span: cs } } : c;
}

module.exports = { assessTemporalShape, statedDateSpan, cardDateSpan, withCardEvidence };
