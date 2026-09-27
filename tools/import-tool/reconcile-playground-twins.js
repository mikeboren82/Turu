// TuRu Cleaner - OSM / Google playground TWIN reconciliation (pass 3, 2026-09-14). The retired
// settlement scanner imported Google playgrounds that Turu already held from OSM; the settlement
// pass recorded 59 such pairs (legacy existing_activity_id = OSM row, canonical match = Google row).
// Distance never decides. Per pair: exact place id, OSM feature identity (reverse at the Google
// point returns the leisure feature that IS the OSM row), normalized name/alias, street, house
// number, settlement, coordinates, provenance. Outcomes:
//   SAME_PLACE_HIGH | SAME_PLACE_MEDIUM_NEEDS_MORE_EVIDENCE | DISTINCT_PLACES | INSUFFICIENT_EVIDENCE
//
// KEEPER RULE (Google Places release policy, 2026-09-27 - replaces the 09-14 "keeper = the Google row"):
// decideTwinOutcome() picks by PROVENANCE (lib/googlePlacesPolicy.js isGoogleOriginActivity = content_origin marker or
// Maps source_url), never by which query found the row and never by google_place_id:
//   one independent + one Google-origin, SAME_PLACE_HIGH  -> MERGE, keeper = the INDEPENDENT row; the Google row is
//                                                            ARCHIVED (duplicate_of_existing_activity, never deleted)
//   two independent rows, or two Google-origin rows      -> REVIEW (recorded, never merged here)
//   anything below SAME_PLACE_HIGH                        -> NO-OP (recorded)
// An independent row is NEVER archived in favour of a Google row. When the loser is Google-origin nothing of it is
// copied onto the keeper: no region/address fill, no image (Places content). Provenance rows go through
// mergeActivitySources, which refuses Maps page_urls; the loser keeps its own location row and schedules.
// The report goes to reports/ (git-ignored: it names rows and their Google-derived labels).
//   node reconcile-playground-twins.js            dry run (report)
//   node reconcile-playground-twins.js --apply
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { haversineKm } = require('./cleaner/matching');
const { nominatim } = require('./cleaner/nominatimClient');
const { parseAddress, nameSim, existingStreet } = require('./cleaner/settlementResolver');
const { normalizeCityName } = require('./cityNaming');
const { archiveActivity, isArchived, describe } = require('./lib/activityArchive');
const { mergeActivitySources } = require('./lib/activitySourceMerge');
const { copyLoserImages, IMAGE_COPY_SELECT } = require('./lib/mergeImages');
const { isGoogleOriginActivity } = require('./lib/googlePlacesPolicy');

const APPLY = process.argv.includes('--apply');
const LEISURE = new Set(['playground', 'park', 'garden', 'recreation_ground']);

async function osmAt(lat, lng) {
  const r = await nominatim(`/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&namedetails=1`);
  if (!r) return null;
  return { category: r.category, type: r.type, name: r.name || null, road: r.address?.road || null, lat: Number(r.lat), lng: Number(r.lon), osm_id: r.osm_id, osm_type: r.osm_type };
}

// Pure. existingRow = the review case's existing_activity_id row, placeRow = the row found by the case's place id.
// -> { action: 'merge', keeper, loser, rule } | { action: 'review', reason } | { action: 'noop', reason }
function decideTwinOutcome({ existingRow, placeRow, verdict }) {
  if (!verdict || verdict.outcome !== 'SAME_PLACE_HIGH') return { action: 'noop', reason: verdict ? verdict.outcome : 'no_verdict' };
  const gExisting = isGoogleOriginActivity(existingRow);
  const gPlace = isGoogleOriginActivity(placeRow);
  if (gExisting !== gPlace) {
    return gExisting
      ? { action: 'merge', keeper: placeRow, loser: existingRow, rule: 'independent_keeper' }
      : { action: 'merge', keeper: existingRow, loser: placeRow, rule: 'independent_keeper' };
  }
  if (!gExisting) return { action: 'review', reason: 'two_independent_rows' };
  return { action: 'review', reason: 'two_google_origin_rows' };
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

async function mergePair(client, userId, rc, keeper, loser, verdict) {
  const now = new Date().toISOString();
  const loserIsGoogle = isGoogleOriginActivity(loser);
  // Provenance first (append/upsert), then (independent loser only) null-fills + images, then archive.
  // non-destructive: never downgrades an existing keeper row sharing a page_url with the loser; a Maps page_url is
  // refused by mergeActivitySources (2026-09-22, "Harden activity_sources Merge" - see lib/activitySourceMerge.js)
  const { counts: provCounts } = await mergeActivitySources(client, { keeperActivityId: keeper.id, loserActivityId: loser.id });
  const provMoved = provCounts.ADDED + provCounts.PRESERVED_EXISTING;
  // a Google-origin loser gives the independent keeper nothing: its images and its location facts are Places content
  const img = loserIsGoogle
    ? { inserted: 0, skipped: (loser.activity_images || []).length, error: null }
    : await copyLoserImages(client, { loserImages: loser.activity_images, keeperImages: keeper.activity_images, keeperId: keeper.id, uploadedBy: userId, max: 3 });
  if (img.error) console.log(`  image copy failed for keeper ${keeper.id}: ${img.error.message}`);
  const fills = {};
  if (!loserIsGoogle) {
    if (!keeper.locations.region && loser.locations.region) fills.region = loser.locations.region;
    if (!keeper.locations.address && loser.locations.address) Object.assign(fills, { address: loser.locations.address, address_source: 'cleaner:twin_merge', address_confidence: 'MEDIUM', address_resolved_at: now });
    if (Object.keys(fills).length) await client.from('locations').update(fills).eq('id', keeper.location_id);
  }
  const arch = await archiveActivity(client, { activityId: loser.id, expectedStatus: 'approved', archiveReason: 'duplicate_of_existing_activity', keeperActivityId: keeper.id });
  if (!isArchived(arch)) return { merged: false, why: describe(arch) };
  await client.from('settlement_scan_review_cases').update({ resolution: { ...(rc.resolution || {}), twin: { outcome: verdict.outcome, decisive: verdict.decisive, signals: verdict.signals, keeper: keeper.id, archived: loser.id, keeper_rule: 'independent_keeper', provenance_rows_copied: provMoved, images_copied: img.inserted, images_skipped: img.skipped, fills: Object.keys(fills), at: now, rule: 'reconcile-playground-twins v2' } }, updated_at: now }).eq('id', rc.id);
  return { merged: true, provMoved, imgs: img.inserted, imagesSkipped: img.skipped, fills: Object.keys(fills) };
}

async function main() {
  const { getClient } = require('./supabase');
  const { client, userId } = await getClient();
  const { data: cases } = await client.from('settlement_scan_review_cases').select('id, google_place_id, existing_activity_id, candidate_name, resolution').eq('status', 'approved_duplicate').eq('resolved_by', 'cleaner').not('existing_activity_id', 'is', null);
  const sel = `id, name, status, category, google_place_id, source_url, content_origin, location_id, name_source, locations(id, name, address, city, region, lat, lng, address_source), activity_images(${IMAGE_COPY_SELECT}), activity_sources(page_url, relation)`;
  const results = []; const tally = {}; let merged = 0;
  for (const rc of cases || []) {
    if (rc.resolution && rc.resolution.twin) { tally.already_reconciled = (tally.already_reconciled || 0) + 1; continue; }
    const { data: osmRow } = await client.from('activities').select(sel).eq('id', rc.existing_activity_id).maybeSingle();
    const { data: gRows } = await client.from('activities').select(sel).eq('google_place_id', rc.google_place_id).neq('id', rc.existing_activity_id).limit(1);
    const googleRow = (gRows || [])[0];
    if (!osmRow || !googleRow || osmRow.status !== 'approved' || googleRow.status !== 'approved' || !osmRow.locations || !googleRow.locations) { tally.skipped_not_a_live_pair = (tally.skipped_not_a_live_pair || 0) + 1; continue; }
    const v = await evaluatePair(client, rc, osmRow, googleRow);
    const d = decideTwinOutcome({ existingRow: osmRow, placeRow: googleRow, verdict: v });
    const key = d.action === 'merge' ? v.outcome : `${v.outcome}/${d.action}${d.reason && d.action === 'review' ? ':' + d.reason : ''}`;
    tally[key] = (tally[key] || 0) + 1;
    const rec = { review_case: rc.id, existing: { id: osmRow.id, google_origin: isGoogleOriginActivity(osmRow) }, place_row: { id: googleRow.id, google_origin: isGoogleOriginActivity(googleRow) }, decision: d.action === 'merge' ? { action: 'merge', keeper: d.keeper.id, loser: d.loser.id, rule: d.rule } : d, ...v };
    if (APPLY && d.action === 'merge') { rec.merge = await mergePair(client, userId, rc, d.keeper, d.loser, v); if (rec.merge.merged) merged++; }
    else if (APPLY) {
      // non-merge outcomes are recorded too (reasoning is provenance): REVIEW waits for a human, NO-OP stays separate
      await client.from('settlement_scan_review_cases').update({ resolution: { ...(rc.resolution || {}), twin: { outcome: v.outcome, decisive: v.decisive, signals: v.signals, existing_row: osmRow.id, place_row: googleRow.id, merged: false, decision: d.action, reason: d.reason, at: new Date().toISOString(), rule: 'reconcile-playground-twins v2' } }, updated_at: new Date().toISOString() }).eq('id', rc.id);
    }
    results.push(rec);
    console.log(`${key.padEnd(48)} ${osmRow.id.slice(0, 8)} | ${googleRow.id.slice(0, 8)} | ${v.decisive.slice(0, 70)}${rec.merge ? ' | merged' : ''}`);
  }
  const dir = path.join(__dirname, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `playground-twins-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), apply: APPLY, tally, merged, results }, null, 2));
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: pairs ${(cases || []).length}`, JSON.stringify(tally), 'merged', merged, '->', path.relative(__dirname, file));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { decideTwinOutcome, mergePair };
