// TuRu - THE CLEANER: schedule evidence for PUBLISHED events that have no usable schedule (Part B/C of the
// 2026-09-19 stabilization program). The live-activity missing_schedule path only replays the row that
// created the activity; this pass looks at the event's own pages (provenance 'created' page, detail page,
// official page) for EXISTING evidence - JSON-LD Event dates (HIGH), dates / weekdays in the card that names
// the event or on a detail page about it (MEDIUM) - and never invents availability.
// Classes: DATES_FOUND_HIGH | DATES_FOUND_MEDIUM | WEEKDAYS_FOUND_MEDIUM | EXPIRED_EVIDENCE (only past dates) |
//          PERMANENT_OFFERING_SUSPECTED (birthday / group / year-round / exhibition markers - the MODEL may be
//          wrong, a person decides) | NO_PAGE | NO_EVIDENCE | PLACE (permanent venue: hours stay UNKNOWN).
// --apply writes HIGH/MEDIUM schedule rows through the same activity_schedules insert the Cleaner uses (fill
// only when the activity still has no schedule; insert errors surface), archives an "אירוע" whose only evidence
// is past dates as `expired` (the existing cron semantics; verified write), and resolves the matching Cleaner
// missing_schedule case with the evidence. Everything else is reported.
//   node recover-event-schedules.js [--apply] [--max=N]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { fetchHtml } = require('./lib/fetchPage');
const { extractJsonLd, findEventCard, pageText, containsScore } = require('./lib/pageExtract');
const cheerio = require('cheerio');

// the text of the listing card that names this event (same climb as cleaner/fieldEnricher.js pageBundle)
function cardTextFor(html, name) {
  const $ = cheerio.load(html); let best = null, bestScore = 0;
  $('a[href], h1, h2, h3, h4, .title, .name').each((_, el) => { const s = containsScore(($(el).text() || '').replace(/\s+/g, ' ').trim().slice(0, 300), name || ''); if (s > bestScore && s >= 0.8) { bestScore = s; best = $(el); } });
  if (!best) return '';
  let el = best; for (let i = 0; i < 4; i++) { if ((el.text() || '').length > 60 || el.find('img').length) break; if (!el.parent().length || el.parent().is('body, html')) break; el = el.parent(); }
  return (el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 800);
}
const { datesIn, weekdaysIn } = require('./cleaner/fieldEnricher');
const { wordOverlapScore } = require('./cleaner/matching');
const { applyActivityPatch } = require('./cleaner/apply');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const APPLY = !!args.apply; const MAX = Number(args.max || Infinity);
const PERMANENT_RE = /יום הולדת|ימי הולדת|קבוצות|גיבוש|מנוי|כל השנה|לאורך השנה|בכל יום|כל יום|תערוכה|מתחם|משחק דיגיטלי|חדר בריחה|סיור קבוע|פתוח כל/;
const ISO = (d) => /^\d{4}-\d{2}-\d{2}/.test(d || '') ? d.slice(0, 10) : null;

(async () => {
  const { client } = await getClient();
  const today = new Date().toISOString().slice(0, 10);
  const acts = await all(client, 'activities', 'id, name, entity_type, category, status, source_url, detail_url, official_url, created_by, activity_schedules(id, schedule_type, one_time_date), activity_sources(page_url, relation, url_role)', (q) => q.eq('status', 'approved').neq('category', 'גן שעשועים'));
  const subjects = acts.filter((a) => { const s = a.activity_schedules || []; return !s.length || s.some((x) => x.schedule_type === 'one_time' && !x.one_time_date); });
  console.log(`published non-playground ${acts.length} | without usable schedule ${subjects.length} | ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  const rows = []; const dist = {}; let n = 0, written = 0, archived = 0, casesResolved = 0;
  for (const a of subjects) {
    if (n++ >= MAX) break;
    const row = { activity_id: a.id, name: a.name, entity_type: a.entity_type, category: a.category, null_owner: a.created_by == null, pages: [], klass: null, evidence: null };
    if (a.entity_type === 'מקום_קבוע') { row.klass = 'PLACE_HOURS_UNKNOWN'; rows.push(row); dist[row.klass] = (dist[row.klass] || 0) + 1; continue; }
    const urls = [...new Set([(a.activity_sources || []).find((s) => s.relation === 'created')?.page_url, a.detail_url, (a.activity_sources || []).find((s) => s.url_role === 'detail')?.page_url, a.official_url, a.source_url].filter((u) => u && /^https?:\/\//.test(u)))];
    const future = new Set(), past = new Set(); let weekdays = [], high = false, permanentHint = PERMANENT_RE.test(a.name || '');
    for (const u of urls.slice(0, 3)) {
      let r; try { r = await fetchHtml(u, { timeoutMs: 20000 }); } catch (e) { r = { ok: false, error: e.message }; }
      if (!r.ok || !r.html) { row.pages.push({ url: u, ok: false, status: r.status || r.error || 'fetch failed' }); continue; }
      const ld = extractJsonLd(r.html);
      const ev = ld.events.filter((e) => wordOverlapScore(e.name || '', a.name) >= 0.5);
      const single = ld.events.length === 1 && ev.length === 0 && wordOverlapScore(((/<title[^>]*>([^<]*)<\/title>/i.exec(r.html) || [])[1] || ''), a.name) >= 0.4 ? [ld.events[0]] : [];
      for (const e of [...ev, ...single]) { for (const d of [ISO(e.startDate), ISO(e.endDate)].filter(Boolean)) { high = true; (d >= today ? future : past).add(d); } }
      const card = findEventCard(r.html, u, a.name);
      const text = card && card.score >= 0.8 ? cardTextFor(r.html, a.name) : '';
      const title = ((/<title[^>]*>([^<]*)<\/title>/i.exec(r.html) || [])[1] || '');
      const about = wordOverlapScore(title, a.name) >= 0.4;
      const evidenceText = text || (about ? pageText(r.html).slice(0, 4000) : '');
      if (evidenceText) {
        for (const d of datesIn(evidenceText, today)) (d >= today ? future : past).add(d);
        if (!weekdays.length) weekdays = weekdaysIn(evidenceText);
        if (PERMANENT_RE.test(evidenceText)) permanentHint = true;
      }
      row.pages.push({ url: u, ok: true, jsonld_events: ld.events.length, matched_events: ev.length + single.length, card_score: card?.score ?? null, about, dates_future: [...future].length, dates_past: [...past].length, weekdays: weekdays.length });
    }
    const fut = [...future].sort(), pst = [...past].sort();
    if (!urls.length) row.klass = 'NO_PAGE';
    else if (fut.length && high) row.klass = 'DATES_FOUND_HIGH';
    else if (fut.length) row.klass = 'DATES_FOUND_MEDIUM';
    else if (weekdays.length && (a.entity_type === 'אירוע_קבוע' || a.entity_type === 'פעילות')) row.klass = 'WEEKDAYS_FOUND_MEDIUM';
    else if (pst.length && !permanentHint) row.klass = 'EXPIRED_EVIDENCE';
    else if (permanentHint) row.klass = 'PERMANENT_OFFERING_SUSPECTED';
    else if (row.pages.every((p) => !p.ok)) row.klass = 'NO_PAGE';
    else row.klass = 'NO_EVIDENCE';
    row.evidence = { future: fut.slice(0, 12), past: pst.slice(0, 6), weekdays, permanent_hint: permanentHint };
    dist[row.klass] = (dist[row.klass] || 0) + 1;
    console.log(`  ${row.klass.padEnd(30)} ${(a.entity_type || '').padEnd(10)} ${String(a.name).slice(0, 44).padEnd(44)} f=${fut.length} p=${pst.length} wd=${weekdays.join(',')}${a.created_by == null ? ' NULLOWNER' : ''}`);
    if (APPLY) {
      try {
        if (row.klass === 'DATES_FOUND_HIGH' || row.klass === 'DATES_FOUND_MEDIUM') {
          const { count } = await client.from('activity_schedules').select('id', { count: 'exact', head: true }).eq('activity_id', a.id).not('one_time_date', 'is', null);
          if (!count) {
            const dateless = (a.activity_schedules || []).filter((s) => s.schedule_type === 'one_time' && !s.one_time_date);
            const { error } = await client.from('activity_schedules').insert(fut.map((d) => ({ activity_id: a.id, schedule_type: 'one_time', one_time_date: d })));
            if (error) throw new Error('schedule insert: ' + error.message);
            if (dateless.length) { const { error: e2 } = await client.from('activity_schedules').delete().in('id', dateless.map((s) => s.id)); if (e2) throw new Error('dateless row delete: ' + e2.message); }
            if (a.entity_type !== 'אירוע' && a.entity_type !== 'אירוע_קבוע') { /* entity type untouched: dates on a class are performances, the type stays */ }
            row.applied = { schedule_rows: fut.length, confidence: row.klass === 'DATES_FOUND_HIGH' ? 'HIGH' : 'MEDIUM' }; written++;
          } else row.applied = { skipped: 'already_has_dated_schedule' };
        } else if (row.klass === 'WEEKDAYS_FOUND_MEDIUM') {
          const { count } = await client.from('activity_schedules').select('id', { count: 'exact', head: true }).eq('activity_id', a.id);
          if (!count) { const { error } = await client.from('activity_schedules').insert(weekdays.map((d) => ({ activity_id: a.id, schedule_type: 'recurring', day_of_week: d }))); if (error) throw new Error('schedule insert: ' + error.message); row.applied = { schedule_rows: weekdays.length, confidence: 'MEDIUM' }; written++; } else row.applied = { skipped: 'already_has_schedule' };
        } else if (row.klass === 'EXPIRED_EVIDENCE' && a.entity_type === 'אירוע') {
          const w = await applyActivityPatch(client, a.id, { status: 'archived', archive_reason: 'expired', archived_at: new Date().toISOString() }, (q) => q.eq('status', 'approved'), (r) => r.status === 'approved');
          row.applied = w; if (w.wrote) archived++;
        }
        if (row.applied && (row.applied.schedule_rows || row.applied.wrote)) {
          const { data: cs } = await client.from('cleaner_cases').update({ status: 'resolved', resolution: { outcome: row.applied.schedule_rows ? 'schedule_recovered' : 'archived_expired_evidence', confidence: row.applied.confidence || 'HIGH', evidence: row.evidence, pages: row.pages, repaired_by: 'recover-event-schedules', resolved_at: new Date().toISOString() }, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(), archive_reason: null }).eq('subject_kind', 'activity').eq('subject_id', a.id).eq('issue', 'missing_schedule').select('id');
          casesResolved += (cs || []).length;
        }
      } catch (e) { row.applied = { error: e.message }; console.log('    !! ' + e.message); }
    }
    rows.push(row);
  }
  const report = { generatedAt: new Date().toISOString(), applied: APPLY, published: acts.length, subjects: subjects.length, processed: rows.length, distribution: dist, writes: { scheduleRowsWritten: written, activitiesArchivedExpired: archived, casesResolved }, rows };
  const file = path.join(__dirname, `schedule-recovery-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('distribution', JSON.stringify(dist), '| writes', JSON.stringify(report.writes), '->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
