import { assertEquals, assert } from 'jsr:@std/assert@1';
import { fillDateTemplates, getPath, renderJsonItems } from './adapters.ts';
import { splitTextForExtraction, PAGE_TEXT_CHAR_LIMIT, ITEM_DELIMITER } from './extraction.ts';

Deno.test('fillDateTemplates replaces {{today}} / {{today+N}} inside nested request bodies', () => {
  const now = new Date('2026-09-13T10:00:00Z');
  const out = fillDateTemplates({ StartDate: '{{today}}', EndDate: '{{today+60}}', nested: ['{{today-1}}', 5], keep: 'x' }, now) as Record<string, unknown>;
  assertEquals(out.StartDate, '2026-09-13');
  assertEquals(out.EndDate, '2026-11-12');
  assertEquals(out.nested, ['2026-09-12', 5]);
  assertEquals(out.keep, 'x');
});

Deno.test('getPath resolves dot paths and treats empty path as the root', () => {
  const j = { result: { items: [1, 2] } };
  assertEquals(getPath(j, 'result.items'), [1, 2]);
  assertEquals(getPath(j, ''), j);
  assertEquals(getPath(j, 'result.missing.x'), undefined);
});

Deno.test('renderJsonItems: sharepoint Fields[] items become labelled lines, html stripped, fields ordered/filtered', () => {
  const items = [{ Fields: [
    { InternalName: 'Title', Value: 'שעת סיפור' },
    { InternalName: 'TlvMainPicture', Value: '<img src="/x.jpg">' },
    { InternalName: 'TlvStartDate', Value: '20.09.26, 17:00' },
    { InternalName: 'TlvSummary', Value: '<p>סיפור&nbsp;לילדים</p>' },
    { InternalName: 'Empty', Value: '' },
  ] }];
  const text = renderJsonItems(items, { fields_mode: 'sharepoint_fields', fields: ['Title', 'TlvStartDate', 'TlvSummary'], labels: { Title: 'שם' } });
  assertEquals(text, 'שם: שעת סיפור\nTlvStartDate: 20.09.26, 17:00\nTlvSummary: סיפור לילדים');
});

Deno.test('renderJsonItems: object items, item_url template, max_items', () => {
  const items = [{ id: 7, name: 'סדנה', meta: { a: 1 } }, { id: 8, name: 'הצגה' }];
  const text = renderJsonItems(items, { fields_mode: 'object', item_url: { field: 'id', template: 'https://x.il/e/{value}' }, max_items: 1 });
  assertEquals(text, 'id: 7\nname: סדנה\nmeta: {"a":1}\nקישור: https://x.il/e/7');
});

Deno.test('splitTextForExtraction: short text is one window; long text splits on line boundaries up to maxChunks', () => {
  assertEquals(splitTextForExtraction('abc'), ['abc']);
  const line = 'x'.repeat(999) + '\n';
  const long = line.repeat(100); // 100k chars
  const windows = splitTextForExtraction(long, PAGE_TEXT_CHAR_LIMIT, 4);
  assertEquals(windows.length, 4);
  for (const w of windows) assert(w.length <= PAGE_TEXT_CHAR_LIMIT);
  assert(windows[0].endsWith('x'), 'cut on a line boundary, no dangling newline');
  assertEquals(windows.join('').replace(/\n/g, '').length, 4 * 18 * 999);
});

// HTML EXTRACTION BOUNDARY PRESERVATION (2026-09-22). The DOM-level half of this change is pinned by
// the Node twin's tests (tools/import-tool/tests/htmlText.test.js - cheerio fixtures); these pin the
// pure-string chunking half, which is what actually decides whether a window edge can fall inside an
// event card and separate it from its own schedule (the confirmed Gulliver failure).
Deno.test('splitTextForExtraction: a window boundary prefers an ITEM delimiter over cutting inside an item', () => {
  const card = (i: number) => `כרטיס ${i}\nשעה: 1${i % 10}:00\nמחיר: ${10 + i} ש"ח`;
  const text = Array.from({ length: 60 }, (_, i) => card(i)).join(ITEM_DELIMITER);
  const limit = 400;
  const chunks = splitTextForExtraction(text, limit, 99);
  for (const c of chunks) assert(c.length <= limit, 'window respects the limit');
  for (const c of chunks) {
    assert(/^כרטיס \d+/.test(c.trim()), `chunk starts at an item boundary: ${JSON.stringify(c.slice(0, 30))}`);
    assert(/ש"ח$/.test(c.trim()), `chunk ends at an item boundary: ${JSON.stringify(c.slice(-20))}`);
  }
  assertEquals(chunks.filter((c) => c.length === limit).length, 0, 'no hard-limit fallback while item delimiters exist');
});

Deno.test('splitTextForExtraction: hard cut is a last resort, only for a single item larger than the window', () => {
  const oversized = 'z'.repeat(2500);
  const hard = splitTextForExtraction(oversized, 1000, 99);
  assertEquals(hard[0].length, 1000, 'one oversized item still splits somewhere');
  assertEquals(hard.join('').length, 2500, 'the fallback loses nothing');
});

import { cheapPageText } from './extraction.ts';

Deno.test('page text keeps content wrapped in <form> (SharePoint/WebForms sites) and drops only controls/boilerplate', () => {
  const html = '<html><body><header>תפריט</header><form id="aspnetForm"><input type="hidden" name="__VIEWSTATE"><div>שעת סיפור 15/09/2026 מדיטק חולון</div><select><option>x</option></select><button>שלח</button></form><footer>פוטר</footer></body></html>';
  // the DOM path uses the same selector list (input/select/textarea/button, never form) - see extraction.ts
  const cheap = cheapPageText(html);
  assert(cheap.includes('שעת סיפור 15/09/2026 מדיטק חולון') && !cheap.includes('תפריט') && !cheap.includes('פוטר'), `cheap path: ${cheap}`);
});
