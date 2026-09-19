// TuRu - reference data: public.settlements centroids against the AUTHORITATIVE CBS settlement file
// (הלמ"ס "קובץ היישובים" bycode 2024, column "קואורדינטות" = ITM/EPSG:2039 reference point, "centre of the
// built-up area"). Identity = the CBS settlement code (settlements.settlement_id), corroborated by the name
// (Hebrew normalized / English) - names are evidence, the code is identity; a disagreement is never written.
//   node audit-settlement-centroids-cbs.js [--apply] [--max=N] [--only=wrong|all] [--cbs=path.json]
// Classes: AUTHORITATIVE_MATCH_HIGH (code + name agree) -> sub-status by distance: CURRENT_COORD_ALREADY_VALID
// (<= 2 km) | CURRENT_COORD_OFF (2-5 km) | CURRENT_COORD_WRONG (> 5 km) | NO_CURRENT_COORD;
// IDENTITY_CONFLICT (code found, name disagrees); NO_AUTHORITATIVE_MATCH (code absent / no CBS coordinates);
// PSEUDO_AREA (CBS form 530 "אזור ..." rows are not settlements). Apply policy: only AUTHORITATIVE_MATCH_HIGH,
// value-guarded on the old coordinates, geocode_source 'cbs:bycode2024', report every old value.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { itmToWgs84, parseCbsCoordinates } = require('./lib/itm');
const { haversineKm, heKey } = require('./lib/canonicalSettlement');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const APPLY = !!args.apply; const MAX = Number(args.max || Infinity); const ONLY = String(args.only || 'all');
const CBS_FILE = args.cbs ? String(args.cbs) : path.join(__dirname, 'reference', 'cbs-settlements-2024.json');
const enKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

async function pageAll(client, table, select) { let from = 0, rows = []; while (true) { const { data, error } = await client.from(table).select(select).range(from, from + 999); if (error) throw error; rows = rows.concat(data || []); if (!data || data.length < 1000) return rows; from += 1000; } }

(async () => {
  const cbs = JSON.parse(fs.readFileSync(CBS_FILE, 'utf8'));
  const byCode = new Map(cbs.rows.map((r) => [Number(r.code), r]));
  const { client } = await getClient();
  const rows = await pageAll(client, 'settlements', 'settlement_id, name_he, name_en, council, region, lat, lng, geocode_source');
  const plan = []; const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  for (const s of rows) {
    const c = byCode.get(Number(s.settlement_id));
    const base = { settlement_id: s.settlement_id, name_he: s.name_he, council: s.council, old: s.lat != null ? { lat: s.lat, lng: s.lng, source: s.geocode_source } : null };
    if (!c) { plan.push({ ...base, klass: 'NO_AUTHORITATIVE_MATCH', why: 'code not in CBS 2024 file' }); bump('NO_AUTHORITATIVE_MATCH'); continue; }
    if (c.form === '530') { plan.push({ ...base, klass: 'PSEUDO_AREA', cbs_name: c.name_he }); bump('PSEUDO_AREA'); continue; }
    const coords = parseCbsCoordinates(c.coordinates);
    if (!coords) { plan.push({ ...base, klass: 'NO_AUTHORITATIVE_MATCH', why: 'CBS row has no coordinates', cbs_name: c.name_he }); bump('NO_AUTHORITATIVE_MATCH'); continue; }
    const nameOk = heKey(s.name_he) === heKey(c.name_he) || (enKey(s.name_en).length >= 3 && (enKey(s.name_en) === enKey(c.name_en) || enKey(s.name_en) === enKey(c.transliteration)));
    const w = itmToWgs84(coords.E, coords.N);
    // identity = code + a second independent signal: the name agrees, OR the current centroid already sits on the
    // CBS point (<= 1 km) - a CBS spelling variant ("הרצלייה") of a correctly placed settlement is not a conflict
    const coordCorroborates = s.lat != null && haversineKm(s.lat, s.lng, w.lat, w.lng) <= 1;
    if (!nameOk && !coordCorroborates) { plan.push({ ...base, klass: 'IDENTITY_CONFLICT', cbs_name: c.name_he, cbs_name_en: c.name_en, authoritative: w, delta_km: s.lat != null ? Math.round(haversineKm(s.lat, s.lng, w.lat, w.lng) * 10) / 10 : null }); bump('IDENTITY_CONFLICT'); continue; }
    if (!nameOk) bump('  identity_by_code+coordinates (name is a CBS spelling variant)');
    const delta = s.lat != null ? haversineKm(s.lat, s.lng, w.lat, w.lng) : null;
    const status = delta == null ? 'NO_CURRENT_COORD' : delta <= 2 ? 'CURRENT_COORD_ALREADY_VALID' : delta <= 5 ? 'CURRENT_COORD_OFF' : 'CURRENT_COORD_WRONG';
    plan.push({ ...base, klass: 'AUTHORITATIVE_MATCH_HIGH', status, cbs_name: c.name_he, cbs_municipal_status: c.municipal_status, cbs_authority: c.authority, authoritative: { ...w, itm: coords }, delta_km: delta == null ? null : Math.round(delta * 100) / 100 });
    bump('AUTHORITATIVE_MATCH_HIGH'); bump('  ' + status);
  }
  console.log(`settlements ${rows.length} | CBS rows ${cbs.rows.length}`); console.log(JSON.stringify(counts, null, 1));
  // known-place validation: the authoritative point of the big cities must sit where everyone knows they are
  const KNOWN = { 3000: [31.7784, 35.2222, 'ירושלים'], 5000: [32.0809, 34.7806, 'תל אביב'], 4000: [32.794, 34.9896, 'חיפה'], 9000: [31.253, 34.7915, 'באר שבע'], 2600: [29.5577, 34.9519, 'אילת'], 4100: [32.9925, 35.6899, 'קצרין'], 3570: [32.1039, 35.1868, 'אריאל'] };
  for (const [code, [lat, lng, name]] of Object.entries(KNOWN)) { const c = byCode.get(Number(code)); if (!c) continue; const p = parseCbsCoordinates(c.coordinates); if (!p) continue; const w = itmToWgs84(p.E, p.N); console.log(`  known ${name}: CBS -> ${w.lat},${w.lng} (${haversineKm(w.lat, w.lng, lat, lng).toFixed(2)} km from the known centre)`); }
  const writable = plan.filter((p) => p.klass === 'AUTHORITATIVE_MATCH_HIGH' && (ONLY === 'all' || p.status !== 'CURRENT_COORD_ALREADY_VALID'));
  const written = [];
  if (APPLY) {
    for (const p of writable.slice(0, MAX)) {
      let q = client.from('settlements').update({ lat: p.authoritative.lat, lng: p.authoritative.lng, geocode_source: 'cbs:bycode2024', updated_at: new Date().toISOString() }).eq('settlement_id', p.settlement_id);
      q = p.old ? q.eq('lat', p.old.lat).eq('lng', p.old.lng) : q.is('lat', null);
      const { data, error } = await q.select('settlement_id');
      if (error) { p.write = 'error: ' + error.message; continue; }
      p.write = data && data.length ? 'written' : 'skipped_value_changed_or_denied';
      if (p.write === 'written') written.push(p.settlement_id);
    }
  }
  const file = path.join(__dirname, `settlement-centroid-cbs-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, only: ONLY, max: MAX, source: cbs.source, counts, writable: writable.length, written: written.length, plan }, null, 2));
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} writable ${writable.length} written ${written.length} ->`, path.basename(file));
  for (const p of plan.filter((x) => x.status === 'CURRENT_COORD_WRONG').sort((a, b) => b.delta_km - a.delta_km).slice(0, 25)) console.log(`  WRONG ${p.name_he.padEnd(18)} ${String(p.delta_km).padStart(6)} km  old ${p.old.lat},${p.old.lng} -> cbs ${p.authoritative.lat},${p.authoritative.lng}${p.write ? ' ' + p.write : ''}`);
  for (const p of plan.filter((x) => x.klass === 'IDENTITY_CONFLICT').slice(0, 25)) console.log(`  CONFLICT ${p.settlement_id} db "${p.name_he}" vs cbs "${p.cbs_name}" (${p.cbs_name_en}) delta ${p.delta_km} km`);
})().catch((e) => { console.error(e); process.exit(1); });
