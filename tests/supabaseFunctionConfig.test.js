// TuRu - deploy-safety pin for supabase/config.toml (2026-09-27). `supabase functions deploy <name>` takes each
// function's JWT mode from its [functions.<name>] table (default verify_jwt = true when the table is missing).
// place-photo MUST stay public: stored image URLs are bare <img src> requests with no Authorization header, and its
// protection lives inside the function (supabase/functions/_shared/placePhoto.ts). Dropping the entry or flipping it
// would make a plain deploy silently break every legacy image URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CONFIG = path.resolve(__dirname, '..', 'supabase', 'config.toml');

// Minimal reader for this file's flat shape: `[table]` headers followed by `key = value` lines. Returns every table
// whose header names functions.<slug> (bare or quoted), so a duplicate table is detectable.
function functionTables(src, slug) {
  const want = new Set([`functions.${slug}`, `functions."${slug}"`]);
  const tables = [];
  let current = null;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (header) {
      current = want.has(header[1].replace(/\s*\.\s*/g, '.')) ? {} : null;
      if (current) tables.push(current);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (current && kv) current[kv[1]] = kv[2];
  }
  return tables;
}

test('config.toml pins place-photo to verify_jwt = false (public <img src> endpoint)', () => {
  const tables = functionTables(fs.readFileSync(CONFIG, 'utf8'), 'place-photo');
  assert.equal(tables.length, 1, 'expected exactly one [functions.place-photo] table in supabase/config.toml');
  assert.equal(tables[0].verify_jwt, 'false', 'place-photo verify_jwt must be the TOML boolean false');
});

test('the reader rejects the regressions it guards against', () => {
  assert.equal(functionTables('[functions.scan-source]\nverify_jwt = true\n', 'place-photo').length, 0);
  assert.equal(functionTables('[functions.place-photo]\nverify_jwt = true\n', 'place-photo')[0].verify_jwt, 'true');
  assert.equal(functionTables('[functions.place-photo]\nverify_jwt = "false"\n', 'place-photo')[0].verify_jwt, '"false"');
  assert.equal(functionTables('[functions.place-photo]\n# verify_jwt = false\n', 'place-photo')[0].verify_jwt, undefined);
  assert.equal(functionTables('[functions.place-photo]\nverify_jwt = false # public\r\n', 'place-photo')[0].verify_jwt, 'false');
  assert.equal(functionTables('[functions.place-photo]\n[functions."place-photo"]\n', 'place-photo').length, 2);
});
