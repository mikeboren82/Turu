// TuRu - diff two coverage-report-*.json snapshots (report-coverage.js output) to show what an
// expansion cycle actually changed: totals, per-region sources/activities, families, categories.
//   node compare-coverage.js coverage-report-baseline-before-phase1.json coverage-report-2026-09-13.json
const fs = require('fs');
const path = require('path');
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')));
if (!a || !b) { console.error('usage: node compare-coverage.js <before.json> <after.json>'); process.exit(1); }
const d = (x, y) => { const v = (y || 0) - (x || 0); return (v >= 0 ? '+' : '') + v; };
console.log(`BEFORE ${a.generatedAt}  ->  AFTER ${b.generatedAt}\n`);
console.log('TOTALS');
for (const k of Object.keys({ ...a.totals, ...b.totals })) console.log(`  ${k.padEnd(26)} ${String(a.totals[k] ?? 0).padStart(6)} -> ${String(b.totals[k] ?? 0).padStart(6)}  (${d(a.totals[k], b.totals[k])})`);
console.log('\nBY REGION (active sources | venues | non-playground activities)');
for (const r of Object.keys(b.byRegion)) {
  const x = a.byRegion[r] || {}, y = b.byRegion[r];
  console.log(`  ${r.padEnd(18)} src ${String(x.activeSources || 0).padStart(3)} -> ${String(y.activeSources).padStart(3)} | venues ${String(x.venues || 0).padStart(3)} -> ${String(y.venues).padStart(3)} | nonPG ${String(x.nonPlayground || 0).padStart(4)} -> ${String(y.nonPlayground).padStart(4)}`);
}
console.log('\nBY FAMILY (active sources)');
for (const f of new Set([...Object.keys(a.byFamily), ...Object.keys(b.byFamily)])) console.log(`  ${f.padEnd(18)} ${String(a.byFamily[f] || 0).padStart(3)} -> ${String(b.byFamily[f] || 0).padStart(3)}`);
console.log('\nBY CATEGORY (non-playground live activities, changed only)');
for (const c of new Set([...Object.keys(a.byCategory), ...Object.keys(b.byCategory)])) if ((a.byCategory[c] || 0) !== (b.byCategory[c] || 0)) console.log(`  ${c.padEnd(18)} ${String(a.byCategory[c] || 0).padStart(3)} -> ${String(b.byCategory[c] || 0).padStart(3)}`);
console.log('\nSOURCE HEALTH', a.sourceHealth, '->', b.sourceHealth);
console.log('REVIEW QUEUE', a.reviewQueue || '-', '->', b.reviewQueue || '-');
console.log(`GAPS ${a.gaps.length} -> ${b.gaps.length} (high: ${a.gaps.filter((g) => g.severity === 'high').length} -> ${b.gaps.filter((g) => g.severity === 'high').length})`);
