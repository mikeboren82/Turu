// TuRu - THE MONSTER, social input family, step 1: KNOWN-PUBLISHER social account discovery.
//   known publisher (canonical venue / registered source)  ->  its OFFICIAL website  ->  the social links on it
//   ->  account identity (lib/socialLinks.js)  ->  a row in the EXISTING source registry.
// This reads the publisher's own public website only. It never opens instagram.com / facebook.com, never logs
// in, never scrapes a feed. Finding an account is DISCOVERY; whether its content can be read is a separate,
// platform-governed question (ACCESS) answered by the Meta capability audit - the two are never collapsed:
//   adapter_config.social = { platform, handle, profile_url, state: DISCOVERED|VERIFIED, verified_via,
//                             discovered_from, discovered_at, access: { status, method, failure_class, checked_at },
//                             consent: { status } }
// Bounded: <= --max publisher sites per run (default 40), 1 request / second, homepage (+ contact page) only.
// Dry run by default:
//   node discover-social.js [--max=40] [--apply]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { getClient } = require('./supabase');
const { all } = require('./cleaner/discover');
const { fetchHtml } = require('./lib/fetchPage');
const { resolvePublisherAccounts, hostOf } = require('./lib/socialLinks');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const APPLY = !!args.apply; const MAX = Number(args.max || 40);
const REGISTER_MAX = Number(args.register || 20);
const cohort = { size: 0, perType: {}, members: [] };
const SOCIAL_HOST = /(facebook\.com|fb\.com|instagram\.com|linktr\.ee|beacons\.ai|bio\.site)/i;
// what the platform capability audit concluded (2026-09-17): content of an account Turu does not manage is not
// readable without the publisher's consent or an approved Meta feature - recorded as an ARCHITECTURAL state,
// not as a failed scan
// Meta capability audit 2026-09-17 (Graph API v26.0; Platform Terms 2026-02-03; docs in THE-MONSTER.md §8):
// content of an account Turu does not manage is reachable ONLY through paths whose prerequisites Turu does not
// hold yet. That is "NOT_CONFIGURED" (an access path exists, setup is missing) - different from a platform
// that forbids it, and different from a scan that failed. Scraping is never a path (Automated Data Collection Terms).
const ACCESS_BY_PLATFORM = {
  instagram: { status: 'NOT_CONFIGURED', method: null, failure_class: 'APP_REVIEW',
    candidate_methods: ['consented_connection (instagram_business_basic; App Review + Business Verification)', 'business_discovery by exact username (needs Turu\'s OWN Instagram professional account linked to a Page + Meta app; caption/permalink/Reels fields need a live test; professional accounts only)'],
    never: ['scraping instagram.com', 'oEmbed as a data source (display only)', 'Stories / location / tags of accounts that did not consent'] },
  facebook: { status: 'NOT_CONFIGURED', method: null, failure_class: 'APP_REVIEW',
    candidate_methods: ['consented_connection (pages_show_list + pages_read_engagement; long-lived Page token)', 'Page Public Content Access on a curated Page list (App Review + Business Verification; ~600 posts/yr/Page; no video posts)'],
    never: ['scraping facebook.com', 'Facebook Events (Marketing Partners only)', 'keyword search over posts'] },
};
const accessFor = (platform) => ({ ...ACCESS_BY_PLATFORM[platform], audit: 'meta-capability-audit-2026-09-17', checked_at: new Date().toISOString() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const originOf = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.host}/`; } catch { return null; } };

(async () => {
  const { client, userId } = await getClient();
  const venues = await all(client, 'venues', 'id, name_he, city, region, venue_type, website_url, events_url, facebook_url, instagram_url, is_active', (q) => q.eq('is_active', true));
  const sources = await all(client, 'sources', 'id, name, seed_url, source_kind, publisher_name, publisher_type, venue_id, region, is_active, adapter_config');
  // one publisher per official site host; a venue's own website wins over a source's seed host
  const pubs = new Map();
  for (const v of venues) { const site = v.website_url || v.events_url; const h = site && hostOf(site); if (!h || SOCIAL_HOST.test(h)) continue; if (!pubs.has(h)) pubs.set(h, { host: h, site: originOf(site), name: v.name_he, venue_id: v.id, region: v.region, city: v.city, type: v.venue_type, kind: 'venue', has: { facebook: v.facebook_url, instagram: v.instagram_url } }); }
  for (const s of sources) { if (!s.is_active || ['facebook', 'instagram', 'aggregator', 'ticketing'].includes(s.source_kind)) continue; const h = hostOf(s.seed_url); if (!h || SOCIAL_HOST.test(h)) continue; if (!pubs.has(h)) pubs.set(h, { host: h, site: originOf(s.seed_url), name: s.publisher_name || s.name, venue_id: s.venue_id || null, region: s.region, type: s.publisher_type, kind: 'source', source_id: s.id, has: {} }); }
  const known = new Map(sources.filter((s) => ['facebook', 'instagram'].includes(s.source_kind)).map((s) => [String(s.seed_url).toLowerCase().replace(/\/+$/, ''), s]));
  const list = [...pubs.values()].slice(0, MAX);
  console.log(`known publishers with an official site: ${pubs.size} | this run: ${list.length} | social sources already registered: ${known.size}`);

  const results = []; const tally = { sites: 0, fetched: 0, fetch_failed: 0, with_any_account: 0, accounts_verified: 0, accounts_discovered_only: 0, bio_links: 0, whatsapp: 0, already_registered: 0 };
  for (const p of list) {
    tally.sites++;
    let hrefs = []; let status = null;
    try {
      const r = await fetchHtml(p.site, { timeoutMs: 20000 }); status = r.status;
      if (r.ok && r.html) { tally.fetched++; const $ = cheerio.load(r.html.slice(0, 1500000)); $('a[href]').each((_, el) => { hrefs.push($(el).attr('href')); }); } else tally.fetch_failed++;
    } catch { tally.fetch_failed++; }
    await sleep(1000);
    const res = resolvePublisherAccounts(hrefs, { siteHost: p.host });
    if (res.accounts.length) tally.with_any_account++;
    for (const a of res.accounts) { if (a.state === 'VERIFIED') tally.accounts_verified++; else tally.accounts_discovered_only++; a.already_registered = known.has(a.url.toLowerCase().replace(/\/+$/, '')); if (a.already_registered) tally.already_registered++; }
    tally.bio_links += res.bioLinks.length; tally.whatsapp += res.whatsapp.length;
    results.push({ publisher: p.name, host: p.host, kind: p.kind, type: p.type || null, region: p.region || null, venue_id: p.venue_id || null, http: status, accounts: res.accounts, bioLinks: res.bioLinks, whatsapp: res.whatsapp.length, rejected: res.rejected.length });
    const line = res.accounts.map((a) => `${a.platform}:${a.handle}[${a.state}]`).join(' ');
    console.log(`  ${String(p.name).slice(0, 34).padEnd(34)} ${String(status).padEnd(4)} ${line || '-'}${res.bioLinks.length ? ' +bio' : ''}`);

    if (!APPLY) continue;
    // FIRST COHORT (brief: 10-20 representative known publishers): registry endpoints are created for a
    // type-diverse cohort only (--register=N, default 20, round-robin over publisher types) - not for every
    // discovered account. Canonical venue social fields are filled for every VERIFIED venue account.
    const verifiedHere = res.accounts.filter((x) => x.state === 'VERIFIED');
    const typeKey = p.type || p.kind; cohort.perType[typeKey] = cohort.perType[typeKey] || 0;
    const inCohort = verifiedHere.length > 0 && cohort.size < REGISTER_MAX && cohort.perType[typeKey] < Math.max(2, Math.ceil(REGISTER_MAX / 6));
    if (inCohort) { cohort.size++; cohort.perType[typeKey]++; cohort.members.push({ publisher: p.name, type: typeKey, region: p.region || null, accounts: verifiedHere.map((x) => `${x.platform}:${x.handle}`) }); }
    for (const a of verifiedHere) {
      // (1) canonical venue social fields, fill-null only
      if (p.venue_id) { const col = a.platform === 'facebook' ? 'facebook_url' : 'instagram_url'; await client.from('venues').update({ [col]: a.url }).eq('id', p.venue_id).is(col, null); }
      // (2) the account as a SOURCE ENDPOINT in the existing registry - inactive: nothing scans it until a legitimate access method exists
      if (a.already_registered || !inCohort) continue;
      const social = { platform: a.platform, handle: a.handle, profile_url: a.url, state: 'VERIFIED', verified_via: a.verified_via, discovered_from: p.site, discovered_at: new Date().toISOString(), access: accessFor(a.platform), consent: { status: 'NOT_REQUESTED' }, productive: null };
      const { error } = await client.from('sources').insert({ name: `${p.name} - ${a.platform === 'facebook' ? 'פייסבוק' : 'אינסטגרם'}`, seed_url: a.url, type: 'other', source_kind: a.platform, publisher_name: p.name, publisher_type: ['municipality', 'local_council', 'regional_council', 'mall_chain', 'venue_operator', 'organizer', 'community_center_network', 'library_network', 'government_body'].includes(p.type) ? p.type : 'other', venue_id: p.venue_id, region: p.region || null, categories: [], scan_frequency_hours: 72, is_active: false, is_trusted: false, source_trust_score: 60, priority: 5, strategy: 'generic_html', health_status: 'auto_paused', disabled_reason: 'social_access_not_configured: VERIFIED account; a legitimate access path exists (publisher consent / approved Meta feature) but Turu has no Meta app or token yet - never scraped', adapter_config: { social }, created_by: userId, discovery_batch: 'social-known-publishers-2026-09-17' });
      if (error) console.log('    register failed:', a.url, error.message);
    }
  }
  const file = path.join(__dirname, `social-discovery-${new Date().toISOString().slice(0, 10)}${APPLY ? '-applied' : '-dryrun'}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), applied: APPLY, publishersKnown: pubs.size, tally, cohort, results }, null, 2));
  if (APPLY) console.log('first cohort registered:', cohort.size, JSON.stringify(cohort.perType));
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}`, JSON.stringify(tally), '->', path.basename(file));
})().catch((e) => { console.error(e); process.exit(1); });
