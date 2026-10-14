import {createRequire} from 'node:module';import path from 'node:path';
// npm installation beside the extracted release, or explicit shared test tools.
export const dependencyRequire=createRequire(process.env.VYNVORI_TEST_MODULES?path.join(process.env.VYNVORI_TEST_MODULES,'package.json'):new URL('../package.json',import.meta.url));
export function browserTools(){try{return {chromium:dependencyRequire('playwright').chromium,axePath:dependencyRequire.resolve('axe-core/axe.min.js')};}catch{throw Error('Install playwright and axe-core beside the release, or set VYNVORI_TEST_MODULES to their node_modules directory. No workspace path is assumed.');}}
