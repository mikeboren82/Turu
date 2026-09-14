// TuRu - THE MONSTER wave 1: consolidate the same EVENT stored once per performance (before the
// occurrence model, every dated candidate became its own activity: 37 groups / 100 rows on 2026-09-14).
//
// DRY RUN by default. Groups = approved activities with exactly one `one_time` row each, same
// non-generic normalized title, same source, same canonical venue (or same city + location name), same
// start time. Every group is CLASSIFIED - and only HIGH groups are ever merged:
//   HIGH        >= 2 members share a verified event_key of kind external_id / detail_url (written by rescans
//               with detail traversal), OR --verify-online confirmed on the source's own page that these
//               dates are performances of one titled event (title match >= 0.9, every member date present)
//   MEDIUM      title + source + venue + time only - plausible, NOT merged (repeated editions of different
//               events look exactly like this); listed for a human / a later verified rescan
//   DISTINCT    members disagree on time / venue on closer inspection
//   INSUFFICIENT no venue and no location name, or no source
// Merge (reversible, never deletes): keeper = earliest created; losers' schedule rows move to the keeper
// (unique on date+time), provenance is upserted onto the keeper, images / official_url / event_key are
// copied when the keeper lacks them, incoming rows (created + existing) are re-pointed, cleaner cases of
// losers are archived, losers are archived with archive_reason 'duplicate_of_existing_activity'. The
// keeper's event_fingerprint is untouched (legacy first-occurrence key; event_key is the identity).
//   node merge-occurrence-duplicates.js [--verify-online[=N]] [--apply] [--json=<file>]
require('dotenv').config();
const fs = require('fs');
const { getClient } = require('./supabase');
const { normalizeForMatch } = require('./eventFingerprint');
const { isGenericTitle } = require('./lib/eventIdentity');
const { fetchHtml } = require('./lib/fetchPage');
const { extractOccurrences, pageText, containsScore } = require('./lib/pageExtract');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const APPLY = !!args.apply;
const VERIFY = args['verify-online'] ? (args['verify-online'] === true ? 20 : Number(args['verify-online'])) : 0;

async function all(client, table, select, fn) {
  let from = 0, rows = [];
  while (true) { let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q); const { data, error } = await q; if (error) throw error; rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000; }
}
const t5 = (t) => (t ? String(t).slice(0, 5) : '');

(async () => {
  const { client, userId } = await getClient();
  const acts = await all(client, 'activities', 'id, name, status, source_id, venue_id, created_at, event_key, event_key_kind, official_url, location:locations(name, city), activity_schedules(id, schedule_type, one_time_date, start_time, end_time, external_id, booking_url), activity_images(id, url), activity_sources(page_url, url_role)',
    (q) => q.eq('status', 'approved').order('created_at', { ascending: true }));
  const groups = new Map();
  for (const a of acts) {
    const rows = a.activity_schedules || [];
    if (rows.length !== 1 || rows[0].schedule_type !== 'one_time' || !rows[0].one_time_date) continue;
    if (!a.source_id || isGenericTitle(a.name)) continue;
    const where = a.venue_id ? `v:${a.venue_id}` : (a.location?.city && a.location?.name ? `l:${normalizeForMatch(a.location.city)}|${normalizeForMatch(a.location.name)}` : null);
    if (!where) continue;
    const key = `${normalizeForMatch(a.name)}|${a.source_id}|${where}|${t5(rows[0].start_time)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const candidates = [...groups.values()].filter((g) => g.length > 1);
  const classified = [];
  let verified = 0;
  for (const g of candidates) {
    const dates = g.map((a) => a.activity_schedules[0].one_time_date);
    const strongKeys = g.map((a) => (a.event_key && ['external_id', 'detail_url'].includes(a.event_key_kind) ? a.event_key : null)).filter(Boolean);
    let cls = 'MEDIUM', why = 'title + source + venue + time only';
    if (strongKeys.length >= 2 && new Set(strongKeys).size === 1) { cls = 'HIGH'; why = `shared verified event_key (${g[0].event_key_kind})`; }
    else if (strongKeys.length >= 2 && new Set(strongKeys).size > 1) { cls = 'DISTINCT'; why = 'members carry different verified event keys'; }
    else if (VERIFY && verified < VERIFY) {
      // bounded online verification: the event's own page (detail provenance) or the listing page must
      // present every member date as a performance of one event titled like the group
      verified++;
      const detailUrls = [...new Set(g.flatMap((a) => (a.activity_sources || []).filter((p) => p.url_role === 'detail').map((p) => p.page_url)))];
      const pageUrl = detailUrls[0] || null;
      if (pageUrl) {
        try {
          const res = await fetchHtml(pageUrl);
          if (res.ok && res.html) {
            const html = res.html;
            const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '';
            const occ = extractOccurrences(html, '2000-01-01', pageUrl).map((o) => o.date);
            const titleOk = containsScore(title + ' ' + pageText(html).slice(0, 300), g[0].name) >= 0.9;
            const allDates = dates.every((d) => occ.includes(d));
            if (titleOk && allDates) { cls = 'HIGH'; why = `online: ${pageUrl} lists all ${dates.length} dates for this title`; }
            else why = `online check failed (title ${titleOk ? 'ok' : 'mismatch'}, ${dates.filter((d) => occ.includes(d)).length}/${dates.length} dates on page)`;
          } else why = `online check: HTTP ${res.status}`;
        } catch (e) { why = 'online check error: ' + e.message.slice(0, 60); }
      } else why = 'no detail-page provenance to verify against (MEDIUM)';
    }
    classified.push({ cls, why, keeper: g[0], losers: g.slice(1), dates });
  }
  const counts = { total: candidates.length, HIGH: 0, MEDIUM: 0, DISTINCT: 0, INSUFFICIENT: 0 };
  for (const c of classified) counts[c.cls]++;
  const rowsToArchive = classified.filter((c) => c.cls === 'HIGH').reduce((n, c) => n + c.losers.length, 0);
  console.log(`${APPLY ? 'APPLY (HIGH only)' : 'DRY RUN'}: groups ${counts.total} | HIGH ${counts.HIGH} | MEDIUM ${counts.MEDIUM} | DISTINCT ${counts.DISTINCT} | INSUFFICIENT ${counts.INSUFFICIENT} | rows that would be archived (HIGH) ${rowsToArchive}`);
  for (const c of classified) console.log(`  [${c.cls}] ${c.keeper.name.slice(0, 50)} × ${c.losers.length + 1} (${c.dates.slice(0, 4).join(', ')}${c.dates.length > 4 ? '…' : ''}) - ${c.why}`);
  // references that would be re-pointed (reported before any apply)
  const loserIds = classified.filter((c) => c.cls === 'HIGH').flatMap((c) => c.losers.map((l) => l.id));
  if (loserIds.length) {
    const [{ count: inc }, { count: cases }, { count: fav }, { count: planned }] = await Promise.all([
      client.from('incoming_activities').select('id', { count: 'exact', head: true }).or(`created_activity_id.in.(${loserIds.join(',')}),existing_activity_id.in.(${loserIds.join(',')})`),
      client.from('cleaner_cases').select('id', { count: 'exact', head: true }).in('subject_id', loserIds).eq('status', 'open'),
      client.from('favorites').select('id', { count: 'exact', head: true }).in('activity_id', loserIds).then((r) => r.error ? { count: 'n/a' } : r),
      client.from('planned_activities').select('id', { count: 'exact', head: true }).in('activity_id', loserIds).then((r) => r.error ? { count: 'n/a' } : r),
    ]);
    console.log(`  references on HIGH losers: incoming rows ${inc}, open cleaner cases ${cases}, favorites ${fav}, planned ${planned} (favorites/planned are re-pointed to the keeper where the unique constraint permits)`);
  }
  if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ generatedAt: new Date().toISOString(), counts, groups: classified.map((c) => ({ cls: c.cls, why: c.why, keeper: c.keeper.id, name: c.keeper.name, losers: c.losers.map((l) => l.id), dates: c.dates })) }, null, 2));
  if (!APPLY) return;

  let archived = 0, schedMoved = 0, provMoved = 0, imgMoved = 0, incRepointed = 0;
  for (const c of classified.filter((x) => x.cls === 'HIGH')) {
    const keeper = c.keeper;
    const have = new Set((keeper.activity_schedules || []).map((r) => `${r.one_time_date}|${t5(r.start_time)}`));
    for (const loser of c.losers) {
      for (const r of loser.activity_schedules || []) {
        const k = `${r.one_time_date}|${t5(r.start_time)}`; if (have.has(k)) continue; have.add(k);
        const { error } = await client.from('activity_schedules').insert({ activity_id: keeper.id, schedule_type: 'one_time', one_time_date: r.one_time_date, start_time: r.start_time, end_time: r.end_time, external_id: r.external_id, booking_url: r.booking_url });
        if (!error) schedMoved++;
      }
      const { data: prov } = await client.from('activity_sources').select('source_id, page_url, incoming_activity_id, relation, url_role, first_seen_at, last_seen_at').eq('activity_id', loser.id);
      for (const p of prov || []) { const { error } = await client.from('activity_sources').upsert({ ...p, activity_id: keeper.id, relation: 'seen', last_seen_at: p.last_seen_at || new Date().toISOString() }, { onConflict: 'activity_id,page_url' }); if (!error) provMoved++; }
      const keeperUrls = new Set((keeper.activity_images || []).map((i) => i.url));
      const newImgs = (loser.activity_images || []).filter((i) => !keeperUrls.has(i.url)).slice(0, 3).map((i) => ({ activity_id: keeper.id, url: i.url, uploaded_by: userId }));
      if (newImgs.length) { const { error } = await client.from('activity_images').insert(newImgs); if (!error) imgMoved += newImgs.length; }
      const patch = {}; if (!keeper.official_url && loser.official_url) patch.official_url = loser.official_url; if (!keeper.event_key && loser.event_key) { patch.event_key = loser.event_key; patch.event_key_kind = loser.event_key_kind; }
      if (Object.keys(patch).length) await client.from('activities').update(patch).eq('id', keeper.id);
      const now = new Date().toISOString();
      const { error: incErr } = await client.from('incoming_activities').update({ status: 'rejected', existing_activity_id: keeper.id, reviewed_by: userId, reviewed_at: now, reject_reason: 'מועד נוסף של אותו אירוע - אוחד לפעילות ' + keeper.id }).eq('created_activity_id', loser.id);
      if (!incErr) incRepointed++;
      await client.from('incoming_activities').update({ existing_activity_id: keeper.id }).eq('existing_activity_id', loser.id);
      await client.from('cleaner_cases').update({ status: 'archived', archive_reason: 'duplicate_of_existing_activity', resolution: { merged_into: keeper.id, by: 'merge-occurrence-duplicates' } }).eq('subject_id', loser.id).eq('status', 'open');
      for (const t of ['favorites', 'planned_activities']) { const { error } = await client.from(t).update({ activity_id: keeper.id }).eq('activity_id', loser.id); if (error && !/duplicate|unique/i.test(error.message)) console.log(`  ${t} re-point skipped for ${loser.id}: ${error.message.slice(0, 60)}`); }
      const { error: archErr } = await client.from('activities').update({ status: 'archived', archive_reason: 'duplicate_of_existing_activity', archived_at: now }).eq('id', loser.id);
      if (archErr) { console.log('  archive failed', loser.id, archErr.message); continue; }
      archived++;
    }
  }
  console.log(`done: archived ${archived}, occurrence rows moved ${schedMoved}, provenance rows moved ${provMoved}, images copied ${imgMoved}, incoming rows re-pointed ${incRepointed}`);
})().catch((e) => { console.error(e); process.exit(1); });
