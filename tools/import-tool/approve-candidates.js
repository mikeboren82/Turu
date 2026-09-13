// TuRu - apply a curated approvals file to a discovery-candidates-*.json (marks approved=true and
// sets the registry fields), and append any venues the approvals reference to source-manifest.json.
// Keeps the human decision as data in the repo instead of hand-editing JSON.
//   node approve-candidates.js --candidates=discovery-candidates-2026-09-13.json --approvals=discovery-approvals-2026-09-13.json
// approvals file: { "venues": [ <manifest venue entries> ],
//                   "approve": [ { "url": "...", "name": "...", "source_kind": "...", "publisher_type": "...",
//                                  "publisher_name": "...", "venue": "<venue key>", "region": "...", "priority": 7,
//                                  "source_trust_score": 85, "scan_frequency_hours": 72, "categories": [] } ] }
const fs = require('fs');
const path = require('path');
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v]; }));
const candPath = path.join(__dirname, args.candidates);
const cand = JSON.parse(fs.readFileSync(candPath, 'utf8'));
const approvals = JSON.parse(fs.readFileSync(path.join(__dirname, args.approvals), 'utf8'));
const manifestPath = path.join(__dirname, 'source-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const norm = (u) => u.replace(/\/$/, '');
let approved = 0, missing = 0;
for (const a of approvals.approve) {
  const c = cand.candidates.find((x) => norm(x.url) === norm(a.url));
  if (!c) { missing++; console.log('  not in candidates:', a.url); continue; }
  c.approved = true;
  const { url, ...rest } = a;
  c.overrides = { ...(c.overrides || {}), ...rest };
  if (a.name) c.name = a.name;
  if (a.venue) c.venue = a.venue;
  if (a.region) c.region = a.region;
  approved++;
}
const knownVenueKeys = new Set(manifest.venues.map((v) => v.key));
let venuesAdded = 0;
for (const v of approvals.venues || []) if (!knownVenueKeys.has(v.key)) { manifest.venues.push(v); venuesAdded++; }
fs.writeFileSync(candPath, JSON.stringify(cand, null, 2));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`approved ${approved} candidates (${missing} not found), added ${venuesAdded} venues to the manifest`);
