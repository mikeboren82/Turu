// TuRu Cleaner - OSM / Google playground TWIN reconciliation (pass 3, 2026-09-14). The retired
// settlement scanner imported Google playgrounds that Turu already held from OSM; the settlement
// pass recorded 59 such pairs (legacy existing_activity_id = OSM row, canonical match = Google row).
// Distance never decides. Per pair: exact place id, OSM feature identity (reverse at the Google
// point returns the leisure feature that IS the OSM row), normalized name/alias, street, house
// number, settlement, coordinates, provenance. Outcomes:
//   SAME_PLACE_HIGH | SAME_PLACE_MEDIUM_NEEDS_MORE_EVIDENCE | DISTINCT_PLACES | INSUFFICIENT_EVIDENCE
// Only SAME_PLACE_HIGH merges (--apply): keeper = the Google row (place id, street address, photo);
// the OSM row is ARCHIVED (archive_reason duplicate_of_existing_activity, never deleted), its
// provenance rows are copied onto the keeper (relation 'seen'), images copied when the keeper lacks
// them, its incoming/settlement history re-pointed in the review case's resolution jsonb, and the
// keeper's null fields (region, address) filled from the loser. No dangling references: the loser
// keeps its own location row and schedules; only its status changes.
//   node reconcile-playground-twins.js            dry run (report)
//   node reconcile-playground-twins.js --apply
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { haversineKm } = require('./cleaner/matching');
const { nominatim } = require('./cleaner/nominatimClient');
const { parseAddress, nameSim, existingStreet } = require('./cleaner/settlementResolver');
const { normalizeCityName } = require('./cityNaming');

const APPLY = process.argv.includes('--apply');
const LEISURE = new Set(['playground', 'park', 'garden', 'recreation_ground']);

async function osmAt(lat, lng) {
  const r = await nominatim(`/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&namedetails=1`);
  if (!r) return null;
  return { category: r.category, type: r.type, name: r.name || null, road: r.address?.road || null, lat: Number(r.lat), lng: Number(r.lon), osm_id: r.osm_id, osm_type: r.osm_type };
}

async function evaluatePair(client, rc, osmRow, googleRow) {
  const lo = osmRow.locations, lg = googleRow.locations;
  const distM = Math.round(haversineKm(Number(lo.lat), Number(lo.lng), Number(lg.lat), Number(lg.lng)) * 1000);
  const gAddr = parseAddress(lg.address); const oStreet = existingStreet(osmRow); const oCity = normalizeCityName(lo.city || null); const gCity = gAddr.city || normalizeCityName(lg.city || null);
  const st = gAddr.street && oStreet ? nameSim(gAddr.street, oStreet) : null;
  const nm = nameSim(googleRow.name, osmRow.name, [oCity, gCity].filter(Boolean).join(' '));
  const sameCity = oCity && gCity ? (oCity === gCity || oCity.includes(gCity) || gCity.includes(oCity) || /מועצה/.test(oCity)) : null;
  const signals = [`${distM} m`, `street ${st == null ? 'n/a' : st.toFixed(2)} (${oStreet || '-'} vs ${gAddr.street || '-'})`, `name ${nm.toFixed(2)}`, `city ${sameCity}`];
  const ev = { distM, st, nm, sameCity, oStreet, gStreet: gAddr.street, gHouse: gAddr.houseNumber };
  if (osmRow.google_place_id && osmRow.google_place_id === googleRow.google_place_id) return { outcome: 'SAME_PLACE_HIGH', decisive: 'same google_place_id on both rows', signals, ev };
  if (sameCity === false && distM > 150) return { outcome: 'DISTINCT_PLACES', decisive: 'different settlement and > 150 m apart', signals, ev };
  if (distM > 250) return { outcome: 'DISTINCT_PLACES', decisive: `${distM} m apart - two playground locations`, signals, ev };
  if (distM <= 100 && st != null && st >= 1) return { outcome: 'SAME_PLACE_HIGH', decisive: `same street "${oStreet}" + ${distM} m`, signals, ev };
  if (distM <= 100 && nm >= 0.7) return { outcome: 'SAME_PLACE_HIGH', decisive: `same name (${nm.toFixed(2)}) + ${distM} m`, signals, ev };
  // OSM feature identity: the leisure feature under the Google point is the OSM record itself
  const og = await osmAt(Number(lg.lat), Number(lg.lng));
  ev.osm_at_google = og;
  if (og && og.category === 'leisure' && LEISURE.has(og.type) && haversineKm(og.lat, og.lng, Number(lo.lat), Number(lo.lng)) * 1000 <= 25) {
    return { outcome: 'SAME_PLACE_HIGH', decisive: `OSM ${og.type} feature under the Google point is the OSM record (feature point ${Math.round(haversineKm(og.lat, og.lng, Number(lo.lat), Number(lo.lng)) * 1000)} m from it)`, signals, ev };
  }
  const oo = await osmAt(Number(lo.lat), Number(lo.lng)); ev.osm_at_osm = oo;
  // a numbered highway ("38", "574") is not a street identity - letters required
  if (og && oo && og.road && oo.road && /[א-תa-z]/i.test(og.road) && nameSim(og.road, oo.road) >= 1 && distM <= 100) return { outcome: 'SAME_PLACE_HIGH', decisive: `OSM street agreement "${og.road}" + ${distM} m + same type`, signals, ev };
  if (st != null && st === 0 && distM > 60) return { outcome: 'DISTINCT_PLACES', decisive: `different streets (${oStreet} / ${gAddr.street}) and ${distM} m apart`, signals, ev };
  if (distM <= 100) return { outcome: 'SAME_PLACE_MEDIUM_NEEDS_MORE_EVIDENCE', decisive: `${distM} m, same type, no street/name/feature agreement`, signals, ev };
  return { outcome: 'INSUFFICIENT_EVIDENCE', decisive: `${distM} m apart, evidence neither ties nor separates`, signals, ev };
}

async function mergePair(client, userId, rc, osmRow, googleRow, verdict) {
  const now = new Date().toISOString();
  // keeper = Google row; loser = OSM row. Provenance first (append/upsert), then null-fills, then archive.
  const { data: prov } = await client.from('activity_sources').select('source_id, page_url, incoming_activity_id, relation, first_seen_at, last_seen_at').eq('activity_id', osmRow.id);
  let provMoved = 0;
  for (const p of prov || []) { const { error } = await client.from('activity_sources').upsert({ ...p, activity_id: googleRow.id, relation: 'seen', last_seen_at: p.last_seen_at || now }, { onConflict: 'activity_id,page_url' }); if (!error) provMoved++; }
  const keeperUrls = new Set((googleRow.activity_images || []).map((i) => i.url));
  const imgs = (osmRow.activity_images || []).filter((i) => !keeperUrls.has(i.url)).slice(0, 3).map((i) => ({ activity_id: googleRow.id, url: i.url, uploaded_by: userId, image_source_type: i.image_source_type || null, image_kind: i.image_kind || null }));
  if (imgs.length) await client.from('activity_images').insert(imgs);
  const fills = {};
  if (!googleRow.locations.region && osmRow.locations.region) fills.region = osmRow.locations.region;
  if (!googleRow.locations.address && osmRow.locations.address) Object.assign(fills, { address: osmRow.locations.address, address_source: 'cleaner:twin_merge', address_confidence: 'MEDIUM', address_resolved_at: now });
  if (Object.keys(fills).length) await client.from('locations').update(fills).eq('id', googleRow.location_id);
  const { data: a } = await client.from('activities').update({ status: 'archived', archive_reason: 'duplicate_of_existing_activity', archived_at: now }).eq('id', osmRow.id).eq('status', 'approved').select('id');
  if (!a || !a.length) return { merged: false, why: 'OSM row no longer approved' };
  await client.from('settlement_scan_review_cases').update({ resolution: { ...(rc.resolution || {}), twin: { outcome: verdict.outcome, decisive: verdict.decisive, signals: verdict.signals, keeper: googleRow.id, archived: osmRow.id, provenance_rows_copied: provMoved, images_copied: imgs.length, fills: Object.keys(fills), at: now, rule: 'reconcile-playground-twins v1' } }, updated_at: now }).eq('id', rc.id);
  return { merged: true, provMoved, imgs: imgs.length, fills: Object.keys(fills) };
}

(async () => {
  const { client, userId } = await getClient();
  const { data: cases } = await client.from('settlement_scan_review_cases').select('id, google_place_id, existing_activity_id, candidate_name, resolution').eq('status', 'approved_duplicate').eq('resolved_by', 'cleaner').not('existing_activity_id', 'is', null);
  const sel = 'id, name, status, category, google_place_id, location_id, name_source, locations(id, name, address, city, region, lat, lng, address_source), activity_images(url, image_source_type, image_kind), activity_sources(page_url, relation)';
  const results = []; const tally = {}; let merged = 0;
  for (const rc of cases || []) {
    if (rc.resolution && rc.resolution.twin) { tally.already_reconciled = (tally.already_reconciled || 0) + 1; continue; }
    const { data: osmRow } = await client.from('activities').select(sel).eq('id', rc.existing_activity_id).maybeSingle();
    const { data: gRows } = await client.from('activities').select(sel).eq('google_place_id', rc.google_place_id).neq('id', rc.existing_activity_id).limit(1);
    const googleRow = (gRows || [])[0];
    if (!osmRow || !googleRow || osmRow.status !== 'approved' || googleRow.status !== 'approved' || !osmRow.locations || !googleRow.locations) { tally.skipped_not_a_live_pair = (tally.skipped_not_a_live_pair || 0) + 1; continue; }
    const v = await evaluatePair(client, rc, osmRow, googleRow);
    tally[v.outcome] = (tally[v.outcome] || 0) + 1;
    const rec = { review_case: rc.id, osm: { id: osmRow.id, name: osmRow.name, address: osmRow.locations.address }, google: { id: googleRow.id, name: googleRow.name, address: googleRow.locations.address }, ...v };
    if (APPLY && v.outcome === 'SAME_PLACE_HIGH') { rec.merge = await mergePair(client, userId, rc, osmRow, googleRow, v); if (rec.merge.merged) merged++; }
    else if (APPLY) {
      // non-merge outcomes are recorded too (reasoning is provenance): MEDIUM waits for evidence, DISTINCT/INSUFFICIENT stay separate
      await client.from('settlement_scan_review_cases').update({ resolution: { ...(rc.resolution || {}), twin: { outcome: v.outcome, decisive: v.decisive, signals: v.signals, osm_row: osmRow.id, google_row: googleRow.id, merged: false, at: new Date().toISOString(), rule: 'reconcile-playground-twins v1' } }, updated_at: new Date().toISOString() }).eq('id', rc.id);
    }
    results.push(rec);
    console.log(`${v.outcome.padEnd(38)} ${osmRow.name.slice(0, 34).padEnd(34)} | ${googleRow.name.slice(0, 26).padEnd(26)} | ${v.decisive.slice(0, 70)}${rec.merge ? ' | merged' : ''}`);
  }
  const file = path.join(__dirname, `playground-twins-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), apply: APPLY, tally, merged, results }, null, 2));
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: pairs ${(cases || []).length}`, JSON.stringify(tally), 'merged', merged, '->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
