// Mirror test: the Node adapter (relay path) must render exactly what the Deno adapter renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fillDateTemplates, getPath, renderJsonItems } = require('../jsonApiAdapter');

test('fillDateTemplates mirrors the Deno implementation', () => {
  const now = new Date('2026-09-13T10:00:00Z');
  assert.deepEqual(fillDateTemplates({ a: '{{today}}', b: '{{today+60}}', c: ['{{today-1}}', 5] }, now), { a: '2026-09-13', b: '2026-11-12', c: ['2026-09-12', 5] });
});

test('getPath resolves dot paths, empty = root', () => {
  const j = { result: { items: [1] } };
  assert.deepEqual(getPath(j, 'result.items'), [1]);
  assert.equal(getPath(j, ''), j);
});

test('renderJsonItems mirrors the Deno rendering (sharepoint fields + object mode)', () => {
  const sp = [{ Fields: [{ InternalName: 'Title', Value: 'שעת סיפור' }, { InternalName: 'TlvMainPicture', Value: '<img src="/x.jpg">' }, { InternalName: 'TlvStartDate', Value: '20.09.26, 17:00' }, { InternalName: 'TlvSummary', Value: '<p>סיפור&nbsp;לילדים</p>' }, { InternalName: 'Empty', Value: '' }] }];
  assert.equal(renderJsonItems(sp, { fields_mode: 'sharepoint_fields', fields: ['Title', 'TlvStartDate', 'TlvSummary'], labels: { Title: 'שם' } }), 'שם: שעת סיפור\nTlvStartDate: 20.09.26, 17:00\nTlvSummary: סיפור לילדים');
  const obj = [{ id: 7, name: 'סדנה', meta: { a: 1 } }, { id: 8, name: 'הצגה' }];
  assert.equal(renderJsonItems(obj, { fields_mode: 'object', item_url: { field: 'id', template: 'https://x.il/e/{value}' }, max_items: 1 }), 'id: 7\nname: סדנה\nmeta: {"a":1}\nקישור: https://x.il/e/7');
});
