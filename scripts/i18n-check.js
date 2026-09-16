#!/usr/bin/env node
// Translation-resource check. Fails (exit 1) when:
//  1. a key exists in one locale but not another (plural variants _one/_two/_other... are grouped),
//  2. a plural key group has no "_other" form in some locale,
//  3. the same key uses different {{params}} in different locales,
//  4. code calls t('literal.key') for a key that doesn't exist in the default locale.
// Usage: npm run i18n:check
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'lib/i18n/locales');
const DEFAULT = 'he';
const PLURAL = /_(zero|one|two|few|many|other)$/;

const locales = fs.readdirSync(LOCALES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const problems = [];

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

const flat = {};
const namespaces = new Set();
for (const loc of locales) {
  flat[loc] = {};
  for (const file of fs.readdirSync(path.join(LOCALES_DIR, loc)).filter((f) => f.endsWith('.json'))) {
    const ns = file.replace(/\.json$/, '');
    namespaces.add(ns);
    try {
      flatten(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, loc, file), 'utf8')), ns, flat[loc]);
    } catch (e) {
      problems.push(`${loc}/${file}: invalid JSON (${e.message})`);
    }
  }
}
for (const ns of namespaces) for (const loc of locales) {
  if (!fs.existsSync(path.join(LOCALES_DIR, loc, `${ns}.json`))) problems.push(`namespace "${ns}" missing in locale "${loc}"`);
}

const base = (k) => k.replace(PLURAL, '');
const params = (s) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).filter((p) => p !== 'count').sort().join(',');

const groups = {};
for (const loc of locales) for (const key of Object.keys(flat[loc])) {
  const b = base(key);
  groups[b] ||= {};
  groups[b][loc] ||= [];
  groups[b][loc].push(key);
}
for (const [b, byLoc] of Object.entries(groups)) {
  const missing = locales.filter((l) => !byLoc[l]);
  if (missing.length) problems.push(`"${b}" missing in: ${missing.join(', ')}`);
  const isPlural = Object.values(byLoc).some((keys) => keys.some((k) => PLURAL.test(k)));
  if (isPlural) for (const l of locales) {
    if (byLoc[l] && !byLoc[l].includes(`${b}_other`)) problems.push(`"${b}" plural has no "_other" form in ${l}`);
  }
  const sigs = new Set(locales.filter((l) => byLoc[l]).flatMap((l) => byLoc[l].map((k) => params(flat[l][k]))));
  if (sigs.size > 1) problems.push(`"${b}" uses different {{params}} across locales: ${[...sigs].map((s) => `[${s}]`).join(' vs ')}`);
}

// Keys referenced from code with a literal string must exist.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'locales' ? [] : walk(p);
    return /\.(js|jsx|ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const defaultBases = new Set(Object.keys(flat[DEFAULT] || {}).map(base));
for (const dir of ['app', 'components', 'lib', 'constants']) {
  for (const file of walk(path.join(ROOT, dir))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z][\w-]*(?:\.[^'"\s)]+)+)['"]/g)) {
      const key = m[1];
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const before = src.slice(lineStart, m.index);
      if (/^\s*(\/\/|\*|\/\*)/.test(before) || before.includes('//')) continue;
      if (!defaultBases.has(key) && !defaultBases.has(base(key))) {
        const line = src.slice(0, m.index).split('\n').length;
        problems.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${line} uses unknown key "${key}"`);
      }
    }
  }
}

const keyCount = Object.keys(flat[DEFAULT] || {}).length;
if (problems.length) {
  console.error(`i18n check FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`i18n check passed: ${locales.join(', ')} · ${namespaces.size} namespaces · ${keyCount} keys in ${DEFAULT}`);
