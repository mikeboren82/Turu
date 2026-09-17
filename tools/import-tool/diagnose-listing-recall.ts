// TuRu - THE MONSTER: dense-listing recall funnel (diagnostic, read-only, writes nothing to the DB).
//   DOM cards detected -> present in the extraction text (which window) -> returned by the extractor
//   -> dropped as past -> sanitize issues.   Uses the PRODUCTION modules of scan-source, so the numbers
// are the scanner's own. One AI call per text window (same model / prompt / temperature / max_tokens).
//   deno run --allow-net --allow-env --allow-read --allow-write diagnose-listing-recall.ts <listing url> [--per-card] [--out=file.json]
import Anthropic from 'npm:@anthropic-ai/sdk@0.32';
import * as cheerio from 'npm:cheerio@1.0.0';
import {
  buildExtractionSystemPrompt, parseExtractionResponse, filterPastOneTimeActivities, fetchHtml, pageTextForExtraction,
  EXTRACTION_MODEL, EXTRACTION_MAX_TOKENS, PAGE_TEXT_CHAR_LIMIT, MAX_TEXT_CHUNKS, splitTextForExtraction,
} from '../../supabase/functions/_shared/extraction.ts';
import { findEventDetailLinks } from '../../supabase/functions/_shared/detailLinks.ts';
import { enumerateListingCards, cardWindows } from '../../supabase/functions/_shared/listingCards.ts';

const args = Deno.args; const url = args.find((a) => !a.startsWith('--'));
if (!url) { console.error('usage: diagnose-listing-recall.ts <url> [--cards] [--out=file]'); Deno.exit(1); }
const useCards = args.includes('--cards');
const out = args.find((a) => a.startsWith('--out='))?.slice(6);
for (const line of (await Deno.readTextFile(new URL('./.env', import.meta.url))).split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(line.trim()); if (m && !Deno.env.get(m[1])) Deno.env.set(m[1], m[2].replace(/^["']|["']$/g, '')); }

const norm = (s: string) => (s || '').toLowerCase().replace(/[^֐-׿a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const overlap = (a: string, b: string) => { const A = new Set(norm(a).split(' ').filter((w) => w.length > 1)), B = new Set(norm(b).split(' ').filter((w) => w.length > 1)); if (!A.size || !B.size) return 0; let c = 0; A.forEach((w) => { if (B.has(w)) c++; }); return c / Math.min(A.size, B.size); };

const today = new Date().toISOString().slice(0, 10);
const res = await fetchHtml(url, { timeoutMs: 20000, retries: 1 });
if (!res.ok || !res.html) { console.error('fetch failed', res.fetchError); Deno.exit(2); }
const $ = cheerio.load(res.html);
const links = findEventDetailLinks($, url, { max: 80, allowHosts: [], listingUrls: [url] });
const cards = enumerateListingCards(cheerio.load(res.html), url);
const text = pageTextForExtraction(cheerio.load(res.html), PAGE_TEXT_CHAR_LIMIT * MAX_TEXT_CHUNKS);
const windows = useCards && cards.length >= 6 ? cardWindows(cards, PAGE_TEXT_CHAR_LIMIT) : splitTextForExtraction(text);
console.log(`page ${res.html.length} bytes | text ${text.length} chars | windows ${windows.length} (${useCards ? 'card' : 'text'} mode) | detail links ${links.length} | DOM cards ${cards.length}`);

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
// deno-lint-ignore no-explicit-any
let extracted: any[] = []; const calls: unknown[] = [];
const tAll = Date.now();
await Promise.all(windows.map(async (_, w) => {
  const t0 = Date.now();
  const message = await anthropic.messages.create({ model: EXTRACTION_MODEL, max_tokens: EXTRACTION_MAX_TOKENS, temperature: 0, system: buildExtractionSystemPrompt(), messages: [{ role: 'user', content: `כתובת המקור: ${url}\n\nתוכן הדף${windows.length > 1 ? ` (חלק ${w + 1} מתוך ${windows.length})` : ''}:\n${windows[w]}\n\nרשימת תמונות מהעמוד:\n[]` }] });
  const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const parsed = parseExtractionResponse(raw);
  calls.push({ window: w, chars: windows[w].length, stop_reason: message.stop_reason, in: message.usage.input_tokens, out: message.usage.output_tokens, returned: parsed.activities.length, truncated: parsed.truncated, repaired: parsed.repaired, ms: Date.now() - t0 });
  // deno-lint-ignore no-explicit-any
  extracted = extracted.concat(parsed.activities.map((a: any) => ({ ...a, _window: w })));
}));
console.log('all windows done in', Date.now() - tAll, 'ms (parallel)');
const kept = filterPastOneTimeActivities(extracted as never[], today) as { name: string }[];
const reference = cards.length >= 6 ? cards.map((c) => ({ title: c.title, url: c.url })) : links.map((l) => ({ title: l.text, url: l.url }));
const rows = reference.filter((c) => c.title && c.title.length >= 4).map((c) => {
  const inText = norm(text).includes(norm(c.title).slice(0, 25));
  const win = windows.findIndex((wt) => norm(wt).includes(norm(c.title).slice(0, 25)));
  const hit = extracted.find((e) => overlap(e.name, c.title) >= 0.6);
  const keptHit = kept.find((e) => overlap(e.name, c.title) >= 0.6);
  return { title: c.title.slice(0, 70), inText, window: win, extracted: !!hit, kept: !!keptHit, stage: !inText ? 'LOST_BEFORE_AI(not in text)' : !hit ? 'LOST_INSIDE_AI' : !keptHit ? 'DROPPED_AFTER_AI(past date)' : 'OK' };
});
const tally: Record<string, number> = {}; for (const r of rows) tally[r.stage] = (tally[r.stage] || 0) + 1;
const unmatched = extracted.filter((e) => !reference.some((c) => overlap(e.name, c.title) >= 0.6)).map((e) => e.name);
const report = { url, mode: useCards ? 'cards' : 'text', cards_detected: rows.length, funnel: tally, recall: rows.length ? Math.round(100 * rows.filter((r) => r.extracted).length / rows.length) : null, ai_returned: extracted.length, kept_after_past_filter: kept.length, extracted_without_card: unmatched, calls, lost: rows.filter((r) => r.stage !== 'OK') };
console.log(JSON.stringify(report, null, 2));
if (out) await Deno.writeTextFile(out, JSON.stringify({ ...report, rows }, null, 2));
