'use strict';

// Synthetic, network-disabled image probe. Never prints environment or tokens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

let stage = 'runtime';
async function main() {
  const role = process.argv[2];
  assert(['Portal', 'Core'].includes(role));
  assert.equal(process.version, 'v20.17.0');
  assert.equal(process.env.PORTAL_STRICT_OAUTH_ENABLED, 'false');
  assert.equal(process.env.CORE_STRICT_OAUTH_CLIENT_IDS, '[]');
  const root = process.cwd();
  const requireProject = createRequire(path.join(root, 'package.json'));
  const checks = ['node_20_17_0', 'strict_cohort_off'];
  if (role === 'Portal') {
    stage = 'production_dependencies';
    const express = requireProject('express');
    const mongoose = requireProject('mongoose');
    const jwt = requireProject('jsonwebtoken');
    assert.equal(typeof requireProject('mongodb').MongoClient, 'function');
    stage = 'strict_default_off';
    const { initializeStrictOAuth } = await import(pathToFileURL(path.join(root, 'src/service/oauthStrictBootstrap.js')).href);
    const { createStrictOAuthRuntime } = await import(pathToFileURL(path.join(root, 'src/service/oauthStrictRuntime.js')).href);
    const app = express();
    const guard = initializeStrictOAuth(app, { PORTAL_STRICT_OAUTH_ENABLED: 'false' });
    let nextCalls = 0;
    guard({}, {}, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    assert.equal(mongoose.connection.readyState, 0);
    assert.equal(app._router, undefined);
    const invalid = createStrictOAuthRuntime({ environment: { PORTAL_STRICT_OAUTH_ENABLED: 'true', PORTAL_STRICT_OAUTH_CONFIG: '{invalid' } });
    assert.equal(invalid.diagnostic.configurationValid, false);
    await assert.rejects(() => invalid.resolveAuthority('synthetic'));
    checks.push('production_dependencies', 'default_off_no_database_or_route', 'invalid_strict_config_denied');
    stage = 'synthetic_token_verification';
    const { createStrictAccessVerifier } = await import(pathToFileURL(path.join(root, 'src/service/oauthStrictAccessVerifier.js')).href);
    // Public fixed fixture material, never a live signing/client credential.
    const key = Buffer.alloc(32, 7);
    const subject = '507f1f77bcf86cd799439011';
    const policy = { issuer: 'urn:synthetic:image', audience: 'urn:synthetic:product', clientId: 'synthetic-image-only', maxTokenAgeSeconds: 300 };
    const claims = { iss: policy.issuer, aud: policy.audience, client_id: policy.clientId, sub: subject, type: 'access_token', scope: 'profile', jti: 'synthetic-image-only' };
    const token = jwt.sign(claims, key, { algorithm: 'HS256', expiresIn: 60 });
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const verify = createStrictAccessVerifier(policy, {
      signingKey: key,
      readClient: async () => ({ clientId: policy.clientId, active: true, strictIdentity: { enabled: true, issuer: policy.issuer, audience: policy.audience }, allowedGrants: ['authorization_code', 'refresh_token'], allowedScopes: ['profile'] }),
      readToken: async value => value === hash ? { clientId: policy.clientId, userId: subject, scopes: ['profile'], revoked: false, expiresAt: new Date(Date.now() + 60000) } : null,
    });
    assert.equal((await verify(token)).status, 'ok');
    const wrong = jwt.sign({ ...claims, aud: 'urn:synthetic:wrong' }, key, { algorithm: 'HS256', expiresIn: 60 });
    assert.equal((await verify(wrong)).status, 'unauthenticated');
    checks.push('synthetic_bound_token_accepted', 'wrong_audience_denied');
  } else {
    stage = 'compiled_authorizer';
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.next/server/app-paths-manifest.json'), 'utf8'));
    const entry = Object.entries(manifest).find(([key]) => key === '/api/oauth/authorize/route');
    assert(entry && typeof entry[1] === 'string');
    const serverRoot = path.join(root, '.next/server');
    const file = path.resolve(serverRoot, entry[1]);
    assert(file.startsWith(serverRoot + path.sep));
    const route = requireProject(file);
    assert.equal(typeof route.routeModule?.userland?.GET, 'function');
    assert.equal(typeof route.routeModule?.userland?.POST, 'function');
    checks.push('compiled_authorizer_present', 'production_route_module_loads', 'get_post_exports_present');
  }
  process.stdout.write(JSON.stringify({ status: 'PASS_IMAGE_PROBE_ONLY', role, node: process.version, checks, network: 'disabled_by_docker_command', database: 'not_connected', publicServer: 'not_started', acceptance: 'NOT_M1B_OR_DEPLOYED_ACCEPTANCE' }) + '\n');
}

main().catch(() => {
  process.stderr.write(JSON.stringify({ status: 'FAILED_IMAGE_PROBE', stage }) + '\n');
  process.exitCode = 1;
});
