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
const { extractJsonLd, pageText, findEventCard, containsScore } = require('../lib/pageExtract');
const { assessChildRelevance, CHILD_MARKERS, ADULT_MARKERS } = require('../childRelevance');
const { wordOverlapScore } = require('./matching');
const { normalizeCityName } = require('../cityNaming');
const categoryValues = require('../../../supabase/functions/_shared/categoryValues.json');

const CATEGORIES = new Set(categoryValues.categories || categoryValues.CATEGORY_VALUES || []);
const LD_TYPE_TO_CATEGORY = { TheaterEvent: 'הצגה', MusicEvent: 'מוזיקה', DanceEvent: 'ריקוד', ExhibitionEvent: 'מוזיאון לילדים', ScreeningEvent: 'קולנוע לילדים', SportsEvent: 'ספורט', EducationEvent: 'סדנה', ChildrensEvent: 'פעילות קהילתית' };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const GATING = ['קטגוריה', 'תאריך', 'סוג ישות', 'קהל יעד לא ברור'];

// name keyword -> category (MEDIUM; needs corroboration). Order matters: specific before generic.
const NAME_CATEGORY = [
  [/שעת סיפור|סיפור בספרי|הקראת ספר/, 'שעת סיפור'], [/ג['׳]ימבורי|jimbor/i, "ג'ימבורי"], [/משחקייה|משחקיה/, 'משחקייה'],
  [/הצגה|הצגת|תיאטרון|מחזמר|בובות|מופע ילדים/, 'הצגה'], [/קונצרט|מופע מוזיקלי|שירה בציבור|שרים|מוזיקה|מוסיקה/, 'מוזיקה'],
  [/סדנת בישול|סדנת אפייה|בישול|אפייה|שוקולד/, 'בישול'], [/סדנת מדע|מדע|רובוטיקה|תכנות|טכנולוגי/, 'מדע'], [/סדנת יצירה|יצירה|ציור|קרמיקה|פיסול|אמנות/, 'יצירה'],
  [/סדנה|סדנת/, 'סדנה'], [/טיול|סיור|בטבע|נחל|שמורת/, 'טבע'], [/מוזיאון|תערוכה/, 'מוזיאון לילדים'], [/ריקוד|מחול|זומבה/, 'ריקוד'],
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
// explicit age evidence: "גילאי 3-6", "לגילאי 4+", "מגיל 5", "לגיל הרך", "לפעוטות", "0-3"
const AGE_RANGE_RE = /(?:גילאי|לגילאי|לגיל|גיל|בני)\s*(\d{1,2})\s*(?:[-–עד]+\s*(\d{1,2}))?\s*(\+)?|\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:שנים|גילאים)?\b(?=[^\d]|$)/;
function agesIn(text) {
  const t = text || '';
  const m = AGE_RANGE_RE.exec(t);
  if (m) {
    const lo = Number(m[1] ?? m[4]), hi = m[2] ?? m[5]; const plus = !!m[3];
    if (Number.isFinite(lo) && lo <= 18) return { min_age: lo, max_age: hi ? Number(hi) : (plus ? null : null), evidence: m[0] };
  }
  if (/גיל הרך|לפעוטות|פעוטות|קטנטנים|תינוקות/.test(t)) return { min_age: 0, max_age: 5, evidence: (t.match(/גיל הרך|לפעוטות|פעוטות|קטנטנים|תינוקות/) || [])[0] };
  return null;
}

async function pageBundle(client, row, ed, cache) {
  const out = { source: null, detail: null, detailUrl: null, card: null };
  if (!row.page_url) return out;
  const key = 'page:' + row.page_url;
  const r = cache.get(key) || await fetchHtml(row.page_url); cache.set(key, r);
  if (!r.ok || !r.html) return out;
  out.source = { url: row.page_url, html: r.html, ld: extractJsonLd(r.html), text: pageText(r.html) };
  const card = findEventCard(r.html, row.page_url, ed.name || '');
  if (card.score >= 0.8) {
    // the card's own text (title, date line, age line) - reuse the same card the image resolver uses
    const cheerio = require('cheerio'); const $ = cheerio.load(r.html);
    let best = null, bestScore = 0;
    $('a[href], h1, h2, h3, h4, .title, .name').each((_, el) => { const s = containsScore(($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 300), ed.name || ''); if (s > bestScore && s >= 0.8) { bestScore = s; best = $(el); } });
    if (best) { let el = best; for (let i = 0; i < 4; i++) { if ((el.text() || '').length > 60 || el.find('img').length) break; if (!el.parent().length || el.parent().is('body, html')) break; el = el.parent(); } out.card = (el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 800); }
    if (card.detailUrl) {
      const k2 = 'page:' + card.detailUrl;
      const r2 = cache.get(k2) || await fetchHtml(card.detailUrl); cache.set(k2, r2);
      if (r2.ok && r2.html) { const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(r2.html) || [])[1] || ''; out.detail = { url: card.detailUrl, html: r2.html, ld: extractJsonLd(r2.html), text: pageText(r2.html).slice(0, 6000), title, about: wordOverlapScore(title, ed.name) >= 0.4 }; out.detailUrl = card.detailUrl; }
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
  const set = (field, value, confidence, evidence, issue) => { fields[field] = { value, confidence, evidence }; filled.push(field); if (issue) issues = issues.filter((i) => i !== issue); };

  // 1. canonical fields already there (a stale issue list): audience/category/date present => clear
  if (issues.includes('קטגוריה') && ed.category && CATEGORIES.has(ed.category)) set('category', ed.category, 'HIGH', 'already extracted', 'קטגוריה');
  if (issues.includes('תאריך') && ed.schedule_type === 'one_time' && ISO_DATE.test(ed.one_time_date || '') && ed.one_time_date >= today) set('one_time_date', ed.one_time_date, 'HIGH', 'already extracted', 'תאריך');
  if (issues.includes('תאריך') && ed.schedule_type !== 'one_time' && ed.schedule_type) set('one_time_date', null, 'HIGH', 'not a one-time event (' + ed.schedule_type + ')', 'תאריך');
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
      const ds = datesIn(pages.card || '', today).filter((d) => d >= today);
      const ds2 = ds.length ? ds : datesIn(pages.detail?.about ? pages.detail.title + ' ' + pages.detail.text.slice(0, 1500) : '', today).filter((d) => d >= today);
      if (ds2.length === 1) { ed.one_time_date = ds2[0]; ed.schedule_type = ed.schedule_type || 'one_time'; const t = TIME_RE.exec(pages.card || pages.detail?.text.slice(0, 1500) || ''); if (t && !ed.start_time) ed.start_time = `${t[1].padStart(2, '0')}:${t[2]}`; set('one_time_date', ds2[0], 'MEDIUM', (ds.length ? 'single date in the event card' : 'single date on the detail page') + (ed.start_time ? ' + time' : ''), 'תאריך'); }
      else unresolved['תאריך'] = ds2.length > 1 ? 'several dates on the page (' + ds2.slice(0, 4).join(', ') + ') - occurrences, not one date' : (pages.source ? 'no structured date and no date in the event card / detail page' : 'no page evidence');
    }
  }
  if (issues.includes('קהל יעד לא ברור')) {
    const ages = agesIn(evidenceText) || agesIn(ed.description || '');
    const rel = assessChildRelevance({ ...ed, description: (ed.description || '') + ' ' + evidenceText.slice(0, 3000) });
    if (rel === 'reject') { await client.from('incoming_activities').update({ status: 'rejected', archive_reason: 'invalid_event', reject_reason: 'קהל יעד למבוגרים לפי עמוד המקור (THE CLEANER)', reviewed_at: new Date().toISOString() }).eq('id', row.id).in('status', ['new', 'needs_review', 'failed']); return { filled: ['rejected_adult'], remaining: [], tried, fields, unresolved, rejected: true }; }
    if (ages) { if (ed.min_age == null) ed.min_age = ages.min_age; if (ed.max_age == null && ages.max_age != null) ed.max_age = ages.max_age; ed.audience = ed.audience && ed.audience !== 'unknown' ? ed.audience : (ages.max_age != null && ages.max_age <= 12 ? 'children' : 'family'); set('audience', ed.audience, 'HIGH', 'explicit ages: ' + ages.evidence, 'קהל יעד לא ברור'); }
    else {
      const markers = CHILD_MARKERS.filter((m) => evidenceText.includes(m));
      if (rel === 'ok' && markers.length) { ed.audience = ed.audience && ed.audience !== 'unknown' ? ed.audience : 'family'; set('audience', ed.audience, 'MEDIUM', 'child markers in the event page: ' + markers.slice(0, 4).join(', '), 'קהל יעד לא ברור'); }
      else if (rel === 'ok' && ['children', 'family'].includes(ed.audience) && (ev || pages.detail?.about)) { set('audience', ed.audience, 'MEDIUM', 'extracted audience ' + ed.audience + ', no adult markers on the event page', 'קהל יעד לא ברור'); }
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

module.exports = { enrichFields, resolveIncomingMetadata, LD_TYPE_TO_CATEGORY, NAME_CATEGORY, datesIn, agesIn, GATING };
