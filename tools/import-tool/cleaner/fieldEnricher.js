// TuRu Cleaner - other important fields (THE-CLEANER.md §14-15). Only from traceable sources:
//   incoming rows : the source page's JSON-LD (startDate -> one_time_date, @type -> category) and the
//                   page text for child relevance (audience); never invents a category
//   live activity : schedule from the row that created it (activity_sources -> incoming extracted_data),
//                   region from the venue or from the majority region Turu already stores for that city
// Fill-null only. Each filled field is returned with its provenance.
const { fetchHtml } = require('../lib/fetchPage');
const { extractJsonLd, pageText } = require('./pageEvidence');
const { assessChildRelevance, CHILD_MARKERS } = require('../childRelevance');
const { wordOverlapScore } = require('./matching');
const { normalizeCityName } = require('../cityNaming');
const categoryValues = require('../../../supabase/functions/_shared/categoryValues.json');

const CATEGORIES = new Set(categoryValues.categories || categoryValues.CATEGORY_VALUES || []);
const LD_TYPE_TO_CATEGORY = { TheaterEvent: 'הצגה', MusicEvent: 'מוזיקה', DanceEvent: 'ריקוד', ExhibitionEvent: 'מוזיאון לילדים', Festival: 'פסטיבל', ScreeningEvent: 'קולנוע לילדים', SportsEvent: 'ספורט', EducationEvent: 'סדנה', ChildrensEvent: 'פעילות קהילתית' };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

async function enrichFields(client, target, ctx) {
  const filled = [], tried = [];
  if (target.kind === 'incoming') {
    const row = target.row; const ed = { ...(row.extracted_data || {}) }; let issues = [...(row.validation_issues || [])];
    const remainingBefore = issues.filter((i) => ['קטגוריה', 'תאריך', 'סוג ישות', 'קהל יעד לא ברור'].includes(i));
    if (row.page_url) {
      tried.push('source_page');
      const r = await fetchHtml(row.page_url);
      if (r.ok && r.html) {
        const ld = extractJsonLd(r.html);
        const ev = ld.events.find((e) => wordOverlapScore(e.name, ed.name) >= 0.5) || (ld.events.length === 1 ? ld.events[0] : null);
        if (ev) {
          if (issues.includes('תאריך') && ed.schedule_type === 'one_time' && !ed.one_time_date && ev.startDate && ISO_DATE.test(ev.startDate)) { ed.one_time_date = ev.startDate.slice(0, 10); if (!ed.start_time && /T(\d{2}:\d{2})/.test(ev.startDate)) ed.start_time = /T(\d{2}:\d{2})/.exec(ev.startDate)[1]; issues = issues.filter((i) => i !== 'תאריך'); filled.push('one_time_date'); }
          if (issues.includes('קטגוריה') && !ed.category) { const t = (Array.isArray(ev['@type']) ? ev['@type'] : [ev['@type']]).find((x) => LD_TYPE_TO_CATEGORY[x]); const cat = t && LD_TYPE_TO_CATEGORY[t]; if (cat && (CATEGORIES.size === 0 || CATEGORIES.has(cat))) { ed.category = cat; issues = issues.filter((i) => i !== 'קטגוריה'); filled.push('category'); } }
        }
        if (issues.includes('קהל יעד לא ברור')) {
          const text = pageText(r.html).slice(0, 20000);
          const markers = CHILD_MARKERS.filter((m) => text.includes(m));
          const rel = assessChildRelevance({ ...ed, description: (ed.description || '') + ' ' + text.slice(0, 3000) });
          if (rel === 'ok' && markers.length) { ed.audience = ed.audience && ed.audience !== 'unknown' ? ed.audience : 'family'; issues = issues.filter((i) => i !== 'קהל יעד לא ברור'); filled.push('audience'); ed.cleaner_audience_evidence = { markers: markers.slice(0, 5), page: row.page_url }; }
          else if (rel === 'reject') { await client.from('incoming_activities').update({ status: 'rejected', archive_reason: 'invalid_event', reject_reason: 'קהל יעד למבוגרים לפי עמוד המקור (THE CLEANER)', reviewed_at: new Date().toISOString() }).eq('id', row.id); return { filled: ['rejected_adult'], remaining: [], tried }; }
        }
      }
    }
    if (filled.length) {
      const gating = issues.filter((i) => i !== 'מחיר');
      await client.from('incoming_activities').update({ extracted_data: ed, validation_issues: issues, status: gating.length ? 'needs_review' : 'new' }).eq('id', row.id);
    }
    const remaining = issues.filter((i) => remainingBefore.includes(i));
    return { filled, remaining, tried };
  }

  // live activity
  const a = target.activity; const ed = target.extracted || {};
  if (!(a.activity_schedules || []).length && ed.schedule_type) {
    tried.push('creating_incoming_row');
    const rows = [];
    if (ed.schedule_type === 'recurring' && Array.isArray(ed.recurring_days) && ed.recurring_days.length) for (const d of ed.recurring_days) rows.push({ activity_id: a.id, schedule_type: 'recurring', day_of_week: d, start_time: ed.start_time || null, end_time: ed.end_time || null });
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
    if (region) { const { error } = await client.from('locations').update({ region }).eq('id', a.locations.id); if (!error) filled.push('region'); }
  }
  return { filled, remaining: [], tried };
}

module.exports = { enrichFields, LD_TYPE_TO_CATEGORY };
