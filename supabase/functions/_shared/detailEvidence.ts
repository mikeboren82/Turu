// TuRu - evidence from an event's DETAIL page for THE MONSTER (scan-source detail traversal).
// Deterministic only - no AI call per detail page: JSON-LD Event (address / geo / date / time /
// audience), og:image, Hebrew street-address text, an explicit age range, a price, and (via
// applyDetailEvidence) a fill-null merge into the listing candidate. Stronger data wins: nothing the
// listing extraction already found is overwritten; every filled field is named in
// candidate.detail_filled and the page in candidate.detail_url.
import { parseJsonLdEvents, applyJsonLdToCandidate, isSinglePlace, type JsonLdEvent } from './jsonld.ts';

export interface DetailEvidence {
  events: JsonLdEvent[]; ogImage: string | null; addressText: string | null; date: string | null; time: string | null;
  ages: { min_age: number; max_age: number | null; evidence: string } | null; price: { price_type: 'free' | 'fixed'; price_amount: number | null; evidence: string } | null;
  childMarkers: number; adultMarkers: number; title: string;
}

const STREET_WORDS = '(?:רחוב|רח\'|רח׳|שדרות|שד\'|שד׳|דרך|כיכר|סמטת)';
const CHILD = ['ילדים', 'לילד', 'פעוט', 'תינוק', 'משפחה', 'משפחות', 'גיל הרך', 'שעת סיפור', 'קטנטנים', 'לכל המשפחה', 'גילאי', 'נוער', 'הצגת ילדים'];
const ADULT = ['הרצאה', 'סטנדאפ', 'מנוי', 'גיל הזהב', 'ותיקים', 'גמלאים', 'למבוגרים בלבד', '18+', 'ערב נשים', 'טעימות יין'];
const DATE_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g;
const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const AGE_RE = /(?:גילאי|לגילאי|לגיל|גיל|בני)\s*(\d{1,2})\s*(?:[-–עד]+\s*(\d{1,2}))?\s*(\+)?/;
const PRICE_RE = /(?:₪\s*(\d{1,4})|(\d{1,4})\s*(?:₪|ש"ח|ש״ח|שח))/;

function textOf(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
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

export function extractDetailEvidence(html: string, today: string): DetailEvidence {
  const blocks: string[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) blocks.push(m[1]);
  const events = parseJsonLdEvents(blocks);
  const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1]?.trim() || '';
  const text = textOf(html).slice(0, 12000);
  const addr = new RegExp(`${STREET_WORDS}\\s+([\\u0590-\\u05FF"'׳״\\-\\s]{2,40}?)\\s+(\\d{1,4})`, 'u').exec(text);
  const dates = datesIn(text.slice(0, 3000), today);
  const t = TIME_RE.exec(text.slice(0, 3000));
  const a = AGE_RE.exec(text);
  const p = /חינם|כניסה חופשית|ללא תשלום/.test(text.slice(0, 4000)) ? { price_type: 'free' as const, price_amount: 0, evidence: 'חינם' } : (() => { const m = PRICE_RE.exec(text.slice(0, 4000)); return m ? { price_type: 'fixed' as const, price_amount: Number(m[1] || m[2]), evidence: m[0] } : null; })();
  const lower = text.toLowerCase();
  return {
    events, ogImage: og ? og[1] : null, addressText: addr ? `${addr[1].trim()} ${addr[2]}` : null, date: dates.length === 1 ? dates[0] : null, time: t ? `${t[1].padStart(2, '0')}:${t[2]}` : null,
    ages: a ? { min_age: Number(a[1]), max_age: a[2] ? Number(a[2]) : null, evidence: a[0] } : (/גיל הרך|לפעוטות|קטנטנים/.test(text) ? { min_age: 0, max_age: 5, evidence: 'גיל הרך' } : null),
    price: p, childMarkers: CHILD.filter((w) => lower.includes(w)).length, adultMarkers: ADULT.filter((w) => lower.includes(w)).length, title,
  };
}

// fill-null merge into the listing candidate; returns the fields filled (never overwrites)
// deno-lint-ignore no-explicit-any
export function applyDetailEvidence(candidate: Record<string, any>, ev: DetailEvidence, detailUrl: string, pageHost: string): string[] {
  const filled: string[] = [];
  const ld = applyJsonLdToCandidate(candidate, ev.events); if (ld.length) filled.push(...ld.map((f) => 'jsonld:' + f));
  if (!candidate.address && ev.addressText && isSinglePlace(ev.addressText)) { candidate.address = ev.addressText; filled.push('address'); }
  if (candidate.schedule_type === 'one_time' && !candidate.one_time_date && ev.date) { candidate.one_time_date = ev.date; filled.push('one_time_date'); }
  if (candidate.schedule_type === 'one_time' && !candidate.start_time && ev.time) { candidate.start_time = ev.time; filled.push('start_time'); }
  if (ev.ages && candidate.min_age == null && ev.ages.min_age <= 18) { candidate.min_age = ev.ages.min_age; if (candidate.max_age == null && ev.ages.max_age != null) candidate.max_age = ev.ages.max_age; filled.push('ages'); if (!candidate.audience || candidate.audience === 'unknown') { candidate.audience = ev.ages.max_age != null && ev.ages.max_age <= 12 ? 'children' : 'family'; filled.push('audience'); } }
  else if ((!candidate.audience || candidate.audience === 'unknown') && ev.childMarkers >= 2 && ev.adultMarkers === 0) { candidate.audience = 'family'; filled.push('audience'); }
  if (!candidate.price_type && ev.price) { candidate.price_type = ev.price.price_type; if (candidate.price_amount == null) candidate.price_amount = ev.price.price_amount; filled.push('price'); }
  if ((!Array.isArray(candidate.image_urls) || candidate.image_urls.length === 0) && ev.ogImage) {
    let abs = ev.ogImage; try { abs = new URL(ev.ogImage, detailUrl).toString(); } catch { /* keep */ }
    if (!/logo|icon|sprite|placeholder|\.svg/i.test(abs)) { candidate.image_urls = [abs]; let host = ''; try { host = new URL(abs).hostname.replace(/^www\./, ''); } catch { /* none */ } candidate.images = [{ url: abs, source_type: host === pageHost ? 'ORIGINAL_SOURCE' : 'EXTERNAL_SOURCE', needs_rights_review: host !== pageHost }]; filled.push('image'); }
  }
  if (filled.length) { candidate.detail_url = detailUrl; candidate.detail_filled = filled; }
  return filled;
}
