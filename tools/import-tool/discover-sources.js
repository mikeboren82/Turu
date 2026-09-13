// TuRu - repeatable source discovery: "find Israeli children's-activity sources Turu doesn't know yet".
//
//   node discover-sources.js --families=mall,municipality --regions=south,north [--max-queries=40]
//   node discover-sources.js --queries=my-queries.txt        (one Hebrew query per line)
//   node discover-sources.js --urls=urls.txt                 (skip search, just fetch-test URLs)
//   node discover-sources.js --register=discovery-candidates-<date>.json
//       -> appends the candidates marked "approved": true to source-manifest.json (then run
//          seed-venues-and-sources.js --apply --batch=<label>)
//
// Pipeline: DISCOVER (SerpAPI, already configured for the admin tool) -> DEDUPE SOURCE (skip hosts
// already in sources / scraped_sources / social+aggregator noise) -> VERIFY (fetch: status, charset,
// Hebrew text volume, child/event keyword hits, JS-only detection) -> CLASSIFY (family guess from
// host/title) -> SCORE -> write discovery-candidates-<date>.json for human APPROVAL. Nothing is
// registered automatically; social URLs are kept as venue links + blocked source rows.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { getClient } = require('./supabase');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const UA = 'Mozilla/5.0 (compatible; TuruBot/1.0)';
const KEYWORDS = ['אירוע', 'פעילות', 'ילדים', 'סדנה', 'הצגה', 'שעת סיפור', 'משפחה', 'חינם', 'הפעלה', 'מופע'];
const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'x.com', 'twitter.com', 'linkedin.com', 'wikipedia.org', 'waze.com', 'google.com', 'apple.com'];
const NOISE_HOSTS = ['easy.co.il', 'ynet.co.il', 'walla.co.il', 'mako.co.il', 'israelhayom.co.il', 'haaretz.co.il', 'themarker.com', 'zap.co.il', 'yad2.co.il', 'madlan.co.il', 'homeless.co.il', 'booking.com', 'tripadvisor.com', 'kenyonim.com', 'ligdol.co.il', 'kinderland.co.il', 'tiuli.com', 'familytrips.co.il', 'karamel.co.il', 'makore.co.il'];

// Query matrix - family × region. Regions map to representative cities so the long tail (local
// centers, councils, libraries) surfaces, not just national chains.
const REGION_CITIES = {
  north: ['קריית שמונה', 'צפת', 'נהריה', 'עכו', 'כרמיאל', 'טבריה', 'עפולה', 'נוף הגליל', 'מגדל העמק', 'בית שאן', 'קצרין', 'מעלות תרשיחא'],
  haifa: ['חיפה', 'קריית ביאליק', 'קריית אתא', 'קריית מוצקין', 'טירת כרמל', 'נשר', 'קריית טבעון', 'זכרון יעקב'],
  sharon: ['נתניה', 'כפר סבא', 'רעננה', 'הוד השרון', 'חדרה', 'פרדס חנה כרכור', 'אבן יהודה', 'קדימה צורן', 'כפר יונה', 'תל מונד', 'הרצליה', 'רמת השרון'],
  center: ['פתח תקווה', 'ראש העין', 'ראשון לציון', 'חולון', 'בת ים', 'רמת גן', 'גבעתיים', 'בני ברק', 'קריית אונו', 'יהוד', 'אור יהודה', 'שוהם', 'גני תקווה', 'סביון'],
  telaviv: ['תל אביב', 'תל אביב יפו'],
  jerusalem: ['ירושלים', 'בית שמש', 'מבשרת ציון', 'מעלה אדומים', 'מודיעין', 'גבעת זאב'],
  shfela: ['רחובות', 'נס ציונה', 'לוד', 'רמלה', 'יבנה', 'גדרה', 'מודיעין מכבים רעות', 'באר יעקב', 'קריית עקרון'],
  south: ['באר שבע', 'אשדוד', 'אשקלון', 'קריית גת', 'נתיבות', 'שדרות', 'אופקים', 'דימונה', 'ערד', 'אילת', 'קריית מלאכי', 'רהט'],
};
const FAMILY_QUERIES = {
  mall: ['קניון {city} אירועים לילדים', 'מרכז מסחרי {city} פעילויות לילדים', '{city} מרכז מסחרי שכונתי הפעלות לילדים חינם'],
  municipality: ['עיריית {city} לוח אירועים', 'מועצה {city} אירועים לילדים ומשפחות', '{city} אירועי תרבות לילדים אתר רשמי'],
  library: ['ספרייה עירונית {city} שעת סיפור', 'ספריית {city} אירועים לילדים'],
  community_center: ['מתנ"ס {city} פעילויות לילדים לוח אירועים', 'מרכז קהילתי {city} אירועים למשפחות'],
  museum: ['מוזיאון {city} סדנאות לילדים לוח אירועים', '{city} מרכז מדע פעילות משפחות'],
  theater: ['{city} הצגות ילדים לוח הצגות היכל התרבות', 'תיאטרון {city} הצגות ילדים'],
  farm_nature: ['{city} חווה חינוכית פינת חי פעילות משפחות', '{city} מרכז מבקרים פעילות לילדים'],
  organizer: ['{city} הפעלות לילדים מפיק אירועי ילדים לוח אירועים', '{city} אירועי ילדים חינם השבוע'],
};

async function serp(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error('SERPAPI_KEY missing in .env');
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google'); url.searchParams.set('q', query); url.searchParams.set('hl', 'he'); url.searchParams.set('gl', 'il'); url.searchParams.set('num', '10'); url.searchParams.set('api_key', key);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`serpapi ${res.status}`);
  const data = await res.json();
  return (data.organic_results || []).map((r) => ({ url: r.link, title: r.title, snippet: r.snippet || '' }));
}

function host(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } }

async function fetchTest(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'he-IL,he;q=0.9' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.slice(0, 4096).toString('latin1');
    const charset = (/charset=([\w-]+)/i.exec(res.headers.get('content-type') || '') || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8';
    let html; try { html = new TextDecoder(charset.toLowerCase()).decode(buf); } catch { html = buf.toString('utf8'); }
    const $ = cheerio.load(html); $('script,style,noscript,svg').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const hebrew = (text.match(/[א-ת]/g) || []).length;
    const kw = KEYWORDS.reduce((s, k) => s + (text.split(k).length - 1), 0);
    const title = ($('title').first().text() || '').trim();
    const jsonLd = $('script[type="application/ld+json"]').length;
    const hasEventLd = $('script[type="application/ld+json"]').toArray().some((el) => /"@type"\s*:\s*"?Event/i.test($(el).html() || ''));
    let verdict = 'scrapable';
    if (res.status === 403 || res.status === 429) verdict = 'blocked';
    else if (res.status >= 400) verdict = 'http_error';
    else if (hebrew < 300) verdict = 'js_only';
    else if (kw < 3) verdict = 'low_relevance';
    return { status: res.status, ms: Date.now() - t0, charset, textChars: text.length, hebrewChars: hebrew, keywordHits: kw, title, jsonLd, hasEventLd, finalUrl: res.url, verdict };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: `${e.name}: ${e.message}`.slice(0, 120), verdict: 'blocked' };
  }
}

function guessFamily(u, title) {
  const h = host(u) || ''; const t = (title || '').toLowerCase();
  if (/muni\.il|\.gov\.il|מועצה|עיריית|עירייה/.test(h + t)) return 'municipality';
  if (/matnas|מתנ|קהילתי/.test(h + t)) return 'community_center';
  if (/ספרי|library|ariela/.test(h + t)) return 'library';
  if (/מוזיאון|museum|מדע|madatech/.test(h + t)) return 'museum';
  if (/קניון|mall|סנטר|center|מרכז מסחרי|azrieli|amot|ofer|big/.test(h + t)) return 'mall';
  if (/תיאטרון|היכל|theater|הצג/.test(h + t)) return 'theater';
  if (/חוו|פינת חי|farm|zoo|טבע|park/.test(h + t)) return 'farm_nature';
  return 'other';
}

async function main() {
  if (args.register) return registerApproved(String(args.register));
  const { client } = await getClient();
  const [{ data: sources }, { data: scraped }] = await Promise.all([
    client.from('sources').select('seed_url'), client.from('scraped_sources').select('url'),
  ]);
  const knownHosts = new Set([...(sources || []).map((s) => host(s.seed_url)), ...(scraped || []).map((s) => host(s.url))].filter(Boolean));
  const knownUrls = new Set((sources || []).map((s) => s.seed_url.replace(/\/$/, '')));

  let queries = [];
  if (args.queries) queries = fs.readFileSync(String(args.queries), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  else if (!args.urls) {
    const families = String(args.families || Object.keys(FAMILY_QUERIES).join(',')).split(',');
    const regions = String(args.regions || Object.keys(REGION_CITIES).join(',')).split(',');
    for (const f of families) for (const r of regions) for (const city of REGION_CITIES[r] || []) for (const tpl of FAMILY_QUERIES[f] || []) queries.push(tpl.replace('{city}', city));
    // spread: shuffle deterministically-ish so a capped run still covers regions/families
    queries = queries.sort(() => Math.random() - 0.5);
  }
  const maxQueries = Number(args['max-queries'] || 40);
  queries = queries.slice(0, maxQueries);

  const candidates = new Map();
  if (args.urls) {
    for (const u of fs.readFileSync(String(args.urls), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) candidates.set(u, { url: u, title: '', queries: ['(manual)'] });
  } else {
    console.log(`running ${queries.length} discovery queries via SerpAPI...`);
    for (const q of queries) {
      try {
        for (const r of await serp(q)) {
          const h = host(r.url); if (!h) continue;
          if (SOCIAL_HOSTS.some((s) => h.endsWith(s))) { const c = candidates.get(r.url) || { url: r.url, title: r.title, queries: [], social: true }; c.queries.push(q); candidates.set(r.url, c); continue; }
          if (NOISE_HOSTS.some((s) => h.endsWith(s))) continue;
          if (knownHosts.has(h)) continue;
          const c = candidates.get(r.url) || { url: r.url, title: r.title, snippet: r.snippet, queries: [] }; c.queries.push(q); candidates.set(r.url, c);
        }
      } catch (e) { console.error('query failed:', q, e.message); }
    }
  }
  console.log(`${candidates.size} candidate URLs (after dropping known hosts/noise). fetch-testing...`);
  const out = [];
  for (const c of candidates.values()) {
    if (c.social) { out.push({ ...c, family: guessFamily(c.url, c.title), verdict: 'social', approved: false }); continue; }
    if (knownUrls.has(c.url.replace(/\/$/, ''))) continue;
    const t = await fetchTest(c.url);
    const family = guessFamily(c.url, t.title || c.title);
    const score = (t.verdict === 'scrapable' ? 50 : 0) + Math.min(30, (t.keywordHits || 0)) + (t.hasEventLd ? 15 : 0) + (family !== 'other' ? 5 : 0);
    out.push({ ...c, ...t, family, score, approved: false, suggested: { source_kind: family === 'municipality' ? 'municipality_calendar' : 'events_page', publisher_type: family === 'municipality' ? 'municipality' : (family === 'mall' ? 'venue_operator' : 'other'), scan_frequency_hours: 72, priority: 5, source_trust_score: family === 'municipality' || family === 'library' || family === 'museum' ? 85 : 70 } });
    process.stdout.write('.');
  }
  out.sort((a, b) => (b.score || 0) - (a.score || 0));
  const file = path.join(__dirname, `discovery-candidates-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), queries, candidates: out }, null, 2));
  const byVerdict = {}; out.forEach((o) => byVerdict[o.verdict] = (byVerdict[o.verdict] || 0) + 1);
  console.log(`\nwritten ${out.length} candidates to ${path.basename(file)} - verdicts:`, byVerdict);
  console.log('Top scrapable:'); out.filter((o) => o.verdict === 'scrapable').slice(0, 25).forEach((o) => console.log(`  [${o.family}] kw=${o.keywordHits} ${o.title?.slice(0, 50)} | ${o.url}`));
  console.log('\nNext: mark "approved": true (and adjust suggested fields / venue) in the JSON, then\n  node discover-sources.js --register=' + path.basename(file) + '\n  node seed-venues-and-sources.js --apply --batch=<label>');
}

function registerApproved(file) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  const manifestPath = path.join(__dirname, 'source-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const known = new Set(manifest.sources.map((s) => s.seed_url.replace(/\/$/, '')));
  let added = 0;
  for (const c of data.candidates.filter((c) => c.approved)) {
    if (known.has(c.url.replace(/\/$/, ''))) continue;
    manifest.sources.push({
      name: c.name || c.title || c.url, seed_url: c.url, status: c.verdict === 'scrapable' ? 'verified' : (c.verdict === 'social' ? 'social' : c.verdict === 'js_only' ? 'js_only' : 'blocked'),
      region: c.region || null, categories: [], venue: c.venue || null, discovery_batch: data.generatedAt.slice(0, 10), notes: `discovered via: ${(c.queries || []).slice(0, 2).join(' | ')}`,
      ...(c.suggested || {}), ...(c.overrides || {}),
    });
    added++;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`added ${added} approved sources to source-manifest.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
