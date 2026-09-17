// TuRu - THE CLEANER: dry classification of the ticket / registration ACTION backlog (read-only).
// Subjects: every published activity's event-level action (official_url) and every upcoming occurrence's
// booking_url, plus the events that have NO action although evidence exists (UPGRADE).
//   KEEP_DIRECT     a provider / event-specific URL that answers and names the event
//   INDIRECT_BEST   answers, but is a generic page (site root / the listing) - correct, not direct
//   UPGRADE         no action stored, yet verified evidence exists (detail_url, or a registration_url the
//                   extractor saw on the event's own candidate) - HIGH only when it is an event-specific URL
//   WRONG_EVENT     the page answers but does not mention the event (checked only for event-specific URLs)
//   BROKEN          404 / 410 / DNS failure            BLOCKED   401 / 403 / 429 / challenge (unknown, not broken)
//   EXPIRED         the event's last date has passed
// Correct-but-indirect beats direct-but-wrong: nothing here is ever synthesised or guessed.
// Bounded: <= --max URLs (default 80), 1 request / second, 12 s timeout, GET with a small read.
//   node audit-ticket-urls.js [--max=80] [--out=file.json]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { normalizeForMatch } = require('./eventFingerprint');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const MAX = Number(args.max || 80);
const PROVIDERS = /(smarticket\.co\.il|kupat\.co\.il|eventbuzz\.co\.il|tickchak\.co\.il|eventim\.co\.il|leaan\.co\.il|coing\.co|tic\.li|ticketsi|mevalim\.co\.il|eventer\.co\.il|forms\.gle|docs\.google\.com\/forms|wa\.me|api\.whatsapp\.com|bit\.ly|go\.ticks)/i;
const isGeneric = (u, listing) => { try { const x = new URL(u); const p = x.pathname.replace(/\/+$/, ''); if (!p && !x.search) return 'site_root'; if (listing && u.replace(/\/+$/, '') === String(listing).replace(/\/+$/, '')) return 'same_as_listing'; return null; } catch { return 'unparseable'; } };
const words = (t) => new Set(normalizeForMatch(t).split(' ').filter((w) => w.length > 2));
const mentions = (html, name) => { const N = words(name); if (!N.size) return null; const H = normalizeForMatch(html.slice(0, 400000)); let n = 0; N.forEach((w) => { if (H.includes(w)) n++; }); return n / N.size; };
let last = 0;
async function probe(u) {
  const wait = 1000 - (Date.now() - last); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); last = Date.now();
  try { const res = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TuruBot/1.0)', 'Accept-Language': 'he' }, signal: AbortSignal.timeout(12000) }); const ct = res.headers.get('content-type') || ''; const body = /html|text/.test(ct) ? (await res.text()).slice(0, 400000) : ''; return { status: res.status, finalUrl: res.url, body }; }
  catch (e) { return { status: 0, error: (e.cause?.code || e.name || String(e)).slice(0, 40) }; }
}

(async () => {
  const { client } = await getClient();
  const today = new Date().toISOString().slice(0, 10);
  const acts = await all(client, 'activities', 'id, name, source_url, official_url, detail_url, source_id, activity_schedules(schedule_type, one_time_date, booking_url)', (q) => q.eq('status', 'approved'));
  const subjects = [];
  for (const a of acts) {
    const dates = (a.activity_schedules || []).filter((s) => s.schedule_type === 'one_time' && s.one_time_date).map((s) => s.one_time_date).sort();
    const expired = dates.length > 0 && dates[dates.length - 1] < today;
    const upcoming = dates.find((d) => d >= today) || null;
    if (a.official_url) subjects.push({ kind: 'official_url', activity: a, url: a.official_url, expired, upcoming });
    for (const s of a.activity_schedules || []) if (s.booking_url && (!s.one_time_date || s.one_time_date >= today)) subjects.push({ kind: 'occurrence_booking', activity: a, url: s.booking_url, date: s.one_time_date, expired: false, upcoming: s.one_time_date });
  }
  // upcoming first (brief: prioritise upcoming events), bounded
  subjects.sort((x, y) => String(x.upcoming || '9999').localeCompare(String(y.upcoming || '9999')));
  const checked = []; const tally = {};
  for (const s of subjects.slice(0, MAX)) {
    let klass, why;
    if (s.expired) { klass = 'EXPIRED'; why = 'last date passed'; }
    else {
      const generic = isGeneric(s.url, s.activity.source_url);
      const r = await probe(s.url);
      if (r.status === 404 || r.status === 410 || (r.status === 0 && /ENOTFOUND|EAI_AGAIN/.test(r.error || ''))) { klass = 'BROKEN'; why = r.status ? 'HTTP ' + r.status : r.error; }
      else if ([401, 403, 429].includes(r.status) || r.status === 0 || r.status >= 500) { klass = 'BLOCKED'; why = r.status ? 'HTTP ' + r.status : r.error; }
      else if (generic) { klass = 'INDIRECT_BEST'; why = generic; }
      else { const m = r.body ? mentions(r.body, s.activity.name) : null; if (m != null && m < 0.34 && !PROVIDERS.test(s.url)) { klass = 'WRONG_EVENT'; why = `page mentions ${Math.round(m * 100)}% of the event's title words`; } else { klass = 'KEEP_DIRECT'; why = PROVIDERS.test(s.url) ? 'provider url' : `event page (title words ${m == null ? 'n/a' : Math.round(m * 100) + '%'})`; } }
    }
    tally[klass] = (tally[klass] || 0) + 1;
    checked.push({ klass, why, kind: s.kind, activity_id: s.activity.id, name: s.activity.name, url: s.url, date: s.date || s.upcoming || null, host: (() => { try { return new URL(s.url).host.replace(/^www\./, ''); } catch { return null; } })() });
  }
  // UPGRADE: upcoming events with no action at all, but verified evidence
  const noAction = acts.filter((a) => !a.official_url && !(a.activity_schedules || []).some((s) => s.booking_url) && (a.activity_schedules || []).some((s) => s.schedule_type === 'one_time' && s.one_time_date >= today));
  const upgrade = { with_verified_detail_url: noAction.filter((a) => a.detail_url).length, none: noAction.filter((a) => !a.detail_url).length };
  const byProvider = {}; for (const c of checked) { const k = `${c.host}|${c.klass}`; byProvider[k] = (byProvider[k] || 0) + 1; }
  const report = { generatedAt: new Date().toISOString(), action_urls_total: subjects.length, checked: checked.length, distribution: tally, upcoming_events_without_any_action: noAction.length, upgrade, byProviderAndClass: byProvider, rows: checked };
  const file = path.join(__dirname, String(args.out || `ticket-url-audit-${today}.json`));
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`action urls ${subjects.length} | checked ${checked.length} |`, JSON.stringify(tally));
  console.log('upcoming events without ANY action:', noAction.length, JSON.stringify(upgrade));
  console.log('by provider:', JSON.stringify(byProvider));
  checked.filter((c) => !['KEEP_DIRECT', 'EXPIRED'].includes(c.klass)).forEach((c) => console.log(`  [${c.klass}] ${c.name.slice(0, 40)} | ${c.url.slice(0, 80)} | ${c.why}`));
  console.log('->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
