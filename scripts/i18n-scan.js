#!/usr/bin/env node
// Finds likely user-facing hard-coded Hebrew in UI code (app/, components/): Hebrew inside string
// literals, template literals and JSX text, ignoring comments. Low-noise by design - it only looks
// for Hebrew, because after the i18n migration UI code should contain none except canonical data
// values (category/region/day names used as IDs), which are marked with // i18n-ignore.
//
// Usage:
//   npm run i18n:scan                 whole app/ + components/
//   npm run i18n:scan -- --changed    only lines changed vs HEAD (staged + unstaged)
//   npm run i18n:scan -- app/login.js a specific file/dir
// Suppress a known-canonical line with a trailing `// i18n-ignore`, or a whole file with
// `// i18n-ignore-file` near the top. Exit code 1 when findings exist (CI-friendly).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HEB = /[֐-׿]/;
const args = process.argv.slice(2);
const changedOnly = args.includes('--changed');
const targets = args.filter((a) => !a.startsWith('--'));
const DEFAULT_DIRS = ['app', 'components'];

function walk(p) {
  const abs = path.resolve(ROOT, p);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return /\.(js|jsx|ts|tsx)$/.test(abs) ? [abs] : [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : walk(path.join(abs, e.name))));
}

// Blank out comments while preserving line numbers and string contents.
function stripComments(src) {
  let out = '';
  let i = 0;
  let q = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, e < 0 ? src.length : e + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i += chunk.length;
      continue;
    }
    if (c === '/' && n === '/') {
      const e = src.indexOf('\n', i);
      const chunk = src.slice(i, e < 0 ? src.length : e);
      out += chunk.includes('i18n-ignore') ? ' I18N_IGNORE' + chunk.slice(12).replace(/[^\n]/g, ' ') : chunk.replace(/[^\n]/g, ' ');
      i += chunk.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function changedLines() {
  const map = new Map();
  let diff = '';
  try {
    diff = execSync('git diff HEAD --unified=0 --no-color -- app components', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return map;
  }
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (!map.has(file)) map.set(file, new Set());
      for (let k = 0; k < count; k++) map.get(file).add(start + k);
    }
  }
  // untracked files count as fully changed
  try {
    const untracked = execSync('git ls-files --others --exclude-standard -- app components', { cwd: ROOT, encoding: 'utf8' });
    for (const f of untracked.split('\n').filter(Boolean)) map.set(f, 'all');
  } catch {
    // ignore
  }
  return map;
}

const changed = changedOnly ? changedLines() : null;
const files = (targets.length ? targets : DEFAULT_DIRS).flatMap(walk);
const findings = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  if (/i18n-ignore-file/.test(raw.slice(0, 2000))) continue;
  if (changed && !changed.has(rel)) continue;
  const lines = stripComments(raw).split('\n');
  lines.forEach((line, idx) => {
    if (!HEB.test(line) || line.includes('I18N_IGNORE')) return;
    const n = idx + 1;
    const set = changed?.get(rel);
    if (set && set !== 'all' && !set.has(n)) return;
    findings.push(`${rel}:${n}: ${raw.split('\n')[idx].trim().slice(0, 140)}`);
  });
}

if (findings.length) {
  console.error(`i18n scan: ${findings.length} line(s) with hard-coded Hebrew in UI code:`);
  for (const f of findings) console.error(`  ${f}`);
  console.error('\nMove user-facing text to lib/i18n/locales/{he,en}/*.json and use t(). If a line is a canonical data value (not display text), add `// i18n-ignore`.');
  process.exit(1);
}
console.log(`i18n scan passed: no hard-coded Hebrew in ${changedOnly ? 'changed lines of ' : ''}${targets.length ? targets.join(', ') : DEFAULT_DIRS.join(', ')}`);
