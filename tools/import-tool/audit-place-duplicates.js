// TuRu - THE CLEANER: DB-wide PLACE-duplicate audit + conservative merge (failure class of the
// "חי פארק בכפר סבא" regression). One rule, lib/placeIdentity.js: <= 80 m AND the names agree once locality
// words are dropped; never dated events, never playgrounds.
//   HIGH    the rule holds                                  -> merged with --apply
//   REVIEW  same spot, different names                      -> listed only (another tenant of one site)
// Merge (reversible, never deletes): keeper = the richer record (images, venue link, provenance, source,
// age); the loser is archived 'duplicate_of_existing_activity'; its provenance rows are copied onto the keeper
// as 'seen', its images are copied when the keeper has none, the keeper's NULL fields are filled from it
// (description / ages / price / official_url / venue) - never overwritten; open Cleaner cases of the loser
// are closed. Dry run by default:   node audit-place-duplicates.js [--apply]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { samePlace } = require('./lib/placeIdentity');

const APPLY = process.argv.includes('--apply');
const richness = (a) => (a.activity_images || []).length * 3 + (a.venue_id ? 3 : 0) + (a.source_id ? 2 : 0) + (a.activity_sources || []).length + (a.description ? 1 : 0) + (a.official_url ? 1 : 0);

(async () => {
  const { client, userId } = await getClient();
  const acts = await all(client, 'activities', 'id, name, category, description, min_age, max_age, price_type, price_amount, official_url, venue_id, source_id, source_url, created_at, locations!inner(city, lat, lng, address), activity_schedules(schedule_type, day_of_week, start_time), activity_images(id, url, image_source_url, image_source_type, needs_rights_review, image_kind, image_page_url), activity_sources(source_id, page_url, url_role)', (q) => q.eq('status', 'approved').neq('category', 'גן שעשועים').not('locations.lat', 'is', null));
  const flat = acts.map((a) => ({ ...a, city: a.locations.city, lat: a.locations.lat, lng: a.locations.lng }));
  // grid buckets (~110 m) so the pair search is not quadratic
  const grid = new Map(); const cell = (v) => Math.floor(Number(v) / 0.001);
  for (const a of flat) { const k = `${cell(a.lat)}|${cell(a.lng)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(a); }
  const pairs = []; const seen = new Set();
  for (const a of flat) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const b of grid.get(`${cell(a.lat) + dx}|${cell(a.lng) + dy}`) || []) {
    if (a.id >= b.id) continue; const key = a.id + b.id; if (seen.has(key)) continue; seen.add(key);
    const v = samePlace(a, b); if (v.km == null || v.km > 0.08 || v.why.startsWith('a dated') ) continue;
    pairs.push({ a, b, v });
  }
  const high = pairs.filter((p) => p.v.same), review = pairs.filter((p) => !p.v.same);
  console.log(`evergreen non-playground places ${flat.length} | co-located pairs ${pairs.length} | HIGH same place ${high.length} | REVIEW (same spot, different name) ${review.length}`);
  const merged = new Set(); const plan = [];
  for (const p of high) {
    if (merged.has(p.a.id) || merged.has(p.b.id)) continue; // a chain is resolved one pair per run
    const [keeper, loser] = richness(p.a) >= richness(p.b) ? (richness(p.a) === richness(p.b) && p.b.created_at < p.a.created_at ? [p.b, p.a] : [p.a, p.b]) : [p.b, p.a];
    merged.add(loser.id);
    plan.push({ keeper: { id: keeper.id, name: keeper.name, richness: richness(keeper) }, loser: { id: loser.id, name: loser.name, richness: richness(loser) }, km: p.v.km, agreement: p.v.agreement, city: keeper.city });
    console.log(`  [HIGH] keep "${keeper.name}" (${richness(keeper)}) <- "${loser.name}" (${richness(loser)}) | ${keeper.city} | ${Math.round(p.v.km * 1000)} m | names ${p.v.agreement}`);
    if (!APPLY) continue;
    const now = new Date().toISOString();
    const { data: arch } = await client.from('activities').update({ status: 'archived', archive_reason: 'duplicate_of_existing_activity', archived_at: now }).eq('id', loser.id).eq('status', 'approved').select('id');
    if (!arch || !arch.length) continue;
    for (const s of loser.activity_sources || []) await client.from('activity_sources').upsert({ activity_id: keeper.id, source_id: s.source_id, page_url: s.page_url, relation: 'seen', url_role: s.url_role || null, last_seen_at: now }, { onConflict: 'activity_id,page_url' });
    if (loser.source_url) await client.from('activity_sources').upsert({ activity_id: keeper.id, source_id: loser.source_id || null, page_url: loser.source_url, relation: 'seen', last_seen_at: now }, { onConflict: 'activity_id,page_url' });
    if (!(keeper.activity_images || []).length) for (const i of loser.activity_images || []) await client.from('activity_images').insert({ activity_id: keeper.id, url: i.url, uploaded_by: userId || null, status: 'approved', image_source_url: i.image_source_url, image_source_type: i.image_source_type, needs_rights_review: i.needs_rights_review, image_kind: i.image_kind, image_page_url: i.image_page_url });
    for (const col of ['description', 'min_age', 'max_age', 'official_url', 'venue_id']) if (keeper[col] == null && loser[col] != null) await client.from('activities').update({ [col]: loser[col] }).eq('id', keeper.id).is(col, null);
    if (keeper.price_type == null && loser.price_type != null) await client.from('activities').update({ price_type: loser.price_type, price_amount: loser.price_amount }).eq('id', keeper.id).is('price_type', null);
    await client.from('cleaner_cases').update({ status: 'resolved', resolution: { outcome: 'subject_merged_into', keeper: keeper.id }, resolved_at: now, updated_at: now, claimed_by: null, claimed_at: null, lease_until: null }).eq('subject_kind', 'activity').eq('subject_id', loser.id).eq('status', 'open');
  }
  review.slice(0, 40).forEach((p) => console.log(`  [REVIEW] "${p.a.name}" / "${p.b.name}" | ${p.a.city} | ${Math.round(p.v.km * 1000)} m | names ${p.v.agreement}`));
  const file = path.join(__dirname, `place-duplicates-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, counts: { places: flat.length, pairs: pairs.length, high: high.length, merged: plan.length, review: review.length }, plan, review: review.map((p) => ({ a: p.a.name, b: p.b.name, city: p.a.city, m: Math.round(p.v.km * 1000), agreement: p.v.agreement })) }, null, 2));
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} merged ${plan.length} ->`, path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
