// TuRu - Node twin of supabase/functions/_shared/extraction.ts#pageTextForExtraction /
// splitTextForExtraction (HTML EXTRACTION BOUNDARY PRESERVATION, 2026-09-22). Deno cannot require()
// this CommonJS module, so the algorithm is duplicated deliberately - the same arrangement as
// cityNaming.js/.ts and granularity.js/.ts. THE TWO FILES MUST STAY BEHAVIOURALLY IDENTICAL:
// tests/htmlText.test.js pins the shapes the Deno twin's comment describes.
//
// WHY (proven by the 2026-09-22 forensic, not inferred): `$('body').text()` concatenates adjacent DOM
// text nodes with ZERO delimiter, so two sibling event cards flatten to
// "גוליבר10:00-11:00ילדי בית העץ10:30". Once that boundary is gone neither the chunker nor the model
// can recover it - the Holon calendar's Gulliver row was given the NEXT event's 10:30 start time and
// its 85₪ price. splitTextForExtraction could only cut on '\n', and the flattened text had none, so it
// fell back to a hard mid-token cut that separated Gulliver from its own schedule entirely.
//
// Two levels of boundary are restored:
//   FIELD/BLOCK -> a newline after every block element
//   EVENT/ITEM  -> ITEM_DELIMITER after every element matching an OPTIONAL source-configured
//                  adapter_config.item_selector (never guessed from markup here)
// Inline elements get a trailing SPACE so <span>a</span><span>b</span> never becomes "ab".

const PAGE_TEXT_CHAR_LIMIT = 18000;
const MAX_TEXT_CHUNKS = 4;

const STRIP_SELECTOR = 'script, style, noscript, nav, footer, header, svg, input, select, textarea, button';
const INLINE_SELECTOR = 'span, a, b, strong, em, i, small, label, td, th';
const BLOCK_SELECTOR = 'address, article, aside, blockquote, dd, div, dl, dt, fieldset, figcaption, figure, form, h1, h2, h3, h4, h5, h6, hr, li, main, ol, p, pre, section, table, tbody, tfoot, thead, tr, ul';
// the repo's EXISTING item-boundary convention (jsonApiAdapter output / relay-scan.js splits on it)
const ITEM_DELIMITER = '\n---\n';

// $ is an already-loaded cheerio instance (same library in both runtimes).
function pageTextForExtraction($, limit = PAGE_TEXT_CHAR_LIMIT, opts = {}) {
  // Never remove <form> itself: ASP.NET WebForms / SharePoint municipalities wrap the whole body in one.
  $(STRIP_SELECTOR).remove();
  $('br').replaceWith('\n');
  $(INLINE_SELECTOR).each((_, el) => { $(el).append(' '); });
  $(BLOCK_SELECTOR).each((_, el) => { $(el).append('\n'); });
  if (opts.itemSelector) {
    // a malformed/unmatched selector must never break a scan - generic block boundaries still apply
    try { $(opts.itemSelector).each((_, el) => { $(el).append(ITEM_DELIMITER); }); } catch { /* ignore */ }
  }
  return $('body').text()
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, limit);
}

// Boundary preference: an ITEM delimiter first, then any line boundary, and a hard character cut only
// as a last resort (a single item longer than the window must still split somewhere). A chunk whose
// length === limit IS that hard fallback - dry runs count those.
function splitTextForExtraction(text, limit = PAGE_TEXT_CHAR_LIMIT, maxChunks = MAX_TEXT_CHUNKS) {
  const chunks = [];
  let rest = text;
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= limit) { chunks.push(rest); break; }
    let cut = rest.lastIndexOf(ITEM_DELIMITER, limit);
    let skip = ITEM_DELIMITER.length;
    if (cut < limit * 0.5) { cut = rest.lastIndexOf('\n', limit); skip = 1; }
    if (cut < limit * 0.5) { cut = limit; skip = 0; }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip).trimStart();
  }
  return chunks;
}

module.exports = {
  pageTextForExtraction, splitTextForExtraction,
  PAGE_TEXT_CHAR_LIMIT, MAX_TEXT_CHUNKS, ITEM_DELIMITER,
  STRIP_SELECTOR, INLINE_SELECTOR, BLOCK_SELECTOR,
};
