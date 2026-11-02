'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const validator = path.join(__dirname, 'M1b-Validate-Lockfile-20261018.cjs');

const cases = [
  ['registry lock with npm empty root key', '{"packages":{"":{"name":"fixture"},"node_modules/a":{"resolved":"https://registry.example/a.tgz"}}}', 0],
  ['UTF-8 BOM', '\uFEFF{"packages":{"":{}}}', 0],
  ['workspace link', '{"packages":{"node_modules/a":{"link":true}}}', 2],
  ['local file dependency', '{"packages":{"node_modules/a":{"resolved":"file:../private"}}}', 2],
  ['malformed JSON', '{"packages":', 1],
  ['missing package map', '{}', 1],
  ['invalid package map', '{"packages":[]}', 1],
];

for (const [name, content, expected] of cases) {
  test(name, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'M1b lock validation '));
    const file = path.join(directory, 'package lock.json');
    try {
      fs.writeFileSync(file, content);
      const result = spawnSync(process.execPath, [validator, file], { encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(directory);
    }
  });
}
