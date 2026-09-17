// TuRu - reference-data repair: WRONG CENTROIDS in public.settlements (found 2026-09-17).
// The centroids (0063, geocode_source 'nominatim') came from an unconstrained NAME search, so a settlement
// that shares its name with a street was placed on that street: "אריאל" / "אבן יהודה" on streets in
// Jerusalem, "אפרת" in Ramat Gan, "מודיעין עילית" 105 km away. The table feeds the canonical locality layer
// (lib/canonicalSettlement.js), region mapping and the APP's city-search origin (lib/activities.js
// fetchSettlementCoords) - a wrong centroid means wrong distances for every user searching that city.
//
// DETECT (no ground truth needed): settlements of one regional council are compact, and those of one CBS
// district office (לשכה) share an area. A centroid far from the MEDIAN of its council (> 25 km), or of its
// office when it has no council (> office-specific limit), is a suspect.
// REPAIR: re-geocode with Nominatim restricted to real PLACES (class place / boundary), take the candidate
// nearest to the group median, accept only inside the same limit. Anything else -> centroid set to NULL
// (an unknown origin is honest; a wrong one silently corrupts distances). Every old value is kept in the
// report file. Dry run by default:   node repair-settlement-centroids.js [--apply]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { nominatim } = require('./cleaner/nominatimClient');
const { haversineKm } = require('./lib/canonicalSettlement');

const APPLY = process.argv.includes('--apply');
// 2026-09-17 decision: the heuristic is NOT trusted for the whole plan - council medians are themselves
// contaminated where many members are wrong (הר חברון, שומרון), and a same-named neighbourhood can
// "confirm" a wrong centroid. Only the unambiguous subset is ever written:
//   old centroid > 40 km from its group  AND  a real city / town / village of that name <= 10 km from it.
// NOTHING is nulled. The rest is reported for a pass against authoritative CBS locality coordinates.
const HIGH_TYPES = new Set(['place/city', 'place/town', 'place/village']);
const isHigh = (p) => p.action === 'REPLACE' && p.old.km_from_group > 40 && p.new && HIGH_TYPES.has(p.new.type) && p.new.km_from_group <= 10;
const COUNCIL_LIMIT_KM = 25;
// district offices cover very different areas
const OFFICE_LIMIT_KM = { 'באר שבע': 90, 'אילת': 120, 'ירושלים': 45, 'אריאל': 45, 'עכו': 45, 'צפת': 50, 'טבריה': 45, 'עפולה': 45 };
const officeLimit = (o) => OFFICE_LIMIT_KM[o] || 35;
const PLACE_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'locality', 'isolated_dwelling', 'municipality', 'administrative', 'residential', 'quarter']);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function pageAll(client, table, select) { let from = 0, rows = []; while (true) { const { data, error } = await client.from(table).select(select).range(from, from + 999); if (error) throw error; rows = rows.concat(data || []); if (!data || data.length < 1000) return rows; from += 1000; } }

(async () => {
  const { client } = await getClient();
  const rows = await pageAll(client, 'settlements', 'settlement_id, name_he, name_en, council, region, lat, lng, geocode_source');
  const withC = rows.filter((r) => r.lat != null && r.lng != null);
  const groupMedian = (key) => { const m = new Map(); for (const r of withC) { const k = r[key]; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } const out = new Map(); for (const [k, rs] of m) if (rs.length >= 4) out.set(k, { lat: median(rs.map((r) => r.lat)), lng: median(rs.map((r) => r.lng)), n: rs.length }); return out; };
  const byCouncil = groupMedian('council'), byOffice = groupMedian('region');

  const suspects = [];
  for (const r of withC) {
    const c = r.council && byCouncil.get(r.council); const o = r.region && byOffice.get(r.region);
    let ref = null, limit = null, basis = null;
    if (c) { ref = c; limit = COUNCIL_LIMIT_KM; basis = 'council ' + r.council; } else if (o) { ref = o; limit = officeLimit(r.region); basis = 'office ' + r.region; }
    if (!ref) continue;
    const km = haversineKm(r.lat, r.lng, ref.lat, ref.lng);
    if (km > limit) suspects.push({ ...r, km: Math.round(km * 10) / 10, limit, basis, ref });
  }
  console.log(`settlements ${rows.length} | with centroid ${withC.length} | suspects ${suspects.length}`);

  const plan = [];
  for (const s of suspects) {
    const q = encodeURIComponent(s.name_he);
    const res = await nominatim(`/search?format=jsonv2&q=${q}&countrycodes=il,ps&limit=12&addressdetails=0`);
    const cands = (res || []).filter((x) => ['place', 'boundary'].includes(x.category || x.class) && PLACE_TYPES.has(x.type)).map((x) => ({ lat: Number(x.lat), lng: Number(x.lon), type: `${x.category || x.class}/${x.type}`, km_from_old: haversineKm(Number(x.lat), Number(x.lon), s.lat, s.lng), name: x.display_name, km: haversineKm(Number(x.lat), Number(x.lon), s.ref.lat, s.ref.lng) })).sort((a, b) => a.km - b.km);
    const best = cands[0];
    // an elongated council (חבל אילות, תמר, גולן) legitimately has members far from its median: when a real
    // PLACE of this name sits where the old centroid is, the centroid is right and nothing is touched
    const confirmsOld = cands.find((c) => c.km_from_old <= 3);
    const ok = best && best.km <= s.limit && !(confirmsOld && confirmsOld === best);
    if (confirmsOld && !(best && best.km <= s.limit && best !== confirmsOld)) { plan.push({ settlement_id: s.settlement_id, name_he: s.name_he, basis: s.basis, old: { lat: s.lat, lng: s.lng, km_from_group: s.km }, action: 'KEEP', new: null, why: 'a real place of this name is at the stored centroid (' + confirmsOld.type + ') - far from the group median but correct' }); console.log(`  ${s.name_he.padEnd(22)} ${String(s.km).padStart(6)} km off (${s.basis}) -> KEEP (confirmed ${confirmsOld.type})`); continue; }
    // NULL is reserved for a centroid that no real place confirms AND that is grossly off; a moderate
    // outlier nobody can confirm stays as it is and is reported (never destroy what cannot be disproved)
    const gross = s.km > Math.max(40, s.limit * 1.6);
    if (!ok && res != null && !gross) { plan.push({ settlement_id: s.settlement_id, name_he: s.name_he, basis: s.basis, old: { lat: s.lat, lng: s.lng, km_from_group: s.km }, action: 'KEEP_UNVERIFIED', new: null, why: 'moderate outlier, no place-class confirmation either way' }); console.log(`  ${s.name_he.padEnd(22)} ${String(s.km).padStart(6)} km off (${s.basis}) -> KEEP_UNVERIFIED`); continue; }
    plan.push({ settlement_id: s.settlement_id, name_he: s.name_he, basis: s.basis, old: { lat: s.lat, lng: s.lng, km_from_group: s.km }, action: ok ? 'REPLACE' : 'NULL', new: ok ? { lat: best.lat, lng: best.lng, type: best.type, km_from_group: Math.round(best.km * 10) / 10, display: best.name.slice(0, 90) } : null, why: ok ? null : (res == null ? 'geocoder unavailable' : cands.length ? `nearest real place is ${Math.round(cands[0].km)} km from its group (limit ${s.limit})` : 'no place-class result') });
    console.log(`  ${s.name_he.padEnd(22)} ${String(s.km).padStart(6)} km off (${s.basis}) -> ${ok ? 'REPLACE ' + best.type + ' @' + Math.round(best.km * 10) / 10 + ' km' : 'NULL: ' + plan[plan.length - 1].why}`);
  }
  // a geocoder outage must never null a centroid
  const safe = plan.filter(isHigh);
  if (APPLY) {
    for (const p of safe) {
      const patch = { lat: p.new.lat, lng: p.new.lng, geocode_source: 'nominatim:place_verified', updated_at: new Date().toISOString() };
      const { error } = await client.from('settlements').update(patch).eq('settlement_id', p.settlement_id).eq('lat', p.old.lat).eq('lng', p.old.lng);
      if (error) console.log('   write failed', p.name_he, error.message);
    }
  }
  const counts = { suspects: suspects.length, replace: plan.filter((p) => p.action === 'REPLACE').length, high_confidence_written: safe.length, proposed_null_NOT_written: plan.filter((p) => p.action === 'NULL').length, proposed_replace_below_bar: plan.filter((p) => p.action === 'REPLACE' && !isHigh(p)).length, keep_confirmed: plan.filter((p) => p.action === 'KEEP').length, keep_unverified: plan.filter((p) => p.action === 'KEEP_UNVERIFIED').length, skipped_geocoder_unavailable: plan.filter((p) => p.why === 'geocoder unavailable').length };
  const file = path.join(__dirname, `settlement-centroid-repair-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, counts, plan }, null, 2));
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}`, JSON.stringify(counts), '->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
