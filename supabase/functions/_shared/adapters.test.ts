import { assertEquals, assert } from 'jsr:@std/assert@1';
import { fillDateTemplates, getPath, renderJsonItems } from './adapters.ts';
import { splitTextForExtraction, PAGE_TEXT_CHAR_LIMIT } from './extraction.ts';

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
