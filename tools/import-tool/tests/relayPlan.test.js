const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../lib/relayPlan');
const { ITEM_DELIMITER, splitTextForExtraction } = require('../lib/htmlText');

const card = (i, len = 1400) => `כרטיס ${i} | מועד 28/09/26 10:30 | ` + 'x'.repeat(Math.max(0, len - 40)) + ` | סוף ${i}`;
const page = (n, len) => Array.from({ length: n }, (_, i) => card(i, len)).join(ITEM_DELIMITER);
const whole = (parts, n) => { for (let i = 0; i < n; i++) { const hits = parts.filter((p) => p.includes(`כרטיס ${i} |`)); assert.equal(hits.length, 1, `card ${i} in exactly one part`); assert.ok(hits[0].includes(`סוף ${i}`), `card ${i} not split`); } };

test('>72k relay page: every complete card is sent, none split, no part over the window', () => {
  const text = page(64, 1266); // ~81k chars, the live Holon shape
  assert.ok(text.length > 72000);
  const r = plan.packItemsIntoParts(text);
  assert.equal(r.items, 64);
  whole(r.parts, 64);
  assert.ok(r.parts.every((p) => p.length <= plan.PART_CHAR_LIMIT));
  assert.equal(r.hardSplits, 0);
  assert.equal(r.oversizedItems, 0);
});

test('many complete items: a card that does not fit the current part starts the next one (never split for budget)', () => {
  const text = [card(0, 4000), card(1, 15000), card(2, 3000)].join(ITEM_DELIMITER);
  const r = plan.packItemsIntoParts(text);
  whole(r.parts, 3);
  assert.equal(r.parts.length, 3);
  // the old relay splitter (item delimiter only when >= half a window, else newline, else hard cut) cut card 1 in two
  const old = splitTextForExtraction(text, 18000, Infinity);
  assert.equal(old.filter((p) => p.includes('כרטיס 1 |') && p.includes('סוף 1')).length, 0);
});

test('oversized single card: split on newlines only for that card, neighbours stay whole', () => {
  const big = 'כרטיס 1 | ' + Array.from({ length: 400 }, (_, i) => `שורה ${i} ` + 'y'.repeat(90)).join('\n') + ' | סוף 1';
  const text = [card(0, 2000), big, card(2, 2000)].join(ITEM_DELIMITER);
  const r = plan.packItemsIntoParts(text);
  assert.equal(r.oversizedItems, 1);
  assert.equal(r.hardSplits, 0);
  assert.ok(r.parts.every((p) => p.length <= plan.PART_CHAR_LIMIT));
  for (const i of [0, 2]) assert.equal(r.parts.filter((p) => p.includes(`כרטיס ${i} |`) && p.includes(`סוף ${i}`)).length, 1);
});

test('oversized card without newlines falls back to counted hard splits', () => {
  const r = plan.packItemsIntoParts('z'.repeat(40000));
  assert.equal(r.oversizedItems, 1);
  assert.equal(r.hardSplits, 2);
  assert.equal(r.parts.join('').length, 40000);
});

test('text without item delimiters behaves as one item (newline split, nothing dropped)', () => {
  const text = Array.from({ length: 900 }, (_, i) => `line ${i} ` + 'w'.repeat(100)).join('\n');
  const r = plan.packItemsIntoParts(text);
  assert.equal(r.items, 1);
  assert.equal(r.parts.join('\n').length, text.length);
});

test('explicit safety ceiling: parts beyond the cap are reported, never silent', () => {
  const parts = Array.from({ length: 15 }, (_, i) => ({ url: `u#part=${i + 1}`, text: [card(i * 2), card(i * 2 + 1)].join(ITEM_DELIMITER) }));
  const { kept, ceiling } = plan.applyPartCeiling(parts, 12);
  assert.equal(kept.length, 12);
  assert.equal(ceiling.reason, 'relay_part_ceiling');
  assert.deepEqual([ceiling.partsTotal, ceiling.partsDropped, ceiling.itemsTotal, ceiling.itemsSent, ceiling.itemsDropped], [15, 3, 30, 24, 6]);
  assert.equal(ceiling.charsDropped, parts.slice(12).reduce((n, p) => n + p.text.length, 0));
  assert.equal(plan.applyPartCeiling(parts.slice(0, 5), 12).ceiling, null);
});

test('ordering: deferred (old / never fetched) parts go before a part 1 extracted yesterday; unchanged parts last', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const parts = ['p1', 'p2', 'p3', 'p4'].map((u) => ({ url: u, hash: `${u}-new` }));
  const snaps = [
    { url: 'p1', content_hash: 'p1-old', last_fetched_at: new Date(now - 86400000).toISOString() },
    { url: 'p2', content_hash: 'p2-old', last_fetched_at: new Date(now - 5 * 86400000).toISOString() },
    { url: 'p4', content_hash: 'p4-new', last_fetched_at: new Date(now - 3600000).toISOString() },
  ];
  assert.deepEqual(plan.orderPartsForRelay(parts, snaps).map((p) => `${p.url}:${p.state}`), ['p3:pending', 'p2:pending', 'p1:pending', 'p4:unchanged']);
});

test('no starvation: part 1 changes daily and a scan extracts one part per run - parts 2-3 still get extracted', () => {
  // naive order (the old relay) always spends the budget on part 1
  const simulate = (useNewOrder) => {
    const snaps = new Map();
    const extracted = new Set();
    for (let day = 0; day < 4; day++) {
      const parts = [{ url: 'p1', hash: `p1-d${day}` }, { url: 'p2', hash: 'p2' }, { url: 'p3', hash: 'p3' }];
      const ordered = useNewOrder ? plan.orderPartsForRelay(parts, [...snaps.values()]) : parts.map((p) => ({ ...p, state: snaps.get(p.url)?.content_hash === p.hash ? 'unchanged' : 'pending' }));
      const first = ordered.find((p) => p.state === 'pending'); // budget: one extraction per run
      if (first) { snaps.set(first.url, { url: first.url, content_hash: first.hash, last_fetched_at: new Date(Date.UTC(2026, 8, 20 + day)).toISOString() }); extracted.add(first.url); }
    }
    return extracted;
  };
  assert.deepEqual([...simulate(false)].sort(), ['p1']);
  assert.deepEqual([...simulate(true)].sort(), ['p1', 'p2', 'p3']);
});

test('processedUrls: only parts whose OWN hash was stored at/after this invocation count as processed', () => {
  const since = '2026-09-24T10:00:00Z';
  const parts = [{ url: 'a', hash: 'h1' }, { url: 'b', hash: 'h2' }, { url: 'c', hash: 'h3' }];
  const snaps = [
    { url: 'a', content_hash: 'h1', last_fetched_at: '2026-09-24T10:00:30Z' },
    { url: 'b', content_hash: 'h2', last_fetched_at: '2026-09-23T10:00:00Z' }, // stale: deferred
    { url: 'c', content_hash: 'OLD', last_fetched_at: '2026-09-24T10:00:40Z' }, // other content
  ];
  assert.deepEqual([...plan.processedUrls(parts, snaps, since)], ['a']);
});

test('detail pages ride with the batch holding their listing part', () => {
  const listing = [{ url: 'L#part=1' }, { url: 'L#part=2' }, { url: 'M' }];
  const details = [{ url: 'd1', kind: 'detail', parent_url: 'L' }, { url: 'd2', kind: 'detail', parent_url: 'M' }];
  const b = plan.batchParts(listing, details, 2);
  assert.deepEqual(b.map((x) => x.map((p) => p.url)), [['L#part=1', 'L#part=2', 'd1'], ['M', 'd2']]);
});

test('run verdict: COMPLETE / PARTIAL / FAILED', () => {
  const base = { plannedParts: 5, confirmedParts: 5, submittedBatches: 2, failedBatch: null, ceiling: null, waitTimedOut: false };
  assert.equal(plan.classifyRun(base), 'COMPLETE');
  assert.equal(plan.classifyRun({ ...base, confirmedParts: 3 }), 'PARTIAL');
  assert.equal(plan.classifyRun({ ...base, failedBatch: { index: 3 } }), 'PARTIAL');
  assert.equal(plan.classifyRun({ ...base, ceiling: { itemsDropped: 2 } }), 'PARTIAL');
  assert.equal(plan.classifyRun({ ...base, waitTimedOut: true }), 'PARTIAL');
  assert.equal(plan.classifyRun({ ...base, submittedBatches: 0, confirmedParts: 0, failedBatch: { index: 1 } }), 'FAILED');
  assert.equal(plan.classifyRun({ ...base, plannedParts: 0 }), 'FAILED');
});

test('next scan: PARTIAL with progress retries at the relay cadence; otherwise the normal cadence stands', () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  assert.equal(plan.nextScanDecision({ outcome: 'COMPLETE', progressed: true, frequencyHours: 72, nowMs: now }), null);
  assert.equal(plan.nextScanDecision({ outcome: 'PARTIAL', progressed: true, frequencyHours: 72, nowMs: now }), '2026-09-24T06:00:00.000Z');
  assert.equal(plan.nextScanDecision({ outcome: 'PARTIAL', progressed: true, frequencyHours: 2, nowMs: now }), '2026-09-24T02:00:00.000Z');
  assert.equal(plan.nextScanDecision({ outcome: 'PARTIAL', progressed: false, frequencyHours: 72, nowMs: now }), null);
  assert.equal(plan.nextScanDecision({ outcome: 'FAILED', progressed: false, frequencyHours: 72, nowMs: now }), null);
});
