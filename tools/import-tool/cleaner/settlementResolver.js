// TuRu Cleaner - SETTLEMENT REVIEW as a Cleaner work source (2026-09-14). The retired national
// settlement scanner left ~282 settlement_scan_review_cases in needs_review. Each becomes one Cleaner
// case (subject_kind='settlement_review', subject_id=review case id) and reaches ONE outcome:
//   DUPLICATE | NEW_VALID | INVALID | NEEDS_ENRICHMENT | TEMPORARY_RETRY | INSUFFICIENT_EVIDENCE | GENUINELY_HUMAN
// Identity rules (binding): distance is only a signal; place identity != activity identity; an exact
// Google Place ID is HIGH place identity; NULL existing_activity_id is re-matched against the CURRENT
// canonical DB; uncertain_type is classified from evidence, never forced to "playground".
// Evidence stages: S1 canonical Turu data (exact place id, neighbours by street/name/distance) ->
// S2 candidate/source data (formatted_address, place_kind, detection history) -> S3 stored place
// metadata (none beyond S2 locally - no Google key on this machine, recorded as external limit) ->
// S4 Nominatim reverse at the candidate/existing coordinates (OSM class/name corroboration) ->
// S5 approved place infrastructure (unavailable locally). NEW_VALID is promoted through the canonical
// path only: incoming_activities row (Places shape) -> handBackIncoming -> /api/incoming/:id/approve
// (google_place_id + fingerprint guards = final pre-insert dedup). All settlement writes are
// append-only decisions + status on the review case; nothing is deleted or merged.
const { normalizeCityName } = require('../cityNaming');
const { normalizeForMatch } = require('../eventFingerprint');
const { haversineKm } = require('./matching');
const { nominatim } = require('./nominatimClient');
const { splitFormattedAddress } = require('../incomingShape');
const { handBackIncoming } = require('./apply');

const PLAYGROUND_WORDS = ['playground', 'גן שעשועים', 'גני שעשועים', 'מתקני משחקים', 'משחקייה', 'גן משחקים', 'מגרש משחקים', 'שעשועים'];
const PARK_WORDS = ['park', 'פארק', 'גן ציבורי', 'גן לאומי', 'חורשה', 'טיילת'];
const KINDERGARTEN = /גן ילדים|גן חובה|גן טרום|גן פרטי|מעון|פעוטון|בית ספר|תיכון|ישיבה|מכללה/;
const NOT_PLACE = /חניה|חניון|תחנה|מרפאה|קופת חולים|בנק|סופר|מכולת|מסעדה|קפה|בית כנסת|מסגד|כנסייה|משרד|עירייה|מועצה מקומית|בית עלמין|קבר/;
// commercial / indoor attractions: a different entity than a public playground even on the same street
const ATTRACTION = /גרביטי|gravity|טרמפולינ|ג'ימבורי|ג׳ימבורי|משחקייה|לונה פארק|פארק מים|קארטינג|בריכה|חדר בריחה|בולינג|סקייטפארק|skate/i;
const STOP = new Set(['park', 'playground', 'פארק', 'גן', 'שעשועים', 'ציבורי', 'גני', 'משחקים', 'מגרש']);
const PLAYGROUND_CATS = new Set(['גן שעשועים', 'פארק שעשועים', 'פארק']);
const EXTERNAL_LIMIT = 'google_places_details_unavailable: no Places key on the Cleaner machine; stored place metadata = name/address/coords/kind only';

// word set for similarity: stop-words (park/playground/garden), the definite article, and the
// city's own tokens are dropped - "גן שעשועים – פארק נוה-רבין, אור יהודה" vs "פארק נוה-רבין" is 1.0
const article = (w) => (w.length >= 4 && w.startsWith('ה') ? w.slice(1) : w);
function nameWords(s, cityTokens = new Set()) { return new Set(normalizeForMatch(s).split(' ').map(article).filter((w) => w.length > 1 && !STOP.has(w) && !cityTokens.has(w))); }
function nameSim(a, b, city) {
  const ct = new Set(normalizeForMatch(city || '').split(' ').map(article).filter((w) => w.length > 1));
  const wa = nameWords(a, ct), wb = nameWords(b, ct); if (!wa.size || !wb.size) return 0; let c = 0; wa.forEach((w) => { if (wb.has(w)) c++; }); return c / Math.max(wa.size, wb.size);
}
const STREET_PREFIX = /^(רח'|רח׳|רחוב|שד'|שד׳|שדרות|דרך|פינת)\s+/;
// "רחוב 12, עיר" / "גן X, שדרות Y 658, עיר" / "אבני חושן 11-13, עיר" -> {street, houseNumber, city}
function parseAddress(address) {
  const parts = (address || '').replace(/\s*\|.*$/, '').split(',').map((p) => p.trim()).filter((p) => p && !/^\d{5,7}$/.test(p));
  if (!parts.length) return { street: null, houseNumber: null, city: null };
  if (parts.length === 1) return { street: null, houseNumber: null, city: normalizeCityName(parts[0]) };
  const city = normalizeCityName(parts[parts.length - 1]);
  const body = parts.slice(0, -1);
  const streetPart = body.find((p) => /\d/.test(p)) || body[body.length - 1];
  const m = streetPart.match(/^(.*?)\s+(\d+(?:\s*[-–]\s*\d+)?[א-תA-Za-z]?)$/u);
  let street = (m ? m[1] : streetPart).trim().replace(STREET_PREFIX, '').trim() || null;
  if (street && /^פינת$/.test(street)) street = null;
  return { street, houseNumber: m ? m[2].split(/[-–]/)[0].trim() : null, city };
}
const streetSim = (a, b) => nameSim((a || '').replace(STREET_PREFIX, ''), (b || '').replace(STREET_PREFIX, ''));
// OSM-imported playgrounds are named "גן שעשועים – <street>, <city>"; the street is the identity
function existingStreet(a) { const fromAddr = parseAddress(a.locations?.address).street; if (fromAddr) return fromAddr; const m = /–\s*(.+?),/.exec(a.name || ''); return m ? m[1].trim() : null; }
const isStreetDerivedName = (a) => /^גן שעשועים\s*–/.test(a.name || '');
function classifyKind(c) {
  const n = (c.name || '').toLowerCase();
  if (KINDERGARTEN.test(n) || NOT_PLACE.test(n)) return 'NOT_RELEVANT';
  if (ATTRACTION.test(c.name || '')) return 'ATTRACTION';
  const pg = PLAYGROUND_WORDS.some((w) => n.includes(w));
  const park = PARK_WORDS.some((w) => n.includes(w));
  if (pg) return park ? 'PARK_WITH_PLAYGROUND' : 'PLAYGROUND';
  if (c.place_kind === 'PLAYGROUND' || c.place_kind === 'PARK_WITH_PLAYGROUND') return c.place_kind;
  if (park || c.place_kind === 'PARK') return 'PARK';
  if (/^גן\s/.test(c.name || '')) return 'GARDEN'; // "גן X" - public garden or kindergarten, needs corroboration
  return c.place_kind || 'UNCERTAIN';
}

async function loadContext(client, rc) {
  const { data: cands } = await client.from('settlement_scan_candidates').select('*').eq('google_place_id', rc.google_place_id).order('created_at', { ascending: false }).limit(20);
  const cand = (cands || [])[0] || null;
  const settlements = [...new Set((cands || []).map((c) => c.settlement_name).filter(Boolean))];
  let existing = null;
  if (rc.existing_activity_id) { const { data } = await client.from('activities').select('id, name, category, status, google_place_id, location_id, locations(id, name, address, city, lat, lng, address_confidence)').eq('id', rc.existing_activity_id).maybeSingle(); existing = data; }
  let exact = null;
  const { data: ex } = await client.from('activities').select('id, name, category, status').eq('google_place_id', rc.google_place_id).limit(1);
  if (ex && ex.length) exact = ex[0];
  let neighbours = [];
  if (cand && cand.lat != null && cand.lon != null) {
    const d = 0.0045; // ~500 m
    const { data: near } = await client.from('locations').select('id, name, address, city, lat, lng, activities!inner(id, name, category, status, google_place_id)').gte('lat', Number(cand.lat) - d).lte('lat', Number(cand.lat) + d).gte('lng', Number(cand.lon) - d).lte('lng', Number(cand.lon) + d).eq('activities.status', 'approved');
    neighbours = (near || []).flatMap((l) => (l.activities || []).map((a) => ({ ...a, locations: l, distM: Math.round(haversineKm(Number(cand.lat), Number(cand.lon), Number(l.lat), Number(l.lng)) * 1000) }))).sort((a, b) => a.distM - b.distM);
  }
  return { cand, cands: cands || [], settlements, existing, exact, neighbours };
}

// S4: OSM corroboration at coordinates (what does OpenStreetMap call this spot?)
async function osmAt(lat, lng) {
  const r = await nominatim(`/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&namedetails=1`);
  if (!r) return null;
  return { category: r.category, type: r.type, name: r.name || r.namedetails?.name || null, road: r.address?.road || null, city: r.address?.city || r.address?.town || r.address?.village || null, display: r.display_name, lat: r.lat ? Number(r.lat) : null, lng: r.lon ? Number(r.lon) : null, distM: r.lat ? Math.round(haversineKm(lat, lng, Number(r.lat), Number(r.lon)) * 1000) : null };
}
const LEISURE = new Set(['playground', 'park', 'garden', 'recreation_ground', 'nature_reserve']);
const isLeisure = (o) => o && o.category === 'leisure' && LEISURE.has(o.type);
// Turu's playground base was imported from OSM: a candidate standing on an OSM leisure feature whose
// point is within ~25 m of an existing Turu record IS that record (feature identity, not distance)
const onSameFeature = (o, n) => isLeisure(o) && o.lat != null && haversineKm(o.lat, o.lng, Number(n.locations.lat), Number(n.locations.lng)) * 1000 <= 25;

// -> { outcome, confidence, signals[], match, category, missing[], next_action, evidence }
async function proposeOutcome(client, rc, ctx) {
  const x = await loadContext(client, rc);
  const c = x.cand;
  const signals = [];
  if (!c) return { outcome: 'INSUFFICIENT_EVIDENCE', confidence: 'LOW', signals: ['no candidate row for this place id'], missing: ['candidate data'], next_action: 'none', evidence: {} };
  const cAddr = parseAddress(c.formatted_address); const cCity = cAddr.city || normalizeCityName(c.settlement_name || null);
  const kind = classifyKind(c);
  signals.push(`kind=${kind}`, `detections=${x.cands.length}`, `settlements=${x.settlements.length}`);

  // ---- place identity: exact Google Place ID (HIGH) ----
  if (x.exact) return { outcome: 'DUPLICATE', confidence: 'HIGH', signals: [...signals, 'exact google_place_id match'], match: { id: x.exact.id, name: x.exact.name, category: x.exact.category }, decisive: 'google_place_id', evidence: { exact_place_id: rc.google_place_id }, next_action: 'record duplicate' };

  // ---- neighbours in the CURRENT canonical DB (also for NULL existing_activity_id) ----
  const scored = x.neighbours.map((n) => {
    const eStreet = existingStreet(n); const eCity = normalizeCityName(n.locations?.city || parseAddress(n.locations?.address).city || null);
    const st = cAddr.street && eStreet ? streetSim(cAddr.street, eStreet) : null;
    const nm = nameSim(c.name, n.name, [cCity, eCity].filter(Boolean).join(' '));
    // a regional council recorded as the "city" of a village playground is not a different city
    const council = /מועצה/.test(eCity || '') || /מועצה/.test(cCity || '');
    const sameCity = cCity && eCity && !council ? (cCity === eCity || cCity.includes(eCity) || eCity.includes(cCity)) : null;
    return { ...n, eStreet, eCity, st, nm, sameCity, pgLike: PLAYGROUND_CATS.has(n.category) };
  });
  const legacy = x.existing ? scored.find((n) => n.id === x.existing.id) : null;
  let dup = null; let medium = null;
  for (const n of scored) {
    if (n.sameCity === false && n.distM > 150) continue; // a different city only vetoes when the geography does not contradict it
    // an indoor / commercial attraction is never the public playground next to it (same street or not)
    if (kind === 'ATTRACTION' && n.pgLike) { if (!medium && n.distM <= 60) medium = { n, why: `${n.distM} m from a ${n.category}, but the candidate is a commercial attraction`, conflict: true }; continue; }
    // a generic OSM name ("גן שעשועים – <street>") shares only its street token with the candidate:
    // that is street evidence (<= 100 m), not name evidence (<= 300 m)
    const nameEvidence = n.nm >= 0.7 && !isStreetDerivedName(n);
    if (n.distM <= 100 && ((n.st != null && n.st >= 1) || n.nm >= 0.7)) { dup = { n, why: n.st >= 1 ? `same street "${n.eStreet}" + ${n.distM} m` : `name overlap ${n.nm.toFixed(2)} + ${n.distM} m` }; break; }
    if (n.distM <= 300 && nameEvidence) { dup = { n, why: `same name (${n.nm.toFixed(2)}) + ${n.distM} m` }; break; }
    if (medium || kind === 'NOT_RELEVANT') continue;
    if (n.distM <= 300 && n.nm >= 0.7) { medium = { n, why: `street-derived name matches ("${n.eStreet}") but ${n.distM} m apart` }; continue; }
    if (n.distM <= 150 && n.pgLike && n.st == null) medium = { n, why: `${n.distM} m, same entity type, no street evidence on ${cAddr.street ? 'the existing record' : 'the candidate'}` };
    else if (n.distM <= 250 && n.st != null && n.st >= 0.66) medium = { n, why: `same street "${n.eStreet}" (${n.st.toFixed(2)}) but ${n.distM} m apart` };
    else if (n.distM <= 60 && n.pgLike) medium = { n, why: `${n.distM} m from a ${n.category} with ${n.st != null && n.st === 0 ? 'a different street' : 'partial name overlap ' + n.nm.toFixed(2)}`, conflict: n.st === 0 };
  }
  const evidence = { candidate: { name: c.name, address: c.formatted_address, city: cCity, kind, lat: c.lat, lon: c.lon, detections: x.cands.length }, nearest: scored.slice(0, 3).map((n) => ({ id: n.id, name: n.name, category: n.category, distM: n.distM, street: n.eStreet, streetSim: n.st, nameSim: Number(n.nm.toFixed(2)), sameCity: n.sameCity })), legacy_case_type: rc.case_type, legacy_distance_m: rc.latest_distance_m, external_limit: EXTERNAL_LIMIT };
  if (dup) return { outcome: 'DUPLICATE', confidence: 'HIGH', signals: [...signals, dup.why], match: { id: dup.n.id, name: dup.n.name, category: dup.n.category, distM: dup.n.distM }, decisive: dup.why, evidence, next_action: 'record duplicate; fill place id / address on the canonical record' };

  // MEDIUM duplicate: escalate with OSM reverse at BOTH points (independent street / feature evidence)
  if (medium) {
    const n = medium.n;
    const [oc, oe] = ctx.dry && !ctx.allowNetwork ? [null, null] : [await osmAt(Number(c.lat), Number(c.lon)), await osmAt(Number(n.locations.lat), Number(n.locations.lng))];
    evidence.osm = { candidate: oc, existing: oe };
    if (oc && onSameFeature(oc, n) && n.distM <= 60) {
      return { outcome: 'DUPLICATE', confidence: 'HIGH', signals: [...signals, medium.why, `candidate stands on the OSM ${oc.type} feature that is the existing record (feature point ${Math.round(haversineKm(oc.lat, oc.lng, Number(n.locations.lat), Number(n.locations.lng)) * 1000)} m from it)`], match: { id: n.id, name: n.name, category: n.category, distM: n.distM }, decisive: `OSM ${oc.type} feature identity + ${n.distM} m`, evidence, next_action: 'record duplicate' };
    }
    if (oc && oe && oc.road && oe.road && streetSim(oc.road, oe.road) >= 1 && n.distM <= 120 && !medium.conflict) {
      return { outcome: 'DUPLICATE', confidence: 'HIGH', signals: [...signals, medium.why, `OSM reverse: both on "${oc.road}"`], match: { id: n.id, name: n.name, category: n.category, distM: n.distM }, decisive: `OSM street agreement "${oc.road}" + ${n.distM} m + same type`, evidence, next_action: 'record duplicate' };
    }
    if (isLeisure(oc) && oc.name && nameSim(oc.name, n.name, cCity) >= 0.7 && n.distM <= 150) {
      return { outcome: 'DUPLICATE', confidence: 'HIGH', signals: [...signals, medium.why, `OSM names the spot "${oc.name}" = existing`], match: { id: n.id, name: n.name, category: n.category, distM: n.distM }, decisive: 'OSM feature name equals the existing record', evidence, next_action: 'record duplicate' };
    }
    // not proven the same, not proven different
    evidence.medium_duplicate = { id: n.id, name: n.name, distM: n.distM, why: medium.why, conflict: !!medium.conflict };
  }

  // ---- no duplicate: what is it? ----
  if (kind === 'NOT_RELEVANT') return { outcome: 'INVALID', confidence: 'HIGH', signals: [...signals, 'name denotes a kindergarten / school / non-place'], reason: 'wrong_entity_type', evidence, next_action: 'resolve invalid' };
  if (c.lat == null || c.lon == null) return { outcome: 'INSUFFICIENT_EVIDENCE', confidence: 'LOW', signals: [...signals, 'no coordinates'], missing: ['coordinates'], evidence, next_action: 'none' };
  // a commercial attraction found by a playground scan: real, but hours/prices/relevance are unknown here
  if (kind === 'ATTRACTION') return { outcome: 'GENUINELY_HUMAN', confidence: 'MEDIUM', signals: [...signals, 'commercial / indoor attraction - not a playground; needs category, hours and price before publishing'], match: medium ? { id: medium.n.id, name: medium.n.name, distM: medium.n.distM } : null, evidence, next_action: 'human: add as attraction via /import or dismiss' };
  const category = kind === 'PARK' ? 'פארק' : 'גן שעשועים';
  // a same-type record within 60 m that no evidence could tie or separate: a person decides, never NEW_VALID
  const nearSameType = scored.find((n) => n.distM <= 60 && n.pgLike);
  if (medium || nearSameType) {
    const n = (medium || { n: nearSameType }).n;
    return { outcome: 'GENUINELY_HUMAN', confidence: 'MEDIUM', signals: [...signals, `${kind} ${n.distM} m from "${n.name}" - same place or a neighbouring one (${medium ? medium.why : 'no street/name/OSM evidence either way'})`], match: { id: n.id, name: n.name, distM: n.distM }, category, evidence, next_action: 'human: same place or neighbour?' };
  }
  if (kind === 'PLAYGROUND' || kind === 'PARK_WITH_PLAYGROUND') {
    return { outcome: 'NEW_VALID', confidence: 'HIGH', signals: [...signals, 'playground by name/type, coordinates, no canonical record within 60 m'], category, evidence, next_action: 'promote through the canonical approve path' };
  }
  // PARK / GARDEN / UNCERTAIN: corroborate the type with OSM at the coordinates
  const oc = evidence.osm?.candidate || (ctx.dry && !ctx.allowNetwork ? null : await osmAt(Number(c.lat), Number(c.lon)));
  evidence.osm = { ...(evidence.osm || {}), candidate: oc };
  const osmLeisure = isLeisure(oc) && (oc.distM == null || oc.distM <= 80);
  if (osmLeisure) {
    const cat = oc.type === 'playground' ? 'גן שעשועים' : 'פארק';
    return { outcome: 'NEW_VALID', confidence: 'HIGH', signals: [...signals, `OSM confirms leisure/${oc.type}${oc.name ? ' "' + oc.name + '"' : ''} at the coordinates, no canonical record within 60 m`], category: cat, evidence, next_action: 'promote through the canonical approve path' };
  }
  if (kind === 'GARDEN' && x.cands.length >= 3 && !medium) return { outcome: 'INSUFFICIENT_EVIDENCE', confidence: 'MEDIUM', signals: [...signals, '"גן X" seen repeatedly but OSM does not corroborate a public garden/playground'], missing: ['entity type corroboration'], category, evidence, next_action: 'external place details (unavailable) or human' };
  return { outcome: 'INSUFFICIENT_EVIDENCE', confidence: 'LOW', signals: [...signals, `kind ${kind} not corroborated by canonical data or OSM${medium ? '; ' + medium.why : ''}`], missing: ['entity type corroboration'], category, evidence, next_action: 'external place details (unavailable) or human' };
}

// ---- apply (writes) ----
async function recordDecision(client, rc, ctx, { status, decision, note, evidence }) {
  const now = new Date().toISOString();
  const { data, error } = await client.from('settlement_scan_review_cases').update({ status, reviewed_by: ctx.userId, resolved_at: now, resolution_note: note, resolved_by: 'cleaner', resolution: evidence, updated_at: now }).eq('id', rc.id).eq('status', 'needs_review').select('id');
  if (error) throw error;
  if (!data || !data.length) return false; // an admin decided meanwhile - their decision wins
  const { error: e2 } = await client.from('settlement_scan_review_decisions').insert({ review_case_id: rc.id, decided_by: ctx.userId, decision, previous_status: 'needs_review', new_status: status, note, resolver: 'cleaner', evidence });
  if (e2) throw e2;
  return true;
}

async function applyOutcome(client, rc, p, ctx) {
  const gain = [];
  const base = { outcome: p.outcome, confidence: p.confidence, decisive: p.decisive || null, signals: p.signals, match: p.match || null, category: p.category || null, evidence: p.evidence, cleaner_rule: 'settlementResolver v1 (2026-09-14)' };
  if (p.outcome === 'DUPLICATE') {
    const note = `THE CLEANER: כפילות (${p.confidence}) של ${p.match.name} - ${p.decisive}`;
    const ok = await recordDecision(client, rc, ctx, { status: 'approved_duplicate', decision: 'approved_duplicate', note, evidence: base });
    if (!ok) return { applied: false, why: 'decided by admin meanwhile' };
    // reusable canonical knowledge, fill-null only: the verified place id and a street address
    const { data: g } = await client.from('activities').update({ google_place_id: rc.google_place_id }).eq('id', p.match.id).is('google_place_id', null).select('id');
    if (g && g.length) gain.push('placeIdsAdded');
    const c = p.evidence.candidate;
    if (c && c.address && /\d/.test(c.address.split(',')[0] || '')) {
      const { data: a } = await client.from('activities').select('location_id').eq('id', p.match.id).maybeSingle();
      if (a?.location_id) { const { data: l } = await client.from('locations').update({ address: c.address.split(',')[0].trim(), address_source: 'cleaner:settlement_candidate', address_confidence: 'MEDIUM', address_resolved_at: new Date().toISOString() }).eq('id', a.location_id).is('address', null).select('id'); if (l && l.length) gain.push('streetAddressesAdded'); }
    }
    return { applied: true, gain };
  }
  if (p.outcome === 'INVALID') {
    const ok = await recordDecision(client, rc, ctx, { status: 'resolved_invalid', decision: 'resolved_invalid', note: `THE CLEANER: לא ישות TuRu (${p.reason}) - ${p.signals.slice(-1)[0]}`, evidence: { ...base, reason: p.reason } });
    return { applied: ok, why: ok ? null : 'decided by admin meanwhile' };
  }
  if (p.outcome === 'NEW_VALID') {
    // canonical path: incoming row (Places shape) -> matcher -> /approve (google_place_id + fingerprint guards)
    const c = p.evidence.candidate;
    const { street, city } = splitFormattedAddress(c.address);
    const ed = { name: c.name, formatted_address: c.address, lat: Number(c.lat), lon: Number(c.lon), google_place_id: rc.google_place_id, place_kind: c.kind, city: city || c.city, category: p.category, entity_type: 'מקום_קבוע', schedule_type: 'fixed_hours', price_type: 'free', price_amount: 0, indoor_outdoor: 'outdoor', booking_requirement: 'none', audience: 'family', settlement_review_case_id: rc.id, cleaner_settlement: { confidence: p.confidence, signals: p.signals } };
    const { data: srcRow } = await client.from('settlement_scan_candidates').select('source_url').eq('google_place_id', rc.google_place_id).not('source_url', 'is', null).limit(1).maybeSingle();
    const { data: inc, error } = await client.from('incoming_activities').insert({ page_url: srcRow?.source_url || 'https://www.google.com/maps', match_type: 'new', status: 'new', validation_issues: [], extracted_data: ed, raw_source_snapshot: 'THE CLEANER settlement_review ' + rc.id }).select('id, source_id, page_url, status, validation_issues, extracted_data').single();
    if (error) throw error;
    const hb = await handBackIncoming(client, inc, { ...ctx, trustedOverride: true });
    if (hb.outcome === 'published') {
      const ok = await recordDecision(client, rc, ctx, { status: 'approved_distinct', decision: 'approved_distinct', note: `THE CLEANER: ישות חדשה (${p.confidence}) פורסמה דרך מסלול האישור הרגיל - פעילות ${hb.activity_id}`, evidence: { ...base, created_activity_id: hb.activity_id, incoming_id: inc.id } });
      gain.push('incomingPromoted');
      return { applied: ok, activity_id: hb.activity_id, gain };
    }
    if (hb.outcome === 'duplicate_merged') {
      // the FINAL pre-insert check found it: convert to duplicate instead of inserting
      const ok = await recordDecision(client, rc, ctx, { status: 'approved_duplicate', decision: 'approved_duplicate', note: `THE CLEANER: בבדיקה הסופית לפני יצירה נמצאה פעילות קיימת ${hb.activity_id || ''} (${hb.via || 'matcher'})`, evidence: { ...base, outcome: 'DUPLICATE', converted_from: 'NEW_VALID', match: { id: hb.activity_id } } });
      return { applied: ok, converted: 'DUPLICATE', gain };
    }
    // possible_update / awaiting_policy / error: the incoming row stays in the normal queue - report, don't force
    return { applied: false, why: `hand-back outcome ${hb.outcome}${hb.error ? ': ' + hb.error : ''}`, incoming_id: inc.id };
  }
  return { applied: false, why: 'no write for ' + p.outcome };
}

module.exports = { proposeOutcome, applyOutcome, classifyKind, parseAddress, nameSim, existingStreet, EXTERNAL_LIMIT };
