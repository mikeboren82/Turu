// TuRu - coverage model + gap engine: "where is Turu weak right now?" across GEOGRAPHY × SOURCE
// FAMILY × CATEGORY, plus source health/yield. Read-only. Prints a report and writes
// coverage-report-<date>.json (consumed by the next discovery pass).
//   node report-coverage.js [--json-only]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');

const REGIONS = ['הצפון והגליל', 'עמק יזרעאל והעמקים', 'חיפה והקריות', 'השרון', 'גוש דן והמרכז', 'ירושלים והסביבה', 'השפלה', 'הדרום והנגב', 'יו"ש והבנימין'];
const FAMILY_OF_KIND = { municipality_calendar: 'municipality', chain_events_page: 'mall', aggregator: 'aggregator', facebook: 'social', instagram: 'social', ticketing: 'ticketing' };
const FAMILY_OF_PUBLISHER = { municipality: 'municipality', local_council: 'municipality', regional_council: 'municipality', mall_chain: 'mall', community_center_network: 'community_center', library_network: 'library', aggregator: 'aggregator' };
const FAMILY_OF_VENUE_TYPE = { mall: 'mall', shopping_center: 'mall', museum: 'museum', library: 'library', community_center: 'community_center', theater: 'theater', cultural_center: 'theater', park: 'nature', farm: 'farm', petting_zoo: 'farm', visitor_center: 'nature', nature_site: 'nature', attraction: 'attraction', sports_center: 'sports' };

async function all(client, table, select, fn) {
  let from = 0, rows = [];
  while (true) { let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q); const { data, error } = await q; if (error) throw error; rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000; }
}
const tally = (arr, fn) => { const m = {}; arr.forEach((x) => { const k = fn(x) ?? '(null)'; m[k] = (m[k] || 0) + 1; }); return m; };

(async () => {
  const { client } = await getClient();
  const [sources, venues, acts, logs, incoming] = await Promise.all([
    all(client, 'sources', '*, venue:venues(venue_type, city, region)'),
    all(client, 'venues', 'id, name_he, venue_type, city, region, is_active, facebook_url, instagram_url, website_url, events_url'),
    all(client, 'activities', 'id, status, category, venue_id, source_id, created_at, last_seen_at, location:locations(region, city), activity_schedules(schedule_type)'),
    all(client, 'source_scan_logs', 'source_id, started_at, status, activities_found, new_count, updated_count, duplicate_count, auto_approved_count, failure_kind, detail_metrics', (q) => q.gte('started_at', new Date(Date.now() - 30 * 86400000).toISOString())),
    // only the JSON keys we need - pulling whole extracted_data blobs for ~1.5k rows timed out PostgREST
    all(client, 'incoming_activities', 'source_id, status, match_type, found_at, location_name:extracted_data->>location_name, city:extracted_data->>city, venue_id:extracted_data->>venue_id', (q) => q.gte('found_at', new Date(Date.now() - 30 * 86400000).toISOString())),
  ]);
  // venue-normalization backlog: location labels the scanner keeps seeing but cannot link to a venue
  const unresolvedVenueLabels = tally(incoming.filter((i) => i.location_name && !i.venue_id), (i) => `${i.location_name} | ${i.city || '?'}`);

  const familyOf = (s) => {
    const byMeta = FAMILY_OF_KIND[s.source_kind] || FAMILY_OF_PUBLISHER[s.publisher_type] || FAMILY_OF_VENUE_TYPE[s.venue?.venue_type];
    if (byMeta) return byMeta;
    if ((s.categories || []).some((c) => ['חווה', 'פינת חי', 'בעלי חיים'].includes(c))) return 'farm';
    if ((s.categories || []).some((c) => ['מוזיאון לילדים', 'מדע'].includes(c))) return 'museum';
    if ((s.categories || []).some((c) => ['ספרייה', 'שעת סיפור'].includes(c))) return 'library';
    if ((s.categories || []).some((c) => ['הצגה'].includes(c))) return 'theater';
    return 'venue_website';
  };
  const regionOf = (s) => s.region || s.venue?.region || '(unknown)';
  const active = sources.filter((s) => s.is_active);
  const approved = acts.filter((a) => a.status === 'approved');
  const nonPlayground = approved.filter((a) => a.category !== 'גן שעשועים');
  const dated = approved.filter((a) => (a.activity_schedules || []).some((s) => s.schedule_type !== 'fixed_hours'));

  // per-source yield (30d). "active" != "healthy" != "productive": a source can return HTTP 200 on every
  // scan and still never produce a useful activity - the yield model makes that visible.
  const blankYield = () => ({ scans: 0, ok: 0, found: 0, created: 0, updated: 0, dupes: 0, rejected: 0, pending: 0, live: 0, lastUsefulAt: null, zeroYieldStreak: 0, failKinds: {} });
  const yieldBySource = {};
  const logsBySource = {};
  for (const l of logs) { const y = (yieldBySource[l.source_id] ||= blankYield()); y.scans++; if (l.status !== 'error') y.ok++; y.found += l.activities_found || 0; y.created += l.auto_approved_count || 0; y.updated += l.updated_count || 0; y.dupes += l.duplicate_count || 0; if (l.failure_kind) y.failKinds[l.failure_kind] = (y.failKinds[l.failure_kind] || 0) + 1; (logsBySource[l.source_id] ||= []).push(l); }
  for (const i of incoming) {
    if (!i.source_id) continue; const y = (yieldBySource[i.source_id] ||= blankYield());
    if (i.status === 'approved') { y.created++; if (!y.lastUsefulAt || i.found_at > y.lastUsefulAt) y.lastUsefulAt = i.found_at; }
    else if (i.status === 'rejected') y.rejected++;
    else if (['new', 'needs_review'].includes(i.status)) y.pending++;
  }
  for (const a of approved) { if (!a.source_id) continue; const y = (yieldBySource[a.source_id] ||= blankYield()); y.live++; if (!y.lastUsefulAt || a.created_at > y.lastUsefulAt) y.lastUsefulAt = a.created_at; }
  // zero-yield streak = latest consecutive completed scans that found nothing (running scans ignored)
  for (const [id, ls] of Object.entries(logsBySource)) { let streak = 0; for (const l of ls.filter((l) => l.status !== 'running').sort((a, b) => (a.started_at < b.started_at ? 1 : -1))) { if ((l.activities_found || 0) > 0) break; streak++; } yieldBySource[id].zeroYieldStreak = streak; }
  const productivity = (s) => {
    const y = yieldBySource[s.id]; if (!s.is_active) return 'paused';
    if (!y || y.scans === 0) return 'unscanned';
    if (y.created > 0 || y.live > 0) return 'productive';
    if (y.found > 0) return 'queue_only';      // finds things, nothing approved yet (review backlog / untrusted)
    if (y.ok === 0) return 'failing';
    return 'zero_yield';                        // scans succeed, nothing extracted
  };

  // DETAIL ENRICHMENT YIELD (30d, per source with detail traversal configured): links found, pages
  // attempted/fetched/failed, shared-link and title-mismatch rejections, fields filled by name
  // (occurrences / price / address / image / ages / audience / registration_url / jsonld:*).
  const detailYield = {};
  for (const l of logs) {
    const m = l.detail_metrics; if (!m) continue;
    const d = (detailYield[l.source_id] ||= { scans: 0, links: 0, attempted: 0, fetched: 0, failed: 0, relayPrimed: 0, sharedLinks: 0, titleMismatch: 0, filled: {}, filledTotal: 0 });
    d.scans++; d.links += m.links || 0; d.attempted += m.attempted || 0; d.fetched += m.fetched || 0; d.failed += m.failed || 0; d.relayPrimed += m.relay_primed || 0; d.sharedLinks += m.shared_links || 0; d.titleMismatch += m.rejected_title_mismatch || 0;
    for (const [k, v] of Object.entries(m.filled || {})) { d.filled[k] = (d.filled[k] || 0) + (Number(v) || 0); d.filledTotal += Number(v) || 0; }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      sources: sources.length, activeSources: active.length, pausedSources: sources.filter((s) => s.health_status === 'auto_paused').length,
      attentionSources: sources.filter((s) => s.health_status === 'attention_required').length,
      socialOnlySources: sources.filter((s) => ['facebook', 'instagram'].includes(s.source_kind)).length,
      venues: venues.filter((v) => v.is_active).length, activities: approved.length, nonPlaygroundActivities: nonPlayground.length, datedActivities: dated.length,
      activitiesWithVenue: approved.filter((a) => a.venue_id).length, activitiesWithSourceId: approved.filter((a) => a.source_id).length,
    },
    byRegion: Object.fromEntries(REGIONS.concat(['(unknown)']).map((r) => [r, {
      sources: sources.filter((s) => regionOf(s) === r).length, activeSources: active.filter((s) => regionOf(s) === r).length,
      venues: venues.filter((v) => v.is_active && v.region === r).length,
      activities: approved.filter((a) => a.location?.region === r).length, nonPlayground: nonPlayground.filter((a) => a.location?.region === r).length,
      families: tally(active.filter((s) => regionOf(s) === r), familyOf),
    }])),
    byFamily: tally(active, familyOf),
    byFamilyAll: tally(sources, familyOf),
    byCategory: tally(nonPlayground, (a) => a.category),
    socialOnlyVenues: venues.filter((v) => v.is_active && (v.facebook_url || v.instagram_url) && !v.events_url && !sources.some((s) => s.venue_id === v.id && s.is_active)).map((v) => ({ name: v.name_he, city: v.city, region: v.region, type: v.venue_type })),
    // SOCIAL COVERAGE (2026-09-17). The four states are NEVER collapsed: an account that was found is not an
    // account Turu can read, and an account Turu can read is not one that yields activities.
    social: (() => {
      const av = venues.filter((v) => v.is_active);
      const soc = sources.filter((s) => ['facebook', 'instagram'].includes(s.source_kind));
      const st = (s) => s.adapter_config?.social || {};
      const productiveWeb = (v) => sources.some((s) => s.venue_id === v.id && s.is_active && !['facebook', 'instagram'].includes(s.source_kind) && (s.activities_found_total || 0) > 0);
      const socialOnly = av.filter((v) => (v.facebook_url || v.instagram_url) && !productiveWeb(v));
      return {
        knownVenues: av.length,
        HAS_WEBSITE: av.filter((v) => v.website_url).length, HAS_FACEBOOK: av.filter((v) => v.facebook_url).length, HAS_INSTAGRAM: av.filter((v) => v.instagram_url).length,
        SOCIAL_UNKNOWN: av.filter((v) => !v.facebook_url && !v.instagram_url).length,
        SOCIAL_ONLY_RELEVANT_PUBLISHERS: socialOnly.length, // a social presence and NO productive website / feed source
        socialOnlyByRegion: tally(socialOnly, (v) => v.region || '(unknown)'), socialOnlyByType: tally(socialOnly, (v) => v.venue_type || '(unknown)'),
        registeredAccounts: soc.length, byPlatform: tally(soc, (s) => s.source_kind),
        SOCIAL_ACCOUNT_DISCOVERED: soc.filter((s) => st(s).state === 'DISCOVERED').length,
        SOCIAL_ACCOUNT_VERIFIED: soc.filter((s) => st(s).state === 'VERIFIED').length,
        SOCIAL_CONTENT_ACCESSIBLE: soc.filter((s) => st(s).access?.status === 'ACCESSIBLE').length,
        SOCIAL_CONSENTED: soc.filter((s) => st(s).consent?.status === 'GRANTED').length,
        SOCIAL_BLOCKED: soc.filter((s) => st(s).access?.status === 'BLOCKED').length,
        SOCIAL_NOT_CONFIGURED: soc.filter((s) => st(s).access?.status === 'NOT_CONFIGURED').length,
        SOCIAL_CONTENT_PRODUCTIVE: soc.filter((s) => (s.activities_found_total || 0) > 0).length,
        accessFailureClasses: tally(soc.filter((s) => st(s).access?.failure_class), (s) => st(s).access.failure_class),
      };
    })(),
    unresolvedVenueLabels: Object.entries(unresolvedVenueLabels).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([label, n]) => ({ label, detections: n })),
    reviewQueue: { pending: incoming.filter((i) => ['new', 'needs_review'].includes(i.status)).length, autoApproved30d: incoming.filter((i) => i.status === 'approved').length, duplicates30d: incoming.filter((i) => i.match_type === 'duplicate').length },
    sourceHealth: tally(sources, (s) => s.health_status),
    failureKinds: tally(sources.filter((s) => s.last_failure_kind), (s) => s.last_failure_kind),
    lowYieldSources: active.filter((s) => (yieldBySource[s.id]?.scans || 0) >= 2 && (yieldBySource[s.id]?.found || 0) === 0).map((s) => ({ name: s.name, scans: yieldBySource[s.id].scans, failKinds: yieldBySource[s.id].failKinds })),
    topYieldSources: Object.entries(yieldBySource).map(([id, y]) => ({ name: sources.find((s) => s.id === id)?.name || id, ...y })).sort((a, b) => b.found - a.found).slice(0, 15),
    productivity: tally(sources, productivity),
    detailYield: sources.filter((s) => s.adapter_config && s.adapter_config.detail_traversal).map((s) => ({ id: s.id, name: s.name, ...(detailYield[s.id] || { scans: 0, links: 0, attempted: 0, fetched: 0, failed: 0, relayPrimed: 0, sharedLinks: 0, titleMismatch: 0, filled: {}, filledTotal: 0 }) })).sort((a, b) => b.filledTotal - a.filledTotal),
    sourceYield: sources.map((s) => ({ id: s.id, name: s.name, region: regionOf(s), family: familyOf(s), active: !!s.is_active, health: s.health_status, trust: s.source_trust_score, productivity: productivity(s), ...(yieldBySource[s.id] || blankYield()) }))
      .sort((a, b) => (b.live + b.created) - (a.live + a.created)),
    gaps: [],
  };
  report.byRegionYield = Object.fromEntries(REGIONS.concat(['(unknown)']).map((r) => { const ss = report.sourceYield.filter((s) => s.region === r && s.active); return [r, { activeSources: ss.length, productive: ss.filter((s) => s.productivity === 'productive').length, queueOnly: ss.filter((s) => s.productivity === 'queue_only').length, zeroYield: ss.filter((s) => s.productivity === 'zero_yield').length, failing: ss.filter((s) => s.productivity === 'failing').length, unscanned: ss.filter((s) => s.productivity === 'unscanned').length, created30d: ss.reduce((n, s) => n + s.created, 0), pending: ss.reduce((n, s) => n + s.pending, 0) }]; }));

  // ---- gap engine: actionable, ranked ----
  const gaps = [];
  for (const r of REGIONS) {
    const b = report.byRegion[r];
    if (b.activeSources < 4) gaps.push({ severity: 'high', kind: 'region_sources', region: r, message: `${r}: only ${b.activeSources} active sources`, action: `discover-sources.js --regions=<${r}> --families=mall,municipality,library,community_center` });
    for (const fam of ['mall', 'municipality', 'library', 'community_center', 'museum']) if (!(b.families[fam] > 0)) gaps.push({ severity: 'medium', kind: 'region_family', region: r, family: fam, message: `${r}: no active ${fam} source`, action: `discover-sources.js --regions=<${r}> --families=${fam}` });
    if (b.nonPlayground < 10) gaps.push({ severity: 'high', kind: 'region_activities', region: r, message: `${r}: only ${b.nonPlayground} non-playground activities live`, action: 'add event-yielding sources (municipality/mall) in this region' });
  }
  for (const fam of ['library', 'community_center', 'theater', 'museum', 'farm', 'nature', 'organizer', 'ticketing']) if ((report.byFamily[fam] || 0) < 3) gaps.push({ severity: 'medium', kind: 'family_thin', family: fam, message: `source family "${fam}" has ${report.byFamily[fam] || 0} active sources nationally`, action: `discover-sources.js --families=${fam}` });
  const thinCats = ['הצגה', 'שעת סיפור', 'ספרייה', 'סדנה', 'יצירה', 'מדע', 'פעילות מים', 'בריכה', 'טבע', 'חווה', 'מוזיקה', 'ריקוד', 'קולנוע לילדים', 'פעילות עירונית', 'פעילות קהילתית'];
  for (const c of thinCats) if ((report.byCategory[c] || 0) < 5) gaps.push({ severity: 'medium', kind: 'category_thin', category: c, message: `category "${c}": ${report.byCategory[c] || 0} live activities`, action: 'target sources that publish this content (libraries/theaters/community centers/pools)' });
  if (report.socialOnlyVenues.length) gaps.push({ severity: 'high', kind: 'social_gap', message: `${report.socialOnlyVenues.length} venues publish only on Facebook/Instagram (unsupported)`, action: 'see SOCIAL INGESTION GAP in the report; legitimate paths: Graph API with page-owner consent / venue-provided feeds' });
  if (report.lowYieldSources.length) gaps.push({ severity: 'low', kind: 'low_yield', message: `${report.lowYieldSources.length} active sources scanned ≥2× in 30d with zero activities`, action: 'inspect seed URL (maybe a homepage, not the events page) or lower priority' });
  for (const r of REGIONS) { const y = report.byRegionYield[r]; if (y.activeSources >= 4 && y.productive < Math.ceil(y.activeSources / 3)) gaps.push({ severity: 'high', kind: 'region_low_yield', region: r, message: `${r}: ${y.activeSources} active sources but only ${y.productive} productive (${y.queueOnly} queue-only, ${y.zeroYield} zero-yield, ${y.failing} failing)`, action: 'fix seed URLs / trust-promote queue-only sources after quality review / relay-scan failing ones' }); }
  const queueOnly = report.sourceYield.filter((s) => s.productivity === 'queue_only' && s.pending >= 10);
  if (queueOnly.length) gaps.push({ severity: 'medium', kind: 'queue_only_sources', message: `${queueOnly.length} sources feed the review queue (>=10 pending each) but have nothing approved: ${queueOnly.slice(0, 6).map((s) => s.name).join(', ')}`, action: 'review a sample per source; promote trust to >=80 where quality holds so routine items auto-publish' });
  report.unresolvedVenueLabels.filter((u) => u.detections >= 5).slice(0, 10).forEach((u) => gaps.push({ severity: 'medium', kind: 'venue_missing', message: `"${u.label}" seen ${u.detections}× without a canonical venue`, action: 'create the venue (+aliases) in the admin "מקומות" page or source-manifest.json' }));
  // a source is not "detail-supported" because traversal is configured: it must actually fill fields
  for (const d of report.detailYield) if (d.scans >= 2 && d.filledTotal === 0) gaps.push({ severity: 'medium', kind: 'detail_zero_yield', message: `${d.name}: detail traversal configured, ${d.scans} scans, ${d.links} links, ${d.attempted} attempted, ${d.titleMismatch} title mismatches, 0 fields filled`, action: 'inspect detail_metrics.unmatched (card link text vs. candidate names) - add link_selector/url_pattern to adapter_config.detail_traversal or fix the seed page' });
  report.gaps = gaps.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]);

  const file = path.join(__dirname, `coverage-report-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  if (!process.argv.includes('--json-only')) {
    console.log('=== TOTALS ===', report.totals);
    console.log('\n=== BY REGION (sources active/total | venues | activities | non-playground) ===');
    for (const [r, b] of Object.entries(report.byRegion)) console.log(`${r.padEnd(18)} src ${String(b.activeSources).padStart(3)}/${String(b.sources).padEnd(3)} venues ${String(b.venues).padStart(3)} acts ${String(b.activities).padStart(5)} nonPG ${String(b.nonPlayground).padStart(4)}  ${JSON.stringify(b.families)}`);
    console.log('\n=== BY FAMILY (active) ===', report.byFamily);
    console.log('=== BY CATEGORY (non-playground live) ===', report.byCategory);
    console.log('=== SOURCE HEALTH ===', report.sourceHealth, '| failure kinds:', report.failureKinds);
    console.log('=== SOCIAL COVERAGE (discovered != verified != accessible != productive) ===', JSON.stringify(report.social, null, 1));
    console.log('=== SOCIAL-ONLY VENUES ===', report.socialOnlyVenues.length, report.socialOnlyVenues.slice(0, 10).map((v) => v.name).join(', '));
    console.log('=== LOW YIELD ===', report.lowYieldSources.map((s) => s.name).join(', ') || '-');
    console.log('=== PRODUCTIVITY (all sources) ===', report.productivity);
    console.log('=== DETAIL YIELD (30d, sources with detail traversal) ===');
    for (const d of report.detailYield) console.log(`${d.name.slice(0, 40).padEnd(40)} scans ${d.scans} links ${d.links} att ${d.attempted} ok ${d.fetched} fail ${d.failed} primed ${d.relayPrimed} shared ${d.sharedLinks} mismatch ${d.titleMismatch} filled ${d.filledTotal} ${JSON.stringify(d.filled)}`);
    console.log('=== BY REGION YIELD (active: productive / queue-only / zero-yield / failing / unscanned | created30d | pending) ===');
    for (const [r, y] of Object.entries(report.byRegionYield)) console.log(`${r.padEnd(18)} ${String(y.activeSources).padStart(3)}: ${y.productive}/${y.queueOnly}/${y.zeroYield}/${y.failing}/${y.unscanned} | ${y.created30d} | ${y.pending}`);
    console.log('\n=== GAPS (ranked) ===');
    report.gaps.slice(0, 30).forEach((g) => console.log(`[${g.severity}] ${g.message}  ->  ${g.action}`));
  }
  console.log(`\nwritten ${path.basename(file)}`);
})().catch((e) => { console.error(e); process.exit(1); });
