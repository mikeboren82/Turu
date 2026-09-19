// TuRu - build the SERVICE-AREA reference of Palestinian-administered localities (West Bank Areas A/B, Gaza Strip):
// one bounded, provenance-tracked Nominatim lookup per curated locality name (countrycodes=ps), written to
//   tools/import-tool/reference/pa-localities.json  and the Deno twin  supabase/functions/_shared/paLocalities.json
// This is GEOGRAPHIC evidence only. The list names PA-administered towns, cities and refugee camps; Israeli Arab
// localities (Umm al-Fahm, Nazareth, Rahat, Daliyat al-Karmel, Abu Ghosh...) are CBS settlements and are never here.
//   node build-pa-localities.js            (rewrites the reference files; ~1 request/s)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { nominatim } = require('./cleaner/nominatimClient');

// [display name, search query, kind, expect?] - kind sets the match radius: city 4 km, town 2.5 km, village/camp 1.5 km;
// expect = approximate [lat, lng] for names that exist in several districts (a result > 12 km away is rejected)
const EXPECT = { 'Al-Zawiya': [32.09, 35.03], 'Immatin': [32.19, 35.15], 'Birzeit': [31.97, 35.19], 'Marka': [32.39, 35.24], 'Khirbet al-Karmil': [31.42, 35.13], 'Zeita (Tulkarm)': [32.39, 35.05], 'Arraba': [32.40, 35.20], 'Aqqaba': [32.35, 35.35], 'Dura': [31.51, 35.03], 'Nuba': [31.61, 35.04], 'Bani Zeid': [32.03, 35.13], 'Deir Jarir': [31.96, 35.30], 'Sinjil': [32.02, 35.26] };
// well-known locality centres used only when Nominatim returns no place-class result (provenance recorded per row)
const CURATED = { 'Qalqilya': [32.1897, 34.9706], 'Halhul': [31.5803, 35.1011], 'Beit Hanoun': [31.5364, 34.5364], 'Birzeit': [31.9722, 35.1953], 'Sinjil': [32.0213, 35.2633], 'Bidya': [32.1197, 35.0622], 'Kafr Ra\'i': [32.3944, 35.1436], 'Zababdeh': [32.3856, 35.3239], 'Marka': [32.3947, 35.2364], 'Ein as-Sultan camp': [31.8720, 35.4420], 'Az-Zubeidat': [32.1281, 35.5050], 'Khirbet al-Karmil': [31.4214, 35.1289], 'Al-Arroub camp': [31.6233, 35.1417], 'Bani Suheila': [31.3417, 34.3567], 'Abasan al-Kabira': [31.3244, 34.3572], 'Juhor ad-Dik': [31.4653, 34.4297], 'Aqraba': [32.1256, 35.3436], 'Asira ash-Shamaliya': [32.2703, 35.2583], 'Sebastia': [32.2764, 35.1903], 'Qusra': [32.0925, 35.3247], 'Al-Zawiya': [32.0983, 35.0364] };
const ALT = { 'Birzeit': ['Bir Zeit', 'Birzeit Ramallah'], 'Khirbet al-Karmil': ['Al-Karmil Hebron', 'Karmil'], 'Marka': ['Marka Jenin', 'Markah'], 'Al-Zawiya': ['Az-Zawiya Salfit', 'Zawiya Salfit'], 'Immatin': ['Immatin Qalqilya', 'Imatin'], 'Bani Suheila': ['Bani Suhaila', 'Bani Suheila Khan Yunis'], 'Juhor ad-Dik': ['Juhr ad-Dik', 'Johr ad-Dik'] };
const LOCALITIES = [
  ['Ramallah', 'Ramallah', 'city'], ['Al-Bireh', 'Al-Bireh', 'city'], ['Nablus', 'Nablus', 'city'], ['Hebron', 'Hebron', 'city'], ['Bethlehem', 'Bethlehem', 'city'],
  ['Jenin', 'Jenin', 'city'], ['Tulkarm', 'Tulkarm', 'city'], ['Qalqilya', 'Qalqilya', 'city'], ['Jericho', 'Jericho', 'city'], ['Salfit', 'Salfit', 'town'], ['Tubas', 'Tubas', 'town'],
  ['Yatta', 'Yatta', 'city'], ['Dura', 'Dura Hebron', 'town'], ['Halhul', 'Halhul', 'town'], ['Bani Naim', 'Bani Na\'im', 'town'], ['Sair', 'Sa\'ir', 'town'], ['Beit Ummar', 'Beit Ummar', 'town'], ['Idhna', 'Idhna', 'town'], ['Tarqumiyah', 'Tarqumiyah', 'town'], ['Ad-Dhahiriya', 'Ad-Dhahiriya', 'town'], ['As-Samu', 'As-Samu', 'town'],
  ['Beit Jala', 'Beit Jala', 'town'], ['Beit Sahour', 'Beit Sahour', 'town'], ['Al-Khader', 'Al-Khader', 'village'], ['Husan', 'Husan', 'village'], ['Battir', 'Battir', 'village'], ['Al-Walaja', 'Al-Walaja', 'village'], ['Dheisheh camp', 'Dheisheh', 'camp'], ['Beit Fajjar', 'Beit Fajjar', 'town'],
  ['Birzeit', 'Birzeit', 'town'], ['Abu Dis', 'Abu Dis', 'town'], ['Al-Eizariya', 'Al-Eizariya', 'town'], ['Anata', 'Anata', 'town'], ['Qalandiya camp', 'Qalandiya camp', 'camp'], ['Jalazone camp', 'Jalazone', 'camp'], ['Deir Dibwan', 'Deir Dibwan', 'town'], ['Silwad', 'Silwad', 'town'], ['Turmus Ayya', 'Turmus Ayya', 'town'], ['Sinjil', 'Sinjil', 'town'], ['Beit Ur al-Tahta', 'Beit Ur al-Tahta', 'village'], ['Bani Zeid', 'Bani Zeid', 'town'], ['Deir Jarir', 'Deir Jarir', 'village'], ['Ni\'lin', 'Ni\'lin', 'town'], ['Bil\'in', 'Bil\'in', 'village'], ['Beitunia', 'Beitunia', 'town'],
  ['Balata camp', 'Balata camp', 'camp'], ['Askar camp', 'Askar camp Nablus', 'camp'], ['Huwara', 'Huwara', 'town'], ['Beit Furik', 'Beit Furik', 'town'], ['Aqraba', 'Aqraba', 'town'], ['Asira ash-Shamaliya', 'Asira ash-Shamaliya', 'town'], ['Sebastia', 'Sebastia', 'village'], ['Qusra', 'Qusra', 'village'], ['Jamma\'in', 'Jamma\'in', 'town'],
  ['Al-Zawiya', 'Az-Zawiya Salfit', 'town'], ['Marda', 'Marda', 'village'], ['Bidya', 'Bidya', 'town'], ['Kafr Thulth', 'Kafr Thulth', 'town'], ['Kafr Qaddum', 'Kafr Qaddum', 'town'], ['Azzun', 'Azzun', 'town'], ['Kafr Laqif', 'Kafr Laqif', 'village'], ['Al-Funduq', 'Al-Funduq', 'village'], ['Immatin', 'Immatin', 'village'], ['Jinsafut', 'Jinsafut', 'village'],
  ['Zeita (Tulkarm)', 'Zeita Tulkarm', 'town'], ['Attil', 'Attil', 'town'], ['Anabta', 'Anabta', 'town'], ['Bal\'a', 'Bal\'a', 'town'], ['Deir al-Ghusun', 'Deir al-Ghusun', 'town'], ['Shuweika', 'Shuweika', 'village'], ['Kafr al-Labad', 'Kafr al-Labad', 'village'], ['Bayt Lid', 'Beit Lid', 'town'], ['Qaffin', 'Qaffin', 'town'],
  ['Ya\'bad', 'Ya\'bad', 'town'], ['Qabatiya', 'Qabatiya', 'city'], ['Arraba', 'Arraba Jenin', 'town'], ['Silat al-Harithiya', 'Silat al-Harithiya', 'town'], ['Jenin camp', 'Jenin camp', 'camp'], ['Meithalun', 'Meithalun', 'town'], ['Kafr Ra\'i', 'Kafr Ra\'i', 'town'], ['Al-Yamun', 'Al-Yamun', 'town'], ['Zababdeh', 'Zababdeh', 'town'], ['Tammun', 'Tammun', 'town'], ['Aqqaba', 'Aqqaba Tubas', 'village'], ['Marka', 'Marka Jenin', 'village'],
  ['Aqabat Jabr camp', 'Aqabat Jabr', 'camp'], ['Ein as-Sultan camp', 'Ein as-Sultan', 'camp'], ['Al-Auja', 'Al-Auja Jericho', 'village'], ['Az-Zubeidat', 'Az-Zubeidat', 'village'], ['Fasayil', 'Fasayil', 'village'],
  ['Khirbet al-Karmil', 'Khirbet al-Karmil', 'village'], ['At-Tuwani', 'At-Tuwani', 'village'], ['Imneizil', 'Imneizil', 'village'], ['Beit Awwa', 'Beit Awwa', 'town'], ['Nuba', 'Nuba Hebron', 'village'], ['Surif', 'Surif', 'town'], ['Al-Arroub camp', 'Al-Arroub', 'camp'], ['Al-Fawwar camp', 'Al-Fawwar camp', 'camp'],
  ['Gaza City', 'Gaza City', 'city'], ['Jabalia', 'Jabalia', 'city'], ['Beit Lahia', 'Beit Lahia', 'city'], ['Beit Hanoun', 'Beit Hanoun', 'town'], ['Deir al-Balah', 'Deir al-Balah', 'city'], ['Khan Yunis', 'Khan Yunis', 'city'], ['Rafah', 'Rafah Gaza', 'city'], ['Nuseirat', 'Nuseirat', 'town'], ['Al-Bureij', 'Al-Bureij', 'town'], ['Al-Maghazi', 'Al-Maghazi', 'town'], ['Az-Zawayda', 'Az-Zawayda', 'town'], ['Bani Suheila', 'Bani Suheila', 'town'], ['Abasan al-Kabira', 'Abasan al-Kabira', 'town'], ['Al-Qarara', 'Al-Qarara', 'town'], ['Al-Mughraqa', 'Al-Mughraqa', 'village'], ['Juhor ad-Dik', 'Juhor ad-Dik', 'village'], ['Al-Musaddar', 'Al-Musaddar', 'village'],
];
const PLACE_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'locality', 'municipality', 'administrative', 'quarter', 'residential', 'camp', 'refugee_camp']);

// the public endpoint answers 429/403 for a while after a burst; the throttled client returns null on any non-OK
// answer, so a null is retried with a growing pause (never more than 3 attempts per query) and counted
let nullAnswers = 0;
async function searchWithRetry(query) {
  for (const pause of [0, 5000, 15000]) {
    if (pause) await new Promise((r) => setTimeout(r, pause));
    const res = await nominatim(`/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=ps&limit=8&addressdetails=1&accept-language=en`);
    if (Array.isArray(res)) return res;
    nullAnswers++;
  }
  return [];
}
// a rebuild never loses a locality that an earlier build placed: rows still not found keep the previous coordinates
const OUT_FILE = path.join(__dirname, 'reference', 'pa-localities.json');
const previous = (() => { try { const j = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); return new Map((j.localities || []).filter((r) => r.lat != null).map((r) => [r.name, r])); } catch { return new Map(); } })();

(async () => {
  const rows = [];
  for (const [name, q, kind] of LOCALITIES) {
    // only PLACE-class results (a city, town, village, camp boundary) are accepted - a road or a cemetery that carries the
    // name is not the locality; a second attempt drops the qualifier ("Gaza City" -> "Gaza"), then the name is skipped
    let best = null;
    const exp = EXPECT[name];
    const near = (x) => !exp || Math.abs(Number(x.lat) - exp[0]) + Math.abs(Number(x.lon) - exp[1]) < 0.12;
    for (const query of [q, ...(ALT[name] || []), name.replace(/\s*\(.*\)$/, '').replace(/ City$/, '').replace(/ camp$/i, '')]) {
      const res = await searchWithRetry(query);
      best = (res || []).find((x) => ['place', 'boundary'].includes(x.category || x.class) && PLACE_TYPES.has(x.type) && near(x)) || null;
      if (best) break;
    }
    if (!best && CURATED[name]) { const [lat, lng] = CURATED[name]; rows.push({ name, kind, lat, lng, osm_type: null, osm_id: null, place_type: 'curated', name_local: null, display: 'curated fallback coordinates (well-known locality centre; Nominatim returned no place-class result on ' + new Date().toISOString().slice(0, 10) + ')' }); console.log(`  ${name.padEnd(24)} ${kind.padEnd(8)} ${lat},${lng} curated fallback`); continue; }
    if (!best && previous.has(name)) { const r = previous.get(name); console.log(`  ${name.padEnd(24)} ${kind.padEnd(8)} ${r.lat},${r.lng} carried from previous build (lookup failed today)`); rows.push({ ...r, kind, carried_from_previous_build: true }); continue; }
    if (!best) { console.log('  NOT FOUND (no place-class result)', name); rows.push({ name, kind, lat: null, lng: null, osm_type: null, osm_id: null, display: null }); continue; }
    rows.push({ name, kind, lat: Number(best.lat), lng: Number(best.lon), osm_type: best.osm_type, osm_id: best.osm_id, place_type: `${best.category || best.class}/${best.type}`, name_local: best.namedetails?.name || best.display_name.split(',')[0], display: best.display_name.slice(0, 120) });
    console.log(`  ${name.padEnd(24)} ${kind.padEnd(8)} ${best.lat},${best.lon} ${best.category || best.class}/${best.type} | ${best.display_name.slice(0, 70)}`);
  }
  const out = { source: { provider: 'OpenStreetMap via Nominatim (search, countrycodes=ps)', license: 'ODbL', fetched: new Date().toISOString().slice(0, 10), rule: 'GEOGRAPHIC service-area reference: Palestinian-administered localities (West Bank Areas A/B, Gaza Strip). Never a language / ethnicity / name rule - Israeli Arab localities are CBS settlements and are always IN SCOPE.', radius_km: { city: 4, town: 2.5, village: 1.5, camp: 1.5 } }, localities: rows.filter((r) => r.lat != null) };
  const a = path.join(__dirname, 'reference', 'pa-localities.json'); const b = path.join(__dirname, '..', '..', 'supabase', 'functions', '_shared', 'paLocalities.json');
  fs.writeFileSync(a, JSON.stringify(out, null, 1)); fs.writeFileSync(b, JSON.stringify(out));
  console.log(`nominatim null answers (rate-limit / block) ${nullAnswers}`); console.log(`written ${out.localities.length} localities (${rows.length - out.localities.length} not found) ->`, a, 'and', b);
})().catch((e) => { console.error(e); process.exit(1); });
