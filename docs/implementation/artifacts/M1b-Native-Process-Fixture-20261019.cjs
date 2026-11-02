'use strict';

// Harmless fixture for native stdout/stderr and Windows argument handling.
process.stdout.write(JSON.stringify({ arguments: process.argv.slice(3) }) + '\n');
process.stderr.write('synthetic native progress; not a build failure\n');
process.exitCode = Number(process.argv[2]);
