// TuRu - CONTINUOUS MONSTER: evidence-based scan cadence per source (pure, testable).
// The Monster is a maintained data system, not a periodic scrape: dated-event publishers change daily and their
// events have a median lead time of ~2 weeks (p25 5 d), permanent-venue directories change slowly, failing sources
// are governed by the health state machine (never here). Inputs are the registry row + its 30-day yield.
//
// CLASSES (from source_kind / publisher_type):
//   events   municipality_calendar, ticketing, aggregator, chain_events_page, events_page of municipality / council /
//            community centre / mall / organizer / library  -> dated events, high volatility
//   venue    venue_operator website / museum / farm / attraction directory                -> permanent offerings
//   social   facebook / instagram                                                           -> never scanned (NOT_CONFIGURED)
// CADENCE (hours): events 48 (24 when productive AND >= 60 % of scanned pages changed - a live calendar), 72 when the
// source found nothing new in 30 days but still succeeds; venue 168 (336 after two zero-yield months);
// unknown/new source: 72 until it has 3 scans. Bounds: never below 24 h (AI cost / politeness), never above 336 h.
// Failing / backed-off / paused sources keep the health-driven next_scan_at; only scan_frequency_hours is proposed.
const MIN_H = 24, MAX_H = 336;
const EVENT_KINDS = new Set(['municipality_calendar', 'ticketing', 'aggregator', 'chain_events_page', 'events_page']);
const EVENT_PUBLISHERS = new Set(['municipality', 'local_council', 'regional_council', 'community_center_network', 'mall_chain', 'organizer', 'library_network']);
const SOCIAL = new Set(['facebook', 'instagram']);

function classOf(source) {
  if (SOCIAL.has(source.source_kind)) return 'social';
  if (EVENT_KINDS.has(source.source_kind) && source.source_kind !== 'events_page') return 'events';
  if (source.source_kind === 'events_page') return EVENT_PUBLISHERS.has(source.publisher_type) ? 'events' : 'events';
  if (source.source_kind === 'website') return EVENT_PUBLISHERS.has(source.publisher_type) ? 'events' : 'venue';
  return 'venue';
}

// yield: { scans, ok, pages, changed, new_c, upd, auto, live } over 30 days
function proposeCadenceHours(source, y = {}) {
  const cls = classOf(source);
  if (cls === 'social') return { klass: cls, hours: null, why: 'social accounts are not scanned (access NOT_CONFIGURED)' };
  const scans = Number(y.scans || 0), pages = Number(y.pages || 0), changed = Number(y.changed || 0), useful = Number(y.new_c || 0) + Number(y.upd || 0);
  if (scans < 3) return { klass: cls, hours: 72, why: `fewer than 3 scans in 30 d (${scans}) - default until measured` };
  const changeRate = pages ? changed / pages : 0; const perScan = scans ? useful / scans : 0;
  if (cls === 'events') {
    // "live calendar" = it actually yields on most visits (>= 1 new/updated candidate per scan on average AND >= 10 in
    // 30 d); a page hash that changes on every load (dynamic markup) is not evidence of new content on its own
    if (useful >= 10 && perScan >= 1 && changeRate >= 0.5) return { klass: cls, hours: 24, why: `live calendar: ${useful} new/updated in 30 d (${perScan.toFixed(1)} per scan), ${Math.round(changeRate * 100)} % of pages changed` };
    if (useful > 0) return { klass: cls, hours: 48, why: `productive event source: ${useful} new/updated in 30 d (${perScan.toFixed(1)} per scan)` };
    return { klass: cls, hours: 72, why: 'event source without new/updated candidates in 30 d - slower until it yields' };
  }
  if (useful > 0) return { klass: cls, hours: 168, why: `permanent-venue source with ${useful} changes in 30 d` };
  return { klass: cls, hours: 336, why: 'permanent-venue source without changes in 30 d' };
}

function clampHours(h) { return h == null ? null : Math.max(MIN_H, Math.min(MAX_H, Math.round(h))); }

// -> { source_id, current, proposed, klass, why, change: boolean }
// budgetScansPerDay: the plan never exceeds it - the least productive 24 h sources are demoted to 48 h, then 48 h
// to 72 h, until the expected daily scan count fits (AI cost is the constraint, not politeness alone)
function cadencePlan(sources, yieldById, { budgetScansPerDay = null } = {}) {
  const plan = sources.filter((s) => s.is_active && !SOCIAL.has(s.source_kind)).map((s) => {
    const y = yieldById[s.id] || {}; const p = proposeCadenceHours(s, y); const proposed = clampHours(p.hours);
    return { source_id: s.id, name: s.name, klass: p.klass, current: Number(s.scan_frequency_hours) || null, proposed, why: p.why, useful: Number(y.new_c || 0) + Number(y.upd || 0), change: proposed != null && proposed !== Number(s.scan_frequency_hours) };
  });
  if (budgetScansPerDay) {
    for (const [from, to] of [[24, 48], [48, 72]]) {
      const demotable = plan.filter((p) => p.proposed === from).sort((a, b) => a.useful - b.useful);
      for (const p of demotable) { if (expectedScansPerDay(plan) <= budgetScansPerDay) break; p.proposed = to; p.why += ` | demoted ${from}->${to} h to stay within ${budgetScansPerDay} scans/day`; p.change = p.proposed !== p.current; }
    }
  }
  return plan;
}

// expected scans per day for a plan (each active source scanned every `hours`) - the number a person approves
function expectedScansPerDay(plan) { return Math.round(plan.reduce((n, p) => n + (p.proposed ? 24 / p.proposed : 0), 0) * 10) / 10; }

module.exports = { classOf, proposeCadenceHours, cadencePlan, expectedScansPerDay, clampHours, MIN_H, MAX_H };
