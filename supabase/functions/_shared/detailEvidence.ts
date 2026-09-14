// TuRu - evidence from an event's DETAIL page for THE MONSTER (scan-source detail traversal).
// Deterministic only - no AI call per detail page: JSON-LD Event (address / geo / date / time /
// audience), og:image, Hebrew street-address text, an explicit age range, a price (with tiers),
// the event's OCCURRENCES (every dated performance with its own time / provider id / purchase link)
// and (via applyDetailEvidence) a fill-null merge into the listing candidate. Stronger data wins:
// nothing the listing extraction already found is overwritten; every filled field is named in
// candidate.detail_filled and the page in candidate.detail_url.
//
// URL ROLES (binding): the detail page is EVENT evidence/provenance (url_role 'detail'). It is never
// written to registration_url. Per-performance purchase links are OCCURRENCE booking_url. An
// event-level registration_url is filled only from an explicit booking action that is not tied to
// one performance.
//
// Node twin of the parsers: tools/import-tool/lib/pageExtract.js (extractOccurrences / extractPriceTiers
// / extractAddressCandidates) - keep in lockstep.
import { parseJsonLdEvents, applyJsonLdToCandidate, isSinglePlace, type JsonLdEvent } from './jsonld.ts';
import { containsScore } from './detailLinks.ts';

export interface Occurrence { date: string; start_time: string | null; end_time: string | null; external_id: string | null; booking_url: string | null; evidence: string }
export interface PriceTier { label: string; amount: number }
export interface DetailEvidence {
  events: JsonLdEvent[]; ogImage: string | null; addressText: string | null; date: string | null; time: string | null;
  ages: { min_age: number; max_age: number | null; evidence: string } | null;
  price: { price_type: 'free' | 'fixed'; price_amount: number | null; tiers: PriceTier[]; evidence: string } | null;
  occurrences: Occurrence[];
  registrationUrl: string | null; // explicit event-level booking action only (never the detail page itself)
  childMarkers: number; adultMarkers: number; title: string; heading: string;
}

const STREET_WORDS = '(?:רחוב|רח\'|רח׳|שדרות|שד\'|שד׳|דרך|כיכר|סמטת)';
const CHILD = ['ילדים', 'לילד', 'פעוט', 'תינוק', 'משפחה', 'משפחות', 'גיל הרך', 'שעת סיפור', 'קטנטנים', 'לכל המשפחה', 'גילאי', 'נוער', 'הצגת ילדים'];
const ADULT = ['הרצאה', 'סטנדאפ', 'מנוי', 'גיל הזהב', 'ותיקים', 'גמלאים', 'למבוגרים בלבד', '18+', 'ערב נשים', 'טעימות יין'];
const DATE_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g;
const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const AGE_RE = /(?:גילאי|לגילאי|לגיל|גיל|בני)\s*(\d{1,2})\s*(?:[-–עד]+\s*(\d{1,2}))?\s*(\+)?/;

// --- Hebrew textual dates: the only form that may produce OCCURRENCES (specific enough: month name +
// 4-digit year, optional weekday). Loose dd.mm matches (footers, publication dates) never do.
const HEBREW_MONTHS: Record<string, number> = { 'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'מרס': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6, 'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12 };
const WEEKDAYS = 'ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת';
const TEXTUAL_DATE_RE = new RegExp(`(?:ב?יום\\s+(?:${WEEKDAYS})\\s*,?\\s*)?(\\d{1,2})\\s+ב?(${Object.keys(HEBREW_MONTHS).join('|')})\\s+(\\d{4})`, 'g');
const AT_TIME_RE = /(?:בשעה|בשעות|שעה)\s*(\d{1,2}:\d{2})(?:\s*(?:[-–]|עד)\s*(\d{1,2}:\d{2}))?/;
const BOOKING_HREF = /[?&](?:id|eventid|event_id|showid|show_id|performance|perf|occurrence|ticket)=([\w-]+)/i;
const BOOKING_TEXT = /רכישה|לרכישה|לרכישת כרטיסים|להזמנה|הזמנה|הזמנת כרטיסים|הרשמה|להרשמה|כרטיסים|קנה כרטיס|קנו כרטיסים|\b(?:buy|tickets?|register|book now)\b/i;
const MAX_OCCURRENCES = 40;
const MAX_DAYS_AHEAD = 365;

function textOf(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function datesIn(text: string, today: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(DATE_RE)) {
    const d = Number(m[1]), mo = Number(m[2]); if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    const y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : Number(today.slice(0, 4));
    let iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!m[3] && iso < today) iso = `${y + 1}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!Number.isNaN(new Date(iso + 'T00:00:00Z').getTime()) && iso >= today) out.add(iso);
  }
  return [...out];
}
const pad = (t: string) => { const [h, m] = t.split(':'); return `${h.padStart(2, '0')}:${m}`; };
function withinAhead(iso: string, today: string): boolean {
  const d = new Date(iso + 'T00:00:00Z').getTime(), t = new Date(today + 'T00:00:00Z').getTime();
  return !Number.isNaN(d) && d >= t && d - t <= MAX_DAYS_AHEAD * 86400000;
}

// textual dates in `text` with the time that follows each within ~40 chars
export function textualOccurrences(text: string, today: string): { date: string; start_time: string | null; end_time: string | null; evidence: string }[] {
  const out: { date: string; start_time: string | null; end_time: string | null; evidence: string }[] = [];
  for (const m of text.matchAll(TEXTUAL_DATE_RE)) {
    const d = Number(m[1]), mo = HEBREW_MONTHS[m[2]], y = Number(m[3]);
    if (!mo || d < 1 || d > 31) continue;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!withinAhead(iso, today)) continue;
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    const t = AT_TIME_RE.exec(after);
    out.push({ date: iso, start_time: t ? pad(t[1]) : null, end_time: t && t[2] ? pad(t[2]) : null, evidence: (m[0] + (t ? ' ' + t[0] : '')).trim() });
    if (out.length >= MAX_OCCURRENCES * 3) break;
  }
  return out;
}

// anchors that carry a dated performance: aria-label / text with a textual date; href = the
// performance's purchase link (?id=NNN) when it has a booking shape
function anchorOccurrences(html: string, today: string, baseUrl: string | null): Occurrence[] {
  const out: Occurrence[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,1500}?)<\/a>/gi)) {
    const attrs = m[1]; const inner = textOf(m[2]);
    const href = (/\shref=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    const aria = (/\saria-label=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    const title = (/\stitle=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    const text = [aria, title, inner].filter(Boolean).join(' ');
    const occ = textualOccurrences(text, today);
    if (!occ.length) continue;
    let abs: string | null = null; if (href && !/^(#|mailto:|tel:|javascript:)/i.test(href)) { try { abs = new URL(href, baseUrl || undefined).toString(); } catch { abs = null; } }
    const bm = abs ? BOOKING_HREF.exec(abs) : null;
    const isBooking = !!abs && (!!bm || BOOKING_TEXT.test(inner) || BOOKING_TEXT.test(aria));
    for (const o of occ.slice(0, 3)) out.push({ ...o, external_id: bm ? bm[1] : null, booking_url: isBooking ? abs : null, evidence: (aria || o.evidence).slice(0, 120) });
    if (out.length >= MAX_OCCURRENCES * 3) break;
  }
  return out;
}

// merged, deduped on date+time, sorted, capped; anchor evidence (booking link / id) wins over bare text
export function extractOccurrences(html: string, text: string, today: string, baseUrl: string | null): Occurrence[] {
  const byKey = new Map<string, Occurrence>();
  const put = (o: Occurrence) => {
    const k = `${o.date}|${o.start_time || ''}`;
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, o); return; }
    if (!prev.booking_url && o.booking_url) prev.booking_url = o.booking_url;
    if (!prev.external_id && o.external_id) prev.external_id = o.external_id;
    if (!prev.end_time && o.end_time) prev.end_time = o.end_time;
  };
  for (const o of anchorOccurrences(html, today, baseUrl)) put(o);
  for (const o of textualOccurrences(text, today)) {
    // a bare-text date at a time already known from an anchor is the same performance; a date with
    // no time is only kept when no timed occurrence of that date exists
    if (o.start_time == null && [...byKey.keys()].some((k) => k.startsWith(o.date + '|') && !k.endsWith('|'))) continue;
    put({ ...o, external_id: null, booking_url: null });
  }
  return [...byKey.values()].sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || ''))).slice(0, MAX_OCCURRENCES);
}

// --- price with tiers. "free" only when no positive amount exists and the free phrase is not the
// adult/companion tier ("מחיר לילד: 45 ש"ח, מבוגר ללא תשלום" is a 45 ₪ children's event).
const AMOUNT_RE = /(?:(ילד(?:ים)?|לילד(?:ים)?|מבוגר(?:ים)?|למבוגר(?:ים)?|מלווה|למלווה|תושב(?:ים)?|לתושב(?:ים)?|מנוי(?:ים)?|למנויים|כרטיס|מחיר|החל מ[־-]?|עלות)\s*:?\s*)?(?:₪\s*(\d{1,4})|(\d{1,4})\s*(?:₪|ש"ח|ש״ח|שח\b|שקל(?:ים)?))/g;
const FREE_RE = /חינם|בחינם|כניסה חופשית|ללא תשלום|ללא עלות/g;
const ADULT_WORDS = /(מבוגר|למבוגר|מבוגרים|מלווה|למלווה|מלווים|הורה|להורה)/;
const TIER_LABELS: Record<string, string> = { 'ילד': 'ילד', 'ילדים': 'ילד', 'לילד': 'ילד', 'לילדים': 'ילד', 'מבוגר': 'מבוגר', 'מבוגרים': 'מבוגר', 'למבוגר': 'מבוגר', 'למבוגרים': 'מבוגר', 'מלווה': 'מבוגר', 'למלווה': 'מבוגר', 'תושב': 'תושב', 'תושבים': 'תושב', 'לתושב': 'תושב', 'לתושבים': 'תושב', 'מנוי': 'מנוי', 'מנויים': 'מנוי', 'למנויים': 'מנוי' };
export function extractPriceTiers(text: string): DetailEvidence['price'] {
  const window = text.slice(0, 6000);
  const tiers: PriceTier[] = []; const evid: string[] = [];
  for (const m of window.matchAll(AMOUNT_RE)) {
    const amount = Number(m[2] || m[3]); if (!(amount > 0) || amount > 2000) continue;
    const rawLabel = (m[1] || '').replace(/[:\s]+$/, '').trim();
    const label = TIER_LABELS[rawLabel] || (rawLabel && /החל/.test(rawLabel) ? 'החל מ' : rawLabel || 'כרטיס');
    if (!tiers.some((t) => t.label === label && t.amount === amount)) { tiers.push({ label, amount }); evid.push(m[0].trim()); }
    if (tiers.length >= 8) break;
  }
  for (const m of window.matchAll(FREE_RE)) {
    const before = window.slice(Math.max(0, m.index! - 14), m.index!);
    if (ADULT_WORDS.test(before)) { if (!tiers.some((t) => t.label === 'מבוגר')) { tiers.push({ label: 'מבוגר', amount: 0 }); evid.push((before + m[0]).trim()); } }
    else if (!tiers.some((t) => t.label === 'חינם')) { tiers.push({ label: 'חינם', amount: 0 }); evid.push(m[0]); }
  }
  const positive = tiers.filter((t) => t.amount > 0);
  if (!positive.length) {
    if (tiers.some((t) => t.label === 'חינם')) return { price_type: 'free', price_amount: 0, tiers, evidence: evid.join(' | ') };
    return null;
  }
  const child = positive.find((t) => t.label === 'ילד') || positive.find((t) => t.label === 'החל מ') || positive.reduce((a, b) => (b.amount < a.amount ? b : a));
  return { price_type: 'fixed', price_amount: child.amount, tiers, evidence: evid.join(' | ') };
}

// --- street address: "רחוב X 12", or "<street words> 12[ א]" right before the known city
export function extractAddressCandidates(text: string, city: string | null): string[] {
  const out: string[] = [];
  const a = new RegExp(`${STREET_WORDS}\\s+([\\u0590-\\u05FF"'׳״\\-\\s]{2,40}?)\\s+(\\d{1,4})(?:\\s?([א-ת])(?![\\u0590-\\u05FF]))?`, 'u').exec(text);
  if (a) out.push(`${a[1].trim()} ${a[2]}${a[3] ? ' ' + a[3] : ''}`);
  if (city) {
    const c = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
    const re = new RegExp(`([\\u0590-\\u05FF"'׳״\\-]{2,25}(?:\\s[\\u0590-\\u05FF"'׳״\\-]{2,25}){0,2})\\s+(\\d{1,4})(?:\\s?([א-ת])(?![\\u0590-\\u05FF]))?(?:\\s*,\\s*|\\s+)${c}(?![\\u0590-\\u05FF])`, 'gu');
    for (const m of text.matchAll(re)) {
      // drop leading words that are clearly a place name ("המשכן למוסיקה") only when a comma preceded
      const street = m[1].trim();
      const cand = `${street} ${m[2]}${m[3] ? ' ' + m[3] : ''}`;
      if (!out.includes(cand)) out.push(cand);
      if (out.length >= 5) break;
    }
  }
  return out.filter((s) => isSinglePlace(s));
}

// explicit EVENT-level booking action (a link whose text is a booking verb and that is not one of the
// per-performance links) - the detail page URL itself never qualifies
function eventLevelBookingUrl(html: string, baseUrl: string | null, occurrenceUrls: Set<string>): string | null {
  const found: string[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi)) {
    const href = (/\shref=["']([^"']+)["']/i.exec(m[1]) || [])[1] || ''; if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    const inner = textOf(m[2]); const aria = (/\saria-label=["']([^"']+)["']/i.exec(m[1]) || [])[1] || '';
    if (!BOOKING_TEXT.test(inner) && !BOOKING_TEXT.test(aria)) continue;
    let abs: string; try { abs = new URL(href, baseUrl || undefined).toString(); } catch { continue; }
    if (occurrenceUrls.has(abs)) continue;
    if (baseUrl && abs.split('#')[0] === baseUrl.split('#')[0]) continue;
    if (!found.includes(abs)) found.push(abs);
  }
  return found.length === 1 ? found[0] : null; // several distinct booking links = ambiguous, not event-level
}

export function extractDetailEvidence(html: string, today: string, opts: { baseUrl?: string | null; city?: string | null } = {}): DetailEvidence {
  const blocks: string[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) blocks.push(m[1]);
  const events = parseJsonLdEvents(blocks);
  const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1]?.trim() || '';
  const heading = textOf((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || '');
  const text = textOf(html).slice(0, 12000);
  const addrs = extractAddressCandidates(text, opts.city || null);
  const dates = datesIn(text.slice(0, 3000), today);
  const t = TIME_RE.exec(text.slice(0, 3000));
  const a = AGE_RE.exec(text);
  const occurrences = extractOccurrences(html, text, today, opts.baseUrl || null);
  const occUrls = new Set(occurrences.map((o) => o.booking_url).filter(Boolean) as string[]);
  const lower = text.toLowerCase();
  return {
    events, ogImage: og ? og[1] : null, addressText: addrs[0] || null,
    date: occurrences.length === 1 ? occurrences[0].date : (occurrences.length ? null : (dates.length === 1 ? dates[0] : null)),
    time: occurrences.length === 1 && occurrences[0].start_time ? occurrences[0].start_time : (t ? `${t[1].padStart(2, '0')}:${t[2]}` : null),
    // RTL sites write ranges backwards ("לגילאי 4 -2"): the smaller number is always the minimum
    ages: a ? { min_age: a[2] ? Math.min(Number(a[1]), Number(a[2])) : Number(a[1]), max_age: a[2] ? Math.max(Number(a[1]), Number(a[2])) : null, evidence: a[0] } : (/גיל הרך|לפעוטות|קטנטנים/.test(text) ? { min_age: 0, max_age: 5, evidence: 'גיל הרך' } : null),
    price: extractPriceTiers(text), occurrences,
    registrationUrl: eventLevelBookingUrl(html, opts.baseUrl || null, occUrls),
    childMarkers: CHILD.filter((w) => lower.includes(w)).length, adultMarkers: ADULT.filter((w) => lower.includes(w)).length, title, heading,
  };
}

// the fetched page must name the candidate (title / h1) before its evidence is trusted
export function detailPageNamesCandidate(ev: Pick<DetailEvidence, 'title' | 'heading'>, name: string | null | undefined): boolean {
  return Math.max(containsScore(ev.title, name), containsScore(ev.heading, name)) >= 0.7;
}

// fill-null merge into the listing candidate; returns the fields filled (never overwrites scalars).
// Occurrences: the detail page's dated performances become candidate.occurrences (each with its own
// time); a listing-side date is kept and joined. A listing-side 'recurring' misread is converted to
// dated occurrences only when the page names >= 2 explicit performances.
// deno-lint-ignore no-explicit-any
export function applyDetailEvidence(candidate: Record<string, any>, ev: DetailEvidence, detailUrl: string, pageHost: string): string[] {
  const filled: string[] = [];
  const ld = applyJsonLdToCandidate(candidate, ev.events); if (ld.length) filled.push(...ld.map((f) => 'jsonld:' + f));
  if (!candidate.address && ev.addressText && isSinglePlace(ev.addressText)) { candidate.address = ev.addressText; candidate.address_source = 'monster:detail'; filled.push('address'); }
  if (ev.occurrences.length) {
    const own: Occurrence[] = Array.isArray(candidate.occurrences) ? candidate.occurrences : [];
    if (!own.length && candidate.schedule_type === 'one_time' && candidate.one_time_date) own.push({ date: candidate.one_time_date, start_time: candidate.start_time ? String(candidate.start_time).slice(0, 5) : null, end_time: candidate.end_time ? String(candidate.end_time).slice(0, 5) : null, external_id: null, booking_url: null, evidence: 'listing' });
    const seen = new Set(own.map((o) => `${o.date}|${o.start_time || ''}`));
    let added = 0;
    for (const o of ev.occurrences) { const k = `${o.date}|${o.start_time || ''}`; if (seen.has(k)) { const p = own.find((x) => `${x.date}|${x.start_time || ''}` === k)!; if (!p.booking_url && o.booking_url) p.booking_url = o.booking_url; if (!p.external_id && o.external_id) p.external_id = o.external_id; continue; } seen.add(k); own.push(o); added++; }
    own.sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || '')));
    const explicit = ev.occurrences.length >= 2;
    if (candidate.schedule_type === 'recurring' && explicit) { candidate.schedule_type = 'one_time'; candidate.recurring_days = []; filled.push('schedule_type'); }
    // a list of dated, individually ticketed performances is an EVENT, not a class/course - the listing's
    // "פעילות" (commitment policy: archived) or "אירוע_קבוע" label is contradicted by the page itself
    if (explicit && (candidate.entity_type === 'פעילות' || candidate.entity_type === 'אירוע_קבוע')) { candidate.entity_type = 'אירוע'; filled.push('entity_type'); }
    if (candidate.schedule_type === 'one_time' || !candidate.schedule_type) {
      if (!candidate.schedule_type) candidate.schedule_type = 'one_time';
      candidate.occurrences = own.slice(0, MAX_OCCURRENCES);
      if (added) filled.push('occurrences');
      const first = candidate.occurrences[0];
      if (!candidate.one_time_date && first) { candidate.one_time_date = first.date; filled.push('one_time_date'); }
      if (!candidate.start_time && first?.start_time) { candidate.start_time = first.start_time; filled.push('start_time'); }
    }
  } else {
    if (candidate.schedule_type === 'one_time' && !candidate.one_time_date && ev.date) { candidate.one_time_date = ev.date; filled.push('one_time_date'); }
    if (candidate.schedule_type === 'one_time' && !candidate.start_time && ev.time) { candidate.start_time = ev.time; filled.push('start_time'); }
  }
  if (ev.ages && candidate.min_age == null && ev.ages.min_age <= 18) { candidate.min_age = ev.ages.min_age; if (candidate.max_age == null && ev.ages.max_age != null) candidate.max_age = ev.ages.max_age; filled.push('ages'); if (!candidate.audience || candidate.audience === 'unknown') { candidate.audience = ev.ages.max_age != null && ev.ages.max_age <= 12 ? 'children' : 'family'; filled.push('audience'); } }
  else if ((!candidate.audience || candidate.audience === 'unknown') && ev.childMarkers >= 2 && ev.adultMarkers === 0) { candidate.audience = 'family'; filled.push('audience'); }
  if (ev.price) {
    if (!candidate.price_type || (candidate.price_type === 'fixed' && candidate.price_amount == null)) {
      candidate.price_type = ev.price.price_type; candidate.price_amount = ev.price.price_amount; filled.push('price');
    }
    if (!candidate.price_evidence && ev.price.tiers.length) candidate.price_evidence = { tiers: ev.price.tiers, evidence: ev.price.evidence, detail_url: detailUrl };
  }
  // event-level booking action only; the detail page itself is provenance, never registration_url
  if (!candidate.registration_url && ev.registrationUrl && ev.registrationUrl.split('#')[0] !== detailUrl.split('#')[0]) { candidate.registration_url = ev.registrationUrl; filled.push('registration_url'); }
  if ((!Array.isArray(candidate.image_urls) || candidate.image_urls.length === 0) && ev.ogImage) {
    let abs = ev.ogImage; try { abs = new URL(ev.ogImage, detailUrl).toString(); } catch { /* keep */ }
    if (!/logo|icon|sprite|placeholder|\.svg/i.test(abs)) { candidate.image_urls = [abs]; let host = ''; try { host = new URL(abs).hostname.replace(/^www\./, ''); } catch { /* none */ } candidate.images = [{ url: abs, source_type: host === pageHost ? 'ORIGINAL_SOURCE' : 'EXTERNAL_SOURCE', needs_rights_review: host !== pageHost }]; filled.push('image'); }
  }
  if (filled.length) { candidate.detail_url = detailUrl; candidate.detail_filled = filled; }
  else if (!candidate.detail_url) candidate.detail_url = detailUrl; // the page was read even if it added nothing: provenance
  return filled;
}
