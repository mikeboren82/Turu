// TuRu Cleaner - other important fields (THE-CLEANER.md §14-15). Only from traceable evidence:
//   incoming rows : METADATA RESOLVER (2026-09-14, pass 3) for the gating fields
//                   'סוג ישות' (entity_type), 'תאריך' (one_time_date / start_time), 'קהל יעד לא ברור'
//                   (audience / ages) and 'קטגוריה' (category). Evidence order: canonical fields ->
//                   JSON-LD on the source page and on the event's detail page -> the event's own card
//                   / detail text -> canonical venue / source metadata -> name keywords (MEDIUM, only
//                   with corroboration). HIGH = deterministic/structured, MEDIUM = corroborated,
//                   otherwise the field stays open and the reason is recorded. Nothing is guessed.
//   live activity : schedule from the row that created it (activity_sources -> incoming extracted_data),
//                   region from the venue or from the majority region Turu already stores for that city
// Fill-null only. Each filled field is returned with its provenance (extracted_data.cleaner_fields).
const { fetchHtml } = require('../lib/fetchPage');
const { extractJsonLd, contentText, findEventCard, containsScore } = require('../lib/pageExtract');
const { assessChildRelevance, CHILD_MARKERS, ADULT_MARKERS, SUBSCRIPTION_MARKERS } = require('../childRelevance');
// adult words that contradict page ages ("מיועדת למבוגרים בלבד", "18+", a lecture) - subscription words are not
// (children's theatre is sold in subscriptions too), the same split the relevance rule makes
const HARD_ADULT_MARKERS = ADULT_MARKERS.filter((m) => !SUBSCRIPTION_MARKERS.has(m));
const { wordOverlapScore } = require('./matching');
const { normalizeCityName } = require('../cityNaming');
const categoryValues = require('../../../supabase/functions/_shared/categoryValues.json');

const CATEGORIES = new Set(categoryValues.categories || categoryValues.CATEGORY_VALUES || []);
const LD_TYPE_TO_CATEGORY = { TheaterEvent: 'הצגה', MusicEvent: 'מוזיקה', DanceEvent: 'ריקוד', ExhibitionEvent: 'מוזיאון לילדים', ScreeningEvent: 'קולנוע לילדים', SportsEvent: 'ספורט', EducationEvent: 'סדנה', ChildrensEvent: 'פעילות קהילתית' };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const GATING = ['קטגוריה', 'תאריך', 'סוג ישות', 'קהל יעד לא ברור', 'ימי פעילות'];

// weekdays named next to a day marker ("ימי שלישי וחמישי", "כל יום שני", "בימי ראשון, רביעי") - the
// context word keeps "שני" (second) / "ראשון" (first) from counting as days on their own
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DAY_CTX_RE = /(?:ימי|ימים|יום|בימי|ביום|כל יום|בכל יום|מדי יום)\s+((?:ו?(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)[\s,\-–ו]*){1,7})/g;
function weekdaysIn(text) {
  const out = new Set();
  for (const m of (text || '').matchAll(DAY_CTX_RE)) for (const d of DAYS) if (new RegExp('(^|[\\s,ו\\-–])' + d + '(?=$|[\\s,\\-–])').test(m[1])) out.add(d);
  return DAYS.filter((d) => out.has(d));
}

// name keyword -> category (MEDIUM; needs corroboration). Order matters: specific before generic.
const NAME_CATEGORY = [
  [/שעת סיפור|סיפור בספרי|הקראת ספר/, 'שעת סיפור'], [/ג['׳]ימבורי|jimbor/i, "ג'ימבורי"], [/משחקייה|משחקיה/, 'משחקייה'],
  [/הצגה|הצגת|תיאטרון|מחזמר|בובות|מופע ילדים/, 'הצגה'], [/קונצרט|מופע מוזיקלי|שירה בציבור|שרים|מוזיקה|מוסיקה/, 'מוזיקה'],
  [/סדנת בישול|סדנת אפייה|בישול|אפייה|שוקולד/, 'בישול'], [/סדנת מדע|מדע|רובוטיקה|תכנות|טכנולוגי/, 'מדע'], [/סדנת יצירה|יצירה|ציור|קרמיקה|פיסול|אמנות/, 'יצירה'],
  [/סדנה|סדנת/, 'סדנה'], [/טיול|סיור|בטבע|נחל|שמורת|צפרות|ציפורים/, 'טבע'], [/מוזיאון|תערוכה/, 'מוזיאון לילדים'], [/ריקוד|מחול|זומבה/, 'ריקוד'],
  [/סרט|הקרנה|קולנוע/, 'קולנוע לילדים'], [/בריכה|שחייה|פעילות מים|מים/, 'פעילות מים'], [/ספורט|כדורגל|כדורסל|ריצה|אתלטיקה/, 'ספורט'],
  [/פינת חי|בעלי חיים|חיות|גן חיות/, 'בעלי חיים'], [/חווה|חוות/, 'חווה'], [/טרמפולינ/, 'טרמפולינות'], [/גן שעשועים|מגרש משחקים/, 'גן שעשועים'],
  [/הפנינג|יריד|פסטיבל|חגיגה|אירוע קהילתי|קהילתי/, 'פעילות קהילתית'],
];
// which source families / venue types corroborate which categories
const FAMILY_SUPPORTS = { library_network: ['שעת סיפור', 'ספרייה', 'יצירה', 'סדנה'], community_center_network: ['הצגה', 'סדנה', 'יצירה', 'פעילות קהילתית', 'מוזיקה', 'ריקוד', 'שעת סיפור'], venue_operator: ['הצגה', 'מוזיקה', 'מוזיאון לילדים', 'סדנה', 'קולנוע לילדים'], museum: ['מוזיאון לילדים', 'סדנה', 'יצירה'], municipality: ['פעילות קהילתית', 'פעילות עירונית', 'הצגה', 'טבע', 'מוזיקה'], regional_council: ['פעילות קהילתית', 'טבע', 'הצגה'], mall_chain: ['פעילות קהילתית', 'יצירה', 'סדנה', 'הצגה'], organizer: ['טבע', 'סדנה', 'הצגה'] };
const VENUE_SUPPORTS = { library: ['שעת סיפור', 'ספרייה', 'יצירה', 'סדנה'], theater: ['הצגה', 'מוזיקה', 'ריקוד'], museum: ['מוזיאון לילדים', 'סדנה', 'יצירה'], community_center: ['הצגה', 'סדנה', 'יצירה', 'פעילות קהילתית', 'שעת סיפור', 'מוזיקה'], park: ['טבע', 'פעילות קהילתית', 'גן שעשועים'], farm: ['חווה', 'בעלי חיים'], mall: ['פעילות קהילתית', 'יצירה', 'סדנה'], sports_center: ['ספורט', 'פעילות מים'], cultural_center: ['הצגה', 'מוזיקה', 'סדנה', 'יצירה'] };

// dd.mm.yyyy / dd/mm/yyyy / dd.mm (year inferred: next occurrence not in the past) + HH:MM
const DATE_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g;
const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
function datesIn(text, today) {
  const out = [];
  for (const m of (text || '').matchAll(DATE_RE)) {
    const d = Number(m[1]), mo = Number(m[2]); if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : Number(today.slice(0, 4));
    let iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!m[3] && iso < today) iso = `${y + 1}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (Number.isNaN(new Date(iso + 'T00:00:00Z').getTime())) continue;
    out.push(iso);
  }
  return [...new Set(out)];
}
// Explicit age evidence (rewritten 2026-09-24 after verify_location pilot #7, where the municipal menu item "רשות
// הצעירים והגיל הרך" made an evening concert "ages 0-5"). Callers pass event-local CONTENT text only (pageBundle):
//   1. an age word bound to numbers: "גילאי 3-6", "לגילאי 4+", "מגיל 5", "לבני 8-12", "גילאי 6-12, 13-18"
//   2. a bare number range that is an age range - not a date ("10-12.10", "2026-10-06"), a time ("10:00-12:00"), a
//      phone number, opening hours ("בשעות 10-12"), grades or a price - with lo < hi <= 18: "6-12", "13–18". Tags that
//      lost their separator ("13-186-12") split into their ranges. Ranges printed together (<= 40 chars apart) are
//      ONE audience -> their union (Turu stores a single min_age..max_age span); a later, separate range (another
//      event on the same page) is not merged in.
//   3. early-childhood WORDING bound to the event: "לגיל הרך", "בגיל הרך", "לפעוטות", "הורה ופעוט" -> 0-5.
//      The bare phrase "גיל הרך" is NOT evidence: it names departments and menu sections ("רשות הצעירים והגיל הרך",
//      "תחום הגיל הרך"), and a department noun right before the bound form ("האגף לגיל הרך") is refused too.
const HEB = '֐-׿';
const AGE_WORD_RE = new RegExp(`(?<![${HEB}])(?:גילאי|לגילאי|בגילאי|לגיל|בגיל|מגיל|גיל|לבני|בני)\\s*(\\d{1,2})(?:\\s*(?:[-–]|עד)\\s*(\\d{1,2}))?(\\s*\\+)?`, 'g');
const RANGE_RE = /(\d{1,2})\s*[-–]\s*(\d{1,2})/g;
const NOT_AGE_BEFORE_RE = /(?:שעות|בשעות|השעות|שעה|כיתות|כיתה|עמ'|₪|ש"ח|שקל|מחיר|טל'|טלפון)\s*$/;
const TODDLER_WORDING_RE = new RegExp(`(?<![${HEB}])(?:[לב]גיל הרך|לפעוטות|לתינוקות|לקטנטנים|הורה ופעוט|הורה ותינוק|הורים ופעוטות|הורים ותינוקות)(?![${HEB}])`, 'g');
const DEPARTMENT_BEFORE_RE = /(?:אגף|האגף|מחלקת|מחלקה|המחלקה|רשות|הרשות|תחום|מינהלת|מנהלת|המינהלת|יחידת|יחידה|היחידה|מדור|לשכת|רכזת|רכז|מנהל|מינהל|המנהל|המינהל|עמותת|העמותה|ועדת|הוועדה|מרכז|המרכז|פורום|תוכנית|התוכנית)\s*$/;
function ageRangesIn(text) {
  const t = text || '', found = [];
  for (const m of t.matchAll(AGE_WORD_RE)) {
    const lo = Number(m[1]), hi = m[2] != null ? Number(m[2]) : null;
    if (lo > 18 || (hi != null && hi < lo)) continue;
    found.push({ at: m.index, end: m.index + m[0].length, min: lo, max: hi, evidence: m[0].trim() });
  }
  let lastEnd = -1;
  for (const m of t.matchAll(RANGE_RE)) {
    const lo = Number(m[1]), hi = Number(m[2]), end = m.index + m[0].length;
    if (m.index !== lastEnd && /[\d:./\-–]/.test(t[m.index - 1] || '')) continue; // inside a longer number / date / time
    if (/^[:./\-–]\d/.test(t.slice(end, end + 2))) continue; // a date / time / phone number continues
    if (!(lo < hi && hi <= 18)) continue;
    if (NOT_AGE_BEFORE_RE.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
    lastEnd = end;
    if (found.some((f) => m.index >= f.at && end <= f.end)) continue; // already part of "גילאי 6-12"
    found.push({ at: m.index, end, min: lo, max: hi, evidence: m[0].replace(/\s+/g, '') });
  }
  found.sort((a, b) => a.at - b.at);
  const cluster = [];
  for (const f of found) { if (cluster.length && f.at - cluster[cluster.length - 1].end > 40) break; cluster.push(f); }
  return cluster;
}
// -> { min_age, max_age, evidence, kind: 'explicit_age' | 'child_wording' } | null
function agesIn(text) {
  const t = text || '';
  const ranges = ageRangesIn(t);
  if (ranges.length) {
    const open = ranges.some((r) => r.max == null); // "מגיל 5", "4+"
    const maxes = ranges.map((r) => r.max).filter((x) => x != null);
    return { min_age: Math.min(...ranges.map((r) => r.min)), max_age: open || !maxes.length ? null : Math.max(...maxes), evidence: ranges.map((r) => r.evidence).join(', '), kind: 'explicit_age' };
  }
  for (const m of t.matchAll(TODDLER_WORDING_RE)) {
    if (DEPARTMENT_BEFORE_RE.test(t.slice(Math.max(0, m.index - 20), m.index))) continue;
    return { min_age: 0, max_age: 5, evidence: m[0], kind: 'child_wording' };
  }
  return null;
}

async function pageBundle(client, row, ed, cache) {
  const out = { source: null, detail: null, detailUrl: null, card: null };
  if (!row.page_url) return out;
  const key = 'page:' + row.page_url;
  const r = cache.get(key) || await fetchHtml(row.page_url); cache.set(key, r);
  if (!r.ok || !r.html) return out;
  // metadata evidence is the page's CONTENT only - never header / mega-menu / nav / footer (lib/pageExtract CHROME)
  out.source = { url: row.page_url, html: r.html, ld: extractJsonLd(r.html), text: contentText(r.html, { separators: true }) };
  const card = findEventCard(r.html, row.page_url, ed.name || '');
  if (card.score >= 0.8) {
    // the card's own text (title, date line, age line) - reuse the same card the image resolver uses
    const cheerio = require('cheerio'); const $ = cheerio.load(r.html);
    let best = null, bestScore = 0;
    $('a[href], h1, h2, h3, h4, .title, .name').each((_, el) => { const s = containsScore(($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 300), ed.name || ''); if (s > bestScore && s >= 0.8) { bestScore = s; best = $(el); } });
    if (best) { let el = best; for (let i = 0; i < 4; i++) { if ((el.text() || '').length > 60 || el.find('img').length) break; if (!el.parent().length || el.parent().is('body, html')) break; el = el.parent(); } out.card = contentText($.html(el), { separators: true }).replace(/\s+/g, ' ').trim().slice(0, 800); }
    if (card.detailUrl) {
      const k2 = 'page:' + card.detailUrl;
      const r2 = cache.get(k2) || await fetchHtml(card.detailUrl); cache.set(k2, r2);
      if (r2.ok && r2.html) { const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(r2.html) || [])[1] || ''; out.detail = { url: card.detailUrl, html: r2.html, ld: extractJsonLd(r2.html), text: contentText(r2.html, { separators: true }).slice(0, 6000), title, about: wordOverlapScore(title, ed.name) >= 0.4 }; out.detailUrl = card.detailUrl; }
    }
  }
  return out;
}

// -> { filled: [field], remaining: [issue], tried: [stage], fields: {field: {value, confidence, evidence}}, unresolved: {issue: why}, rejected? }
async function resolveIncomingMetadata(client, row, ctx) {
  const ed = { ...(row.extracted_data || {}) }; let issues = [...(row.validation_issues || [])];
  const missing = issues.filter((i) => GATING.includes(i));
  const filled = [], tried = ['canonical_fields']; const fields = {}; const unresolved = {};
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const set = (field, value, confidence, evidence, issue, meta) => { fields[field] = { value, confidence, evidence, ...(meta || {}) }; filled.push(field); if (issue) issues = issues.filter((i) => i !== issue); };

  // 1. canonical fields already there (a stale issue list): audience/category/date present => clear
  if (issues.includes('קטגוריה') && ed.category && CATEGORIES.has(ed.category)) set('category', ed.category, 'HIGH', 'already extracted', 'קטגוריה');
  if (issues.includes('תאריך') && ed.schedule_type === 'one_time' && ISO_DATE.test(ed.one_time_date || '') && ed.one_time_date >= today) set('one_time_date', ed.one_time_date, 'HIGH', 'already extracted', 'תאריך');
  // an "אירוע" (one-time by definition) keeps its date issue - a non one-time schedule on it is the model's contradiction, not a resolution
  if (issues.includes('תאריך') && ed.schedule_type !== 'one_time' && ed.schedule_type && ed.entity_type !== 'אירוע') set('one_time_date', null, 'HIGH', 'not a one-time event (' + ed.schedule_type + ')', 'תאריך');
  // entity type is deterministic from the schedule (the prompt's own definitions)
  if (issues.includes('סוג ישות') && !ed.entity_type) {
    const st = ed.schedule_type || (ISO_DATE.test(ed.one_time_date || '') ? 'one_time' : null);
    const et = st === 'one_time' ? 'אירוע' : st === 'fixed_hours' ? 'מקום_קבוע' : st === 'recurring' ? (/חוג|קורס|שיעור|אימון|סדנת/.test(ed.name || '') ? 'פעילות' : 'אירוע_קבוע') : null;
    if (et) { ed.entity_type = et; if (!ed.schedule_type) ed.schedule_type = st; set('entity_type', et, 'HIGH', 'schedule_type ' + st, 'סוג ישות'); }
  }
  // 2-4. page evidence (source page + the event's card + its detail page), JSON-LD first
  const pages = ctx.cache ? await pageBundle(client, row, ed, ctx.cache) : { source: null, detail: null };
  if (pages.source) tried.push('source_page'); if (pages.card) tried.push('event_card'); if (pages.detail) tried.push('detail_page');
  const lds = [pages.detail?.ld, pages.source?.ld].filter(Boolean);
  const ev = lds.map((ld) => ld.events.find((e) => wordOverlapScore(e.name, ed.name) >= 0.5) || (ld.events.length === 1 ? ld.events[0] : null)).find(Boolean) || null;
  const texts = [pages.card, pages.detail?.about ? pages.detail.text : null].filter(Boolean);
  const evidenceText = texts.join('\n');

  if (issues.includes('תאריך') && (ed.schedule_type === 'one_time' || !ed.schedule_type)) {
    if (ev && ev.startDate && ISO_DATE.test(ev.startDate) && ev.startDate.slice(0, 10) >= today) {
      ed.one_time_date = ev.startDate.slice(0, 10); ed.schedule_type = ed.schedule_type || 'one_time'; const t = /T(\d{2}:\d{2})/.exec(ev.startDate); if (t && !ed.start_time) ed.start_time = t[1];
      set('one_time_date', ed.one_time_date, 'HIGH', 'JSON-LD startDate', 'תאריך');
    } else {
      // "single date" means ONE date in the evidence, counted BEFORE dropping past dates: a card reading
      // "מיום 31.08.2026 עד 30.09.2026" is a range whose start has passed, not a one-day event on 30.09
      // (2026-09-24, f3bdec33: a month-long programme became a single event on its last day)
      const cardAll = datesIn(pages.card || '', today);
      const detailAll = cardAll.length ? [] : datesIn(pages.detail?.about ? pages.detail.title + ' ' + pages.detail.text.slice(0, 1500) : '', today);
      const ds = cardAll.filter((d) => d >= today);
      const ds2 = ds.length ? ds : detailAll.filter((d) => d >= today);
      const all = cardAll.length ? cardAll : detailAll;
      if (ds2.length === 1 && all.length > 1) unresolved['תאריך'] = 'a date range / several dates in the evidence (' + all.slice(0, 4).join(', ') + ') - not one date';
      else if (ds2.length === 1) { ed.one_time_date = ds2[0]; ed.schedule_type = ed.schedule_type || 'one_time'; const t = TIME_RE.exec(pages.card || pages.detail?.text.slice(0, 1500) || ''); if (t && !ed.start_time) ed.start_time = `${t[1].padStart(2, '0')}:${t[2]}`; set('one_time_date', ds2[0], 'MEDIUM', (ds.length ? 'single date in the event card' : 'single date on the detail page') + (ed.start_time ? ' + time' : ''), 'תאריך'); }
      else unresolved['תאריך'] = ds2.length > 1 ? 'several dates on the page (' + ds2.slice(0, 4).join(', ') + ') - occurrences, not one date' : (pages.source ? 'no structured date and no date in the event card / detail page' : 'no page evidence');
    }
  }
  // recurring event without weekdays (the approval gate's temporal evidence): weekdays named in the event's
  // own card first, else on a detail page that is about this event; MEDIUM (text), never guessed
  if (issues.includes('ימי פעילות') && !(Array.isArray(ed.recurring_days) && ed.recurring_days.length)) {
    if (ed.schedule_type && ed.schedule_type !== 'recurring') { set('recurring_days', null, 'HIGH', 'not a recurring event (' + ed.schedule_type + ')', 'ימי פעילות'); }
    else {
      const fromCard = weekdaysIn(pages.card || '');
      const days = fromCard.length ? fromCard : weekdaysIn(pages.detail?.about ? pages.detail.title + ' ' + pages.detail.text.slice(0, 3000) : '');
      if (days.length) { ed.recurring_days = days; ed.schedule_type = ed.schedule_type || 'recurring'; set('recurring_days', days, 'MEDIUM', (fromCard.length ? 'weekdays named in the event card' : 'weekdays named on the detail page') + ': ' + days.join(', '), 'ימי פעילות'); }
      else unresolved['ימי פעילות'] = pages.source ? 'no weekday named in the event card / detail page' : 'no page evidence';
    }
  }
  if (issues.includes('קהל יעד לא ברור')) {
    // provenance (2026-09-24): the ages the relevance rule will read as first-party evidence must come from the
    // event's own card / detail CONTENT. Ages parsed from the model's description are model inference (MEDIUM).
    const scoped = [[pages.card, 'event_card'], [pages.detail?.about ? pages.detail.text : null, 'detail_content']].filter(([t]) => t);
    let ages = null, scope = null;
    for (const [t, sc] of scoped) { ages = agesIn(t); if (ages) { scope = sc; break; } }
    if (!ages && (ages = agesIn(ed.description || ''))) scope = 'model_description';
    const provenance = !ages ? null : scope === 'model_description' ? 'model_inference' : ages.kind === 'explicit_age' ? 'event_local_explicit_age' : 'event_local_child_wording';
    const rel = assessChildRelevance({ ...ed, description: (ed.description || '') + ' ' + evidenceText.slice(0, 3000) });
    if (rel === 'reject') { await client.from('incoming_activities').update({ status: 'rejected', archive_reason: 'invalid_event', reject_reason: 'קהל יעד למבוגרים לפי עמוד המקור (THE CLEANER)', reviewed_at: new Date().toISOString() }).eq('id', row.id).in('status', ['new', 'needs_review', 'failed']); return { filled: ['rejected_adult'], remaining: [], tried, fields, unresolved, rejected: true }; }
    if (ages && scope !== 'model_description' && HARD_ADULT_MARKERS.some((m) => evidenceText.includes(m))) unresolved['קהל יעד לא ברור'] = 'adult markers next to the extracted audience - a person decides';
    else if (ages) { if (ed.min_age == null) ed.min_age = ages.min_age; if (ed.max_age == null && ages.max_age != null) ed.max_age = ages.max_age; ed.audience = ed.audience && ed.audience !== 'unknown' ? ed.audience : (ages.max_age != null && ages.max_age <= 12 ? 'children' : 'family'); set('audience', ed.audience, provenance === 'event_local_explicit_age' ? 'HIGH' : 'MEDIUM', 'explicit ages: ' + ages.evidence, 'קהל יעד לא ברור', { provenance, scope }); }
    else {
      // child words with adult words in the same event content ("מתאים גם ... מיועדת למבוגרים בלבד") are a person's call
      const markers = CHILD_MARKERS.filter((m) => evidenceText.includes(m));
      if (rel === 'ok' && markers.length && !ADULT_MARKERS.some((m) => evidenceText.includes(m))) { ed.audience = ed.audience && ed.audience !== 'unknown' ? ed.audience : 'family'; set('audience', ed.audience, 'MEDIUM', 'child markers in the event page: ' + markers.slice(0, 4).join(', '), 'קהל יעד לא ברור', { provenance: 'event_local_child_wording', scope: 'card_or_detail_content' }); }
      else if (rel === 'ok' && ['children', 'family'].includes(ed.audience) && (ev || pages.detail?.about) && !ADULT_MARKERS.some((m) => evidenceText.includes(m))) { set('audience', ed.audience, 'MEDIUM', 'extracted audience ' + ed.audience + ', no adult markers on the event page', 'קהל יעד לא ברור', { provenance: 'model_inference', scope: 'extraction' }); }
      else unresolved['קהל יעד לא ברור'] = ADULT_MARKERS.some((m) => evidenceText.includes(m)) ? 'adult markers next to the extracted audience - a person decides' : (pages.source ? 'no age / audience evidence on the source, card or detail page' : 'no page evidence');
    }
  }
  if (issues.includes('קטגוריה') && !ed.category) {
    let cat = null, conf = null, why = null;
    const ldType = ev ? (ev.types || []).find((t) => LD_TYPE_TO_CATEGORY[t]) : null;
    if (ldType) { cat = LD_TYPE_TO_CATEGORY[ldType]; conf = 'HIGH'; why = 'JSON-LD @type ' + ldType; }
    else {
      const hit = NAME_CATEGORY.find(([re]) => re.test(ed.name || ''));
      if (hit) {
        const candidate = hit[1];
        const supports = new Set([...(FAMILY_SUPPORTS[row.source?.publisher_type] || []), ...(VENUE_SUPPORTS[ctx.venueType] || [])]);
        const inDesc = NAME_CATEGORY.some(([re, c]) => c === candidate && re.test((ed.description || '') + ' ' + evidenceText.slice(0, 2000)));
        if (supports.has(candidate) || inDesc) { cat = candidate; conf = 'MEDIUM'; why = `name keyword "${(ed.name || '').match(hit[0])[0]}" + ${supports.has(candidate) ? 'source/venue type agrees' : 'repeated in description/page'}`; }
        else unresolved['קטגוריה'] = `name suggests "${candidate}" but nothing corroborates it (source family ${row.source?.publisher_type || '?'})`;
      } else unresolved['קטגוריה'] = 'no structured type and no category keyword in the name';
    }
    if (cat && CATEGORIES.has(cat)) { ed.category = cat; set('category', cat, conf, why, 'קטגוריה'); }
  }
  if (filled.length && ctx.dry) return { filled, remaining: issues.filter((i) => missing.includes(i)), tried, fields, unresolved, dry: true };
  if (filled.length) {
    ed.cleaner_fields = { ...(ed.cleaner_fields || {}), ...fields, resolved_at: new Date().toISOString(), detail_url: pages.detailUrl || undefined };
    const gating = issues.filter((i) => i !== 'מחיר');
    const { data } = await client.from('incoming_activities').update({ extracted_data: ed, validation_issues: issues, status: gating.length ? 'needs_review' : 'new' }).eq('id', row.id).in('status', ['new', 'needs_review', 'failed']).select('id');
    if (!data || !data.length) return { filled: [], remaining: missing, tried, fields, unresolved: { all: 'row no longer open' } };
  }
  const remaining = issues.filter((i) => missing.includes(i));
  return { filled, remaining, tried, fields, unresolved };
}

async function enrichFields(client, target, ctx) {
  if (target.kind === 'incoming') return resolveIncomingMetadata(client, target.row, ctx);
  const filled = [], tried = [];
  // live activity
  const a = target.activity; const ed = target.extracted || {};
  if (!(a.activity_schedules || []).length && ed.schedule_type) {
    tried.push('creating_incoming_row');
    const rows = [];
    if (ed.schedule_type === 'recurring' && Array.isArray(ed.recurring_days) && ed.recurring_days.length) for (const d of ed.recurring_days) rows.push({ activity_id: a.id, schedule_type: 'recurring', day_of_week: d, start_time: ed.start_time || null, end_time: ed.end_time || null });
    else if (ed.schedule_type === 'one_time' && Array.isArray(ed.occurrences) && ed.occurrences.length) {
      // occurrence model (0091): one row per future performance, each with its own time / purchase link
      const seen = new Set();
      for (const o of ed.occurrences) { const k = `${o.date}|${(o.start_time || '').slice(0, 5)}`; if (!o.date || o.date < ctx.today || seen.has(k)) continue; seen.add(k); rows.push({ activity_id: a.id, schedule_type: 'one_time', one_time_date: o.date, start_time: o.start_time || null, end_time: o.end_time || null, external_id: o.external_id || null, booking_url: o.booking_url || null }); }
    }
    else if (ed.schedule_type === 'one_time' && ed.one_time_date && ed.one_time_date >= ctx.today) rows.push({ activity_id: a.id, schedule_type: 'one_time', one_time_date: ed.one_time_date, start_time: ed.start_time || null, end_time: ed.end_time || null });
    else if (ed.schedule_type === 'fixed_hours') rows.push({ activity_id: a.id, schedule_type: 'fixed_hours', start_time: ed.start_time || null, end_time: ed.end_time || null });
    if (rows.length) { const { error } = await client.from('activity_schedules').insert(rows); if (!error) filled.push('schedule'); }
  }
  if (a.locations && !a.locations.region) {
    tried.push('venue_or_city_region');
    let region = null;
    if (a.venue_id) { const { data: v } = await client.from('venues').select('region').eq('id', a.venue_id).maybeSingle(); region = v?.region || null; }
    if (!region && a.locations.city) {
      const city = normalizeCityName(a.locations.city);
      const { data: peers } = await client.from('locations').select('region').eq('city', city).not('region', 'is', null).limit(200);
      const t = {}; (peers || []).forEach((p) => { t[p.region] = (t[p.region] || 0) + 1; });
      const top = Object.entries(t).sort((x, y) => y[1] - x[1])[0];
      if (top && top[1] >= 3) region = top[0];
    }
    if (region) { const { error } = await client.from('locations').update({ region }).eq('id', a.locations.id).is('region', null); if (!error) filled.push('region'); }
  }
  return { filled, remaining: [], tried };
}

module.exports = { enrichFields, resolveIncomingMetadata, LD_TYPE_TO_CATEGORY, NAME_CATEGORY, datesIn, agesIn, weekdaysIn, GATING };
