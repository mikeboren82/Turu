// TuRu Cleaner - VENUE CLUSTERS (brief §10-11): many open cases often share one unresolved place.
// Resolve the canonical venue ONCE (enrich an existing venue, or create one from evidence), then let
// every member case go through its normal per-case path (stage `existing` now hits) - never a mass
// publish or mass overwrite. Compounding: the venue knowledge serves every future event there.
//
// Venue creation is conservative (user rule 2026-09-14):
//   HIGH evidence (JSON-LD event/place geo, official site, map link with coordinates) creates;
//   MEDIUM evidence (place lookup) needs >= 3 INDEPENDENT confirmations that agree (<= 150 m, same
//   city). Independent = different sources AND different pages; rows from one source/page/parser count
//   once. Cluster size is not evidence. createVenueWithAlias re-resolves the alias right before insert.
const { normalizeCityName } = require('../cityNaming');
const { resolveVenue, normalizeVenueAlias } = require('../venueNaming');
const { isLearnableLabel, createVenueWithAlias, inferVenueType } = require('../venueLearning');
const { resolveLocation, coordsForVenue, cityAgrees } = require('./locationResolver');
const { haversineKm } = require('./matching');
const { all } = require('./discover');

const CLUSTER_ISSUES = ['missing_location', 'incomplete_address', 'missing_venue', 'unverified_location', 'missing_coordinates'];
const MEDIUM_INDEPENDENT_MIN = 3;

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }

// members: [{ case, subject: {name, location_name, city, organizer_name, page_url, source_id, kind, venue_id} }]
async function loadMembers(client) {
  const cases = await all(client, 'cleaner_cases', 'id, subject_kind, subject_id, issue, attempts, source_id, methods_tried', (q) => q.eq('status', 'open').in('issue', CLUSTER_ISSUES).is('lease_until', null));
  const incIds = cases.filter((c) => c.subject_kind === 'incoming').map((c) => c.subject_id);
  const actIds = cases.filter((c) => c.subject_kind === 'activity').map((c) => c.subject_id);
  const inc = new Map(); const act = new Map();
  for (let i = 0; i < incIds.length; i += 150) {
    const { data } = await client.from('incoming_activities').select('id, page_url, source_id, name:extracted_data->>name, location_name:extracted_data->>location_name, city:extracted_data->>city, organizer_name:extracted_data->>organizer_name').in('id', incIds.slice(i, i + 150));
    for (const r of data || []) inc.set(r.id, r);
  }
  for (let i = 0; i < actIds.length; i += 150) {
    const { data } = await client.from('activities').select('id, name, venue_id, source_id, source_url, organizer_name, locations(name, city, address, lat, lng, address_confidence)').in('id', actIds.slice(i, i + 150));
    for (const r of data || []) act.set(r.id, r);
  }
  const members = [];
  for (const c of cases) {
    if (c.subject_kind === 'incoming') { const r = inc.get(c.subject_id); if (!r) continue; members.push({ case: c, subject: { kind: 'incoming', name: r.name, location_name: r.location_name, city: r.city, organizer_name: r.organizer_name, page_url: r.page_url, source_id: r.source_id, venue_id: null } }); }
    else { const r = act.get(c.subject_id); if (!r) continue; members.push({ case: c, subject: { kind: 'activity', name: r.name, location_name: r.locations?.name || null, city: r.locations?.city || null, organizer_name: r.organizer_name, page_url: r.source_url, source_id: r.source_id, venue_id: r.venue_id || null, lat: r.locations?.lat ?? null, lng: r.locations?.lng ?? null, address: r.locations?.address || null } }); }
  }
  return members;
}

// group by normalized label (+city when known); a member without a label groups by organizer
function groupMembers(members, minSize) {
  const groups = new Map();
  for (const m of members) {
    const label = m.subject.location_name || m.subject.organizer_name;
    if (!label || !isLearnableLabel(label)) continue;
    const key = `${normalizeVenueAlias(label)}|${normalizeCityName(m.subject.city || null) || ''}`;
    (groups.get(key) || groups.set(key, { key, label, city: normalizeCityName(m.subject.city || null), members: [] }).get(key)).members.push(m);
  }
  // merge city-less groups into the same-label city group when exactly one exists
  for (const [key, g] of [...groups]) {
    if (g.city) continue;
    const norm = key.split('|')[0];
    const withCity = [...groups.values()].filter((x) => x.city && x.key.startsWith(norm + '|'));
    if (withCity.length === 1) { withCity[0].members.push(...g.members); groups.delete(key); }
  }
  return [...groups.values()].filter((g) => g.members.length >= minSize).sort((a, b) => b.members.length - a.members.length);
}

// independent evidence = distinct (source_id, page host) pairs whose resolved coordinates agree
function independentAgreeing(evidences) {
  const out = [];
  for (const e of evidences) {
    if (e.lat == null) continue;
    if (out.some((o) => o.source_id === e.source_id || (o.host && o.host === e.host))) continue;
    if (out.length && haversineKm(out[0].lat, out[0].lng, e.lat, e.lng) > 0.15) continue;
    if (out.length && e.city && out[0].city && !cityAgrees(e.city, out[0].city)) continue;
    out.push(e);
  }
  return out;
}

// -> { clusters: [{key,label,city,size,outcome,venue,why}], stats }
async function resolveVenueClusters(client, ctx, { minSize = 3, maxClusters = 25, dry = false } = {}) {
  const { counters, userId } = ctx;
  const members = await loadMembers(client);
  const groups = groupMembers(members, minSize).slice(0, maxClusters);
  const clusters = [];
  const stats = { members: members.length, groups: groups.length, existingEnriched: 0, created: 0, unresolved: 0 };
  ctx.clusterByCase = ctx.clusterByCase || new Map();
  for (const g of groups) {
    const cl = { key: g.key, label: g.label, city: g.city, size: g.members.length, cases: g.members.map((m) => m.case.id) };
    // 1. existing venue?
    let venue = await resolveVenue(client, { locationName: g.label, city: g.city });
    if (!venue && !g.city) venue = await resolveVenue(client, { locationName: g.label, city: null });
    if (venue) {
      const { data: full } = await client.from('venues').select('id, name_he, city, address, lat, lng, website_url, events_url').eq('id', venue.id).maybeSingle();
      const before = { addr: !!full?.address, coords: full?.lat != null };
      const co = dry ? null : await coordsForVenue(client, full || venue, g.city, counters.gain || counters);
      cl.outcome = 'existing_venue'; cl.venue = { id: venue.id, name: venue.name_he, had_address: before.addr, had_coords: before.coords, now: co ? co.how : 'unchanged' };
      if (co && (!before.coords || (!before.addr && co.address))) stats.existingEnriched++;
    } else if (!g.members.some((m) => (m.case.attempts || 0) === 0)) {
      // every member already went through its own evidence stages (same pages, same lookups) - investigating
      // the cluster again each cycle gains nothing; it is re-evaluated when a fresh member or reopen arrives
      cl.outcome = 'skipped'; cl.why = 'all members already attempted - waiting for new members/evidence';
      clusters.push(cl); continue;
    } else {
      // 2. gather evidence from up to 4 members of DIFFERENT sources/pages (full stage list, no `existing`)
      const seen = new Set(); const reps = [];
      for (const m of g.members) { const k = `${m.subject.source_id}|${hostOf(m.subject.page_url)}`; if (seen.has(k)) continue; seen.add(k); reps.push(m); if (reps.length >= 4) break; }
      const evidences = [];
      for (const m of reps) {
        if (dry) break;
        const r = await resolveLocation(client, m.subject, { stages: ['source_page', 'detail_page', 'place_lookup', 'place_lookup_inferred'], maxEvidenceStages: 3, cache: ctx.cache, counters: counters.gain || counters });
        if (r.result && r.result.lat != null) evidences.push({ ...r.result, source_id: m.subject.source_id, host: hostOf(m.subject.page_url), tried: r.tried });
        // activity members with verified (non-LOW) coordinates are Turu evidence in their own right
        if (m.subject.kind === 'activity' && m.subject.lat != null) evidences.push({ lat: m.subject.lat, lng: m.subject.lng, city: m.subject.city, address: m.subject.address, confidence: 'MEDIUM', method: 'turu_verified_location', source_id: m.subject.source_id, host: 'turu:' + m.subject.source_id });
      }
      const high = evidences.find((e) => e.confidence === 'HIGH');
      const agreeing = independentAgreeing(evidences.filter((e) => ['HIGH', 'MEDIUM'].includes(e.confidence)));
      const city = g.city || high?.city || agreeing[0]?.city || null;
      let decision = null;
      if (high && (!city || !high.city || cityAgrees(high.city, city))) decision = { basis: 'HIGH', e: high };
      else if (agreeing.length >= MEDIUM_INDEPENDENT_MIN) decision = { basis: `MEDIUM x${agreeing.length} independent`, e: agreeing[0] };
      if (decision && !dry) {
        const e = decision.e;
        const res = await createVenueWithAlias(client, { label: g.label, city: city || e.city, region: null, type: inferVenueType(g.label), lat: e.lat, lng: e.lng, address: e.address || null, notes: `THE CLEANER cluster: ${g.members.length} cases, basis ${decision.basis}, method ${e.method}${e.evidence?.page ? ', page ' + e.evidence.page : ''}`, userId });
        if (res.venue) { cl.outcome = res.created ? 'venue_created' : 'existing_venue'; cl.venue = { id: res.venue.id, name: res.venue.name_he, basis: decision.basis, method: e.method, evidence: e.evidence }; if (res.created) { stats.created++; const g2 = counters.gain || counters; g2.venuesCreated = (g2.venuesCreated || 0) + 1; } }
        else { cl.outcome = 'unresolved'; cl.why = res.error; stats.unresolved++; }
      } else {
        cl.outcome = 'unresolved'; stats.unresolved++;
        cl.why = !evidences.length ? 'no evidence from representative members' : high ? 'HIGH evidence city disagrees with cluster city' : `only ${agreeing.length} independent MEDIUM confirmation(s) (need ${MEDIUM_INDEPENDENT_MIN}); evidence: ${evidences.map((e) => e.method + '/' + e.confidence).join(', ')}`;
        cl.evidence = evidences.map((e) => ({ method: e.method, confidence: e.confidence, city: e.city, source_id: e.source_id }));
      }
    }
    if (cl.outcome === 'existing_venue' || cl.outcome === 'venue_created') { counters.venueClustersResolved = (counters.venueClustersResolved || 0) + 1; for (const id of cl.cases) ctx.clusterByCase.set(id, cl.key); }
    clusters.push(cl);
  }
  return { clusters, stats };
}

module.exports = { resolveVenueClusters, groupMembers, independentAgreeing, CLUSTER_ISSUES, MEDIUM_INDEPENDENT_MIN };
