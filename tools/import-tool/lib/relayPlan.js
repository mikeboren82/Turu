// TuRu - relay run planning (pure): item-aware packing, the explicit part ceiling, deferred-page
// detection, starvation-safe ordering, and the COMPLETE / PARTIAL / FAILED run verdict.
const { splitTextForExtraction, ITEM_DELIMITER } = require('./htmlText');

const PART_CHAR_LIMIT = 18000; // one scan-source extraction window
// Evidence 2026-09-24: largest legitimate relay page (Holon) = 81k chars = 5 parts; a dense part costs one AI call
// of ~40-70s; the relay job gets 45 min for up to 6 sources. 12 parts = 2.4x Holon, worst case ~14 min of extraction.
const MAX_RELAY_PARTS_PER_SOURCE = 12;
const PARTIAL_RETRY_HOURS = 6; // = the Monster relay job cadence (lib/monsterJobs.js), so no tighter loop exists
const MAX_FOLLOWUP_ROUNDS = 2;

const countItems = (text) => (text.match(/\n---\n/g) || []).length + 1;

// Whole items packed greedily into <= limit parts; only an item that alone exceeds the limit is split
// (newline, then hard cut). Text without delimiters is one item, i.e. the previous newline-split behaviour.
function packItemsIntoParts(text, limit = PART_CHAR_LIMIT) {
  const items = String(text || '').split(ITEM_DELIMITER).filter((s) => s.trim().length > 0);
  const parts = [];
  let cur = '', oversizedItems = 0, hardSplits = 0;
  for (const item of items) {
    if (item.length > limit) {
      if (cur) { parts.push(cur); cur = ''; }
      oversizedItems++;
      for (const chunk of splitTextForExtraction(item, limit, Infinity)) {
        if (chunk.length === limit) hardSplits++;
        parts.push(chunk);
      }
      continue;
    }
    if (cur && cur.length + ITEM_DELIMITER.length + item.length > limit) { parts.push(cur); cur = ''; }
    cur = cur ? cur + ITEM_DELIMITER + item : item;
  }
  if (cur) parts.push(cur);
  return { parts, items: items.length, oversizedItems, hardSplits };
}

// Keeps the first `maxParts` listing parts (in plan order) and accounts for everything beyond - never silent.
function applyPartCeiling(listingParts, maxParts = MAX_RELAY_PARTS_PER_SOURCE) {
  const kept = listingParts.slice(0, maxParts);
  const dropped = listingParts.slice(maxParts);
  const items = (ps) => ps.reduce((n, p) => n + countItems(p.text), 0);
  const chars = (ps) => ps.reduce((n, p) => n + p.text.length, 0);
  return {
    kept,
    ceiling: dropped.length ? {
      reason: 'relay_part_ceiling', maxParts, partsTotal: listingParts.length, partsDropped: dropped.length,
      itemsTotal: items(listingParts), itemsSent: items(kept), itemsDropped: items(dropped), charsDropped: chars(dropped),
      droppedUrls: dropped.map((p) => p.url),
    } : null,
  };
}

// Changed / never-extracted parts first, oldest last_fetched_at first: a part scan-source deferred keeps its old
// timestamp, so it outranks a part 1 that changes daily but was extracted yesterday. Unchanged parts go last.
function orderPartsForRelay(parts, snapshots) {
  const snap = new Map((snapshots || []).map((s) => [s.url, s]));
  const annotated = parts.map((p, i) => {
    const s = snap.get(p.url);
    const unchanged = !!s && s.content_hash === p.hash;
    return { p, i, unchanged, at: s && s.last_fetched_at ? Date.parse(s.last_fetched_at) : -Infinity };
  });
  const cmpAt = (a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1);
  annotated.sort((a, b) => (Number(a.unchanged) - Number(b.unchanged)) || cmpAt(a, b) || (a.i - b.i));
  return annotated.map((a) => ({ ...a.p, state: a.unchanged ? 'unchanged' : 'pending' }));
}

// A submitted part counts as processed only when scan-source stored ITS hash during/after this invocation.
function processedUrls(parts, snapshotsAfter, sinceIso) {
  const since = Date.parse(sinceIso);
  const snap = new Map((snapshotsAfter || []).map((s) => [s.url, s]));
  const done = new Set();
  for (const p of parts) {
    const s = snap.get(p.url);
    if (s && s.content_hash === p.hash && s.last_fetched_at && Date.parse(s.last_fetched_at) >= since) done.add(p.url);
  }
  return done;
}

function batchParts(listingParts, detailPages, batchSize) {
  const detailsOf = (p) => detailPages.filter((d) => d.parent_url === p.url.split('#part=')[0]);
  const batches = [];
  for (let i = 0; i < listingParts.length; i += batchSize) {
    const b = listingParts.slice(i, i + batchSize);
    const seen = new Set(); const ds = [];
    for (const p of b) for (const d of detailsOf(p)) if (!seen.has(d.url)) { seen.add(d.url); ds.push(d); }
    batches.push([...b, ...ds]);
  }
  return batches;
}

function classifyRun({ plannedParts, confirmedParts, submittedBatches, failedBatch, ceiling, waitTimedOut }) {
  if (!plannedParts) return 'FAILED';
  if (!submittedBatches) return 'FAILED';
  if (failedBatch || ceiling || waitTimedOut || confirmedParts < plannedParts) return 'PARTIAL';
  return 'COMPLETE';
}

// COMPLETE keeps scan-source's own +frequency. PARTIAL that made progress retries at the relay cadence; a PARTIAL
// with no progress keeps the normal cadence so a permanently stuck source never becomes a tight retry loop.
function nextScanDecision({ outcome, progressed, frequencyHours, nowMs = Date.now() }) {
  if (outcome !== 'PARTIAL' || !progressed) return null;
  const hours = Math.min(PARTIAL_RETRY_HOURS, Number(frequencyHours) || PARTIAL_RETRY_HOURS);
  return new Date(nowMs + hours * 3600 * 1000).toISOString();
}

module.exports = {
  PART_CHAR_LIMIT, MAX_RELAY_PARTS_PER_SOURCE, PARTIAL_RETRY_HOURS, MAX_FOLLOWUP_ROUNDS,
  countItems, packItemsIntoParts, applyPartCeiling, orderPartsForRelay, processedUrls, batchParts, classifyRun, nextScanDecision,
};
