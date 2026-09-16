#!/usr/bin/env node
// Parses the given JS/JSX files with the project's Babel config and reports syntax errors.
// Usage: node scripts/syntax-check.js app/index.js components/Header.js
const path = require('path');
const babel = require('@babel/core');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/syntax-check.js <file> [...files]');
  process.exit(2);
}
let failed = 0;
for (const f of files) {
  try {
    babel.transformFileSync(path.resolve(f), { cwd: path.resolve(__dirname, '..'), babelrc: false, configFile: path.resolve(__dirname, '../babel.config.js'), code: false });
    console.log(`ok   ${f}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${f}\n${e.message.split('\n').slice(0, 6).join('\n')}`);
  }
}
process.exit(failed ? 1 : 0);
