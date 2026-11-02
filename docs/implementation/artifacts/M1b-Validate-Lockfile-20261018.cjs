'use strict';

// Read-only owner-install preflight. Never prints package contents or npm config.
const fs = require('node:fs');

try {
  const lock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  if (!lock || typeof lock.packages !== 'object' || lock.packages === null || Array.isArray(lock.packages)) {
    process.exitCode = 1;
  } else if (Object.values(lock.packages).some(pkg => pkg && (pkg.link === true || /^file:/i.test(pkg.resolved || '')))) {
    process.exitCode = 2;
  }
} catch {
  process.exitCode = 1;
}
