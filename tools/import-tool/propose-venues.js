// TuRu - source-aware venue learning (THE-CLEANER.md §23): location labels that recur across
// published activities in ONE city with verified coordinates that agree (<= 150 m) are a real
// place. Creating the venue + alias from that evidence lets the Cleaner resolve every later event
// at that place from stage 1, and links the existing activities. Conservative by design:
//   - >= 3 activities (or >= 2 from different sources), same normalized city, coords within 150 m
//   - label must not be generic (ספרייה / מתנ"ס / פארק / גן ... on their own) and must not already
//     resolve to a venue (alias) - ambiguity => listed, never created
//   - venue_type inferred from the label words; lat/lng = median; address = a linked location's
//   node propose-venues.js            (report only)
//   node propose-venues.js --apply    (create venues + aliases, link the activities/locations)
require('dotenv').config();
const { getClient } = require('./supabase');
const { normalizeCityName } = require('./cityNaming');
const { resolveVenue, normalizeVenueAlias } = require('./venueNaming');
const { haversineKm } = require('./cleaner/matching');

const APPLY = process.argv.includes('--apply');
const MIN_ACTS = 3;
const GENERIC = new Set(['ספרייה', 'הספרייה', 'ספריה', 'מתנס', 'מתנ"ס', 'המתנס', 'פארק', 'גן', 'גינה', 'הגינה', 'מרכז', 'המרכז', 'אולם', 'היכל', 'בית', 'חוף', 'הפארק', 'קניון', 'הקניון', 'כיכר', 'מגרש', 'אודיטוריום', 'מרכז קהילתי', 'מרכז מסחרי', 'בית ספר', 'גן ילדים', 'מקוון', 'zoom', 'online']);
const TYPE_RULES = [[/קניון|סנטר|מרכז מסחרי|מול\b/, 'mall'], [/ספרי/, 'library'], [/מתנ"?ס|מרכז קהילתי|מרכזים קהילתיים|קהילה/, 'community_center'], [/היכל|תיאטרון|אולם|אודיטוריום|מרכז הבמה/, 'theater'], [/מוזיאון|מוזאון|מדעטק|טכנודע/, 'museum'], [/פארק|גן |גינה|יער|חורש/, 'park'], [/חווה|פינת חי|משק/, 'farm'], [/מרכז תרבות|בית תרבות|תרבות/, 'cultural_center'], [/בריכה|קאנטרי|ספורט|מגרש/, 'sports_center'], [/כיכר|רחבה|טיילת|חוף/, 'public_square'], [/מרכז מבקרים/, 'visitor_center']];
const REGIONS = new Set(['הצפון והעמק', 'חיפה והקריות', 'השרון', 'גוש דן והמרכז', 'ירושלים והסביבה', 'השפלה והדרום', 'יו"ש והבנימין']);

async function all(client, table, select, fn) { let from = 0, rows = []; while (true) { let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q); const { data, error } = await q; if (error) throw error; rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000; } }
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

(async () => {
  const { client, userId } = await getClient();
  const acts = await all(client, 'activities', 'id, name, source_id, venue_id, location_id, locations!inner(id, name, city, region, address, lat, lng)', (q) => q.eq('status', 'approved').neq('category', 'גן שעשועים').is('venue_id', null).not('locations.lat', 'is', null));
  const groups = {};
  for (const a of acts) {
    const label = (a.locations.name || '').trim(); const city = normalizeCityName(a.locations.city || null);
    if (!label || !city) continue;
    const norm = normalizeVenueAlias(label); if (!norm || GENERIC.has(norm) || GENERIC.has(label) || norm.length < 3 || /שכונ|ברחבי|רחבי העיר|מקוון|אונליין|zoom|יקבע|יפורסם|לפי בחירה/.test(label)) continue;
    (groups[`${norm}|${city}`] ||= { label, norm, city, acts: [] }).acts.push(a);
  }
  const proposals = [], skipped = [];
  for (const g of Object.values(groups)) {
    const sources = new Set(g.acts.map((a) => a.source_id).filter(Boolean));
    if (g.acts.length < MIN_ACTS && !(g.acts.length >= 2 && sources.size >= 2)) continue;
    const lats = g.acts.map((a) => Number(a.locations.lat)), lngs = g.acts.map((a) => Number(a.locations.lng));
    const lat = median(lats), lng = median(lngs);
    const spread = Math.max(...g.acts.map((a) => haversineKm(lat, lng, Number(a.locations.lat), Number(a.locations.lng))));
    if (spread > 0.15) { skipped.push({ label: g.label, city: g.city, n: g.acts.length, why: `coords disagree (${Math.round(spread * 1000)} m)` }); continue; }
    const existing = await resolveVenue(client, { locationName: g.label, city: g.city });
    if (existing) { skipped.push({ label: g.label, city: g.city, n: g.acts.length, why: 'already resolves to ' + existing.name_he }); continue; }
    // same alias known under another city (e.g. 'עזריאלי אילון' vs a mis-extracted city) - never create a twin
    const anywhere = await resolveVenue(client, { locationName: g.label, city: null });
    if (anywhere) { skipped.push({ label: g.label, city: g.city, n: g.acts.length, why: 'alias exists as ' + anywhere.name_he + ' [' + anywhere.city + '] - city mismatch, human check' }); continue; }
    const type = (TYPE_RULES.find(([re]) => re.test(g.label)) || [null, 'other'])[1];
    const region = g.acts.map((a) => a.locations.region).find((r) => REGIONS.has(r)) || null;
    const address = g.acts.map((a) => a.locations.address).find(Boolean) || null;
    proposals.push({ label: g.label, city: g.city, region, type, lat, lng, address, n: g.acts.length, sources: sources.size, acts: g.acts });
  }
  proposals.sort((a, b) => b.n - a.n);
  console.log(`${APPLY ? 'APPLY' : 'REPORT'}: ${acts.length} venue-less activities, ${Object.keys(groups).length} labels, ${proposals.length} proposals, ${skipped.length} skipped`);
  proposals.forEach((p) => console.log(`  + ${p.label} [${p.city}] ${p.type} n=${p.n} src=${p.sources} ${p.address ? '@' + p.address : ''}`));
  skipped.slice(0, 15).forEach((s) => console.log(`  - ${s.label} [${s.city}] n=${s.n}: ${s.why}`));
  if (!APPLY) return;
  let created = 0, linked = 0;
  for (const p of proposals) {
    const { data: v, error } = await client.from('venues').insert({ name_he: p.label, venue_type: p.type, city: p.city, region: p.region, address: p.address, lat: p.lat, lng: p.lng, is_active: true, notes: `learned from ${p.n} published activities (${p.sources} sources) - propose-venues.js`, created_by: userId }).select('id').single();
    if (error) { console.log('  venue insert failed', p.label, error.message); continue; }
    created++;
    await client.from('venue_aliases').upsert([{ alias: p.label, alias_normalized: normalizeVenueAlias(p.label), venue_id: v.id }], { onConflict: 'alias_normalized,venue_id' });
    const ids = p.acts.map((a) => a.id), locIds = p.acts.map((a) => a.location_id).filter(Boolean);
    await client.from('activities').update({ venue_id: v.id }).in('id', ids);
    if (locIds.length) await client.from('locations').update({ venue_id: v.id }).in('id', locIds);
    linked += ids.length;
  }
  console.log(`created ${created} venues, linked ${linked} activities`);
})().catch((e) => { console.error(e); process.exit(1); });
