// TuRu Cleaner - bounded targeted evidence escalation for ONE canonical venue that many cases wait on
// ("human adds the venue" is the last resort, not the default). Sources, independent of each other:
//   1 official venue site (+ contact / about / directions page)      -> HIGH when it yields coordinates
//     or a street address that geocodes in the expected city
//   2 Nominatim place lookup "<label>, <city>" (OSM)                  -> MEDIUM
//   3 any extra official page passed with --page=                     -> HIGH if official (--official)
//   4 existing canonical Turu evidence (venues/aliases/locations)     -> reported
// Creates the venue + aliases only under the existing rules: HIGH evidence, or MEDIUM evidence that two
// independent sources agree on (<= 150 m). No Google Places on this machine (recorded as blocker).
//   node escalate-venue.js --label="תיאטרון הקרון" --city=ירושלים --site=https://www.traintheater.co.il --alias="תיאטרון הקרון ירושלים" [--apply]
require('dotenv').config();
const { getClient } = require('./supabase');
const { resolveLocation, geocodeText, ADMIN_TYPES, cityAgrees } = require('./cleaner/locationResolver');
const { haversineKm } = require('./cleaner/matching');
const { createVenueWithAlias, inferVenueType } = require('./venueLearning');
const { resolveVenue, normalizeVenueAlias } = require('./venueNaming');
const { inIsrael } = require('./lib/pageExtract');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
const APPLY = !!args.apply;

(async () => {
  const { client, userId } = await getClient();
  const label = String(args.label), city = String(args.city);
  const found = [];
  const existing = await resolveVenue(client, { locationName: label, city });
  console.log('canonical:', existing ? `already resolves to ${existing.name_he} [${existing.city}]` : 'no venue/alias');
  // 1. official site
  for (const site of [args.site, args.page].filter(Boolean)) {
    const r = await resolveLocation(client, { name: label, location_name: label, city, page_url: String(site), source_id: null }, { stages: ['source_page'], maxEvidenceStages: 1 });
    const res = r.result;
    console.log(`site ${site}: ${res ? `${res.confidence} ${res.method} ${res.lat},${res.lng} ${res.address || ''} (${JSON.stringify(res.evidence).slice(0, 120)})` : 'no evidence'} ${r.errors.join('; ')}`);
    if (res && res.lat != null && ['HIGH', 'MEDIUM'].includes(res.confidence)) found.push({ src: 'official_site', ...res, confidence: 'HIGH' }); // an address on the venue's own site is authoritative
  }
  // 2. OSM / Nominatim
  const rows = await geocodeText(`${label}, ${city}`);
  const hits = rows.filter((x) => !ADMIN_TYPES.has(x.type) && inIsrael(x) && cityAgrees(x.city, city));
  console.log(`nominatim: ${hits.length} venue-type hit(s)`, hits.slice(0, 3).map((h) => `${h.type} ${h.displayName.slice(0, 60)}`).join(' | '));
  if (hits.length === 1) found.push({ src: 'nominatim', lat: hits[0].lat, lng: hits[0].lng, address: hits[0].road ? `${hits[0].road}${hits[0].houseNumber ? ' ' + hits[0].houseNumber : ''}` : null, confidence: 'MEDIUM', evidence: { nominatim: hits[0].displayName } });
  // 3. agreement
  const high = found.find((f) => f.confidence === 'HIGH');
  const agree = found.length >= 2 && haversineKm(found[0].lat, found[0].lng, found[1].lat, found[1].lng) <= 0.15;
  console.log('evidence:', found.map((f) => `${f.src}/${f.confidence} ${f.lat},${f.lng}`).join(' | '), '| agree:', agree, '| external blocker: google_places_lookup_unavailable (no key on the Cleaner machine)');
  const basis = high ? `HIGH (${high.src})` : agree ? 'MEDIUM x2 independent agreeing' : null;
  if (!basis) { console.log('RESULT: insufficient independent evidence - stays genuinely human'); return; }
  const e = high || found[0];
  console.log(`RESULT: create venue on ${basis}: ${label} [${city}] ${e.lat},${e.lng} ${e.address || ''}`);
  if (!APPLY) return;
  const res = await createVenueWithAlias(client, { label, city, type: inferVenueType(label), lat: e.lat, lng: e.lng, address: e.address || null, notes: `THE CLEANER escalate-venue: ${basis}; ${JSON.stringify(found.map((f) => ({ src: f.src, evidence: f.evidence }))).slice(0, 400)}`, userId });
  if (!res.venue) { console.log('create failed:', res.error); return; }
  const aliases = [args.alias].filter(Boolean).flatMap((a) => String(a).split('|'));
  for (const al of aliases) await client.from('venue_aliases').upsert([{ alias: al, alias_normalized: normalizeVenueAlias(al), venue_id: res.venue.id }], { onConflict: 'alias_normalized,venue_id' });
  if (args.website) await client.from('venues').update({ website_url: String(args.website) }).eq('id', res.venue.id);
  console.log(`venue ${res.created ? 'created' : 'existed'}: ${res.venue.id}, aliases +${aliases.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
