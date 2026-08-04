import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublicBaseUrl, getInternalApiBaseUrl, isVercelDeploymentHost } from './publicBaseUrl.js';

const DEPLOY = 'vite-migrate-replit-6-l2144g4vw-isaasi.vercel.app';

function withEnv(overrides, fn) {
  const keys = ['VERCEL_URL', 'VITE_APP_URL', 'APP_URL', 'SITE_URL'];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, overrides);
  try { return fn(); } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('isVercelDeploymentHost detects deployment hosts in urls and bare hosts', () => {
  assert.equal(isVercelDeploymentHost(`https://${DEPLOY}/path?q=1`), true);
  assert.equal(isVercelDeploymentHost(DEPLOY), true);
  assert.equal(isVercelDeploymentHost('acme.iconn.app'), false);
  assert.equal(isVercelDeploymentHost('https://members.example.org'), false);
  assert.equal(isVercelDeploymentHost(''), false);
});

test('getPublicBaseUrl prefers the request origin', () => {
  withEnv({ VERCEL_URL: DEPLOY }, () => {
    assert.equal(
      getPublicBaseUrl({ headers: { origin: 'https://members.example.org/' } }),
      'https://members.example.org'
    );
  });
});

test('getPublicBaseUrl falls back to forwarded host', () => {
  withEnv({ VERCEL_URL: DEPLOY }, () => {
    assert.equal(
      getPublicBaseUrl({ headers: { 'x-forwarded-host': 'acme.iconn.app', 'x-forwarded-proto': 'https' } }),
      'https://acme.iconn.app'
    );
  });
});

test('getPublicBaseUrl never returns the VERCEL_URL deployment domain', () => {
  withEnv({ VERCEL_URL: DEPLOY }, () => {
    // Even a request arriving ON the deployment domain must not bake it
    // into user-facing links.
    assert.equal(getPublicBaseUrl({ headers: { origin: `https://${DEPLOY}` } }), 'https://iconn.app');
    assert.equal(getPublicBaseUrl({ headers: { host: DEPLOY } }), 'https://iconn.app');
    assert.equal(getPublicBaseUrl(null), 'https://iconn.app');
  });
});

test('getPublicBaseUrl uses configured app URL when no request host', () => {
  withEnv({ VERCEL_URL: DEPLOY, VITE_APP_URL: 'https://app.iconn.app/' }, () => {
    assert.equal(getPublicBaseUrl(null), 'https://app.iconn.app');
  });
  // A misconfigured app URL pointing at a deployment domain is rejected too.
  withEnv({ APP_URL: `https://${DEPLOY}` }, () => {
    assert.equal(getPublicBaseUrl(null), 'https://iconn.app');
  });
});

test('getInternalApiBaseUrl prefers live request host, VERCEL_URL only last resort', () => {
  withEnv({ VERCEL_URL: DEPLOY }, () => {
    assert.equal(
      getInternalApiBaseUrl({ headers: { host: 'acme.iconn.app' } }),
      'https://acme.iconn.app'
    );
    assert.equal(getInternalApiBaseUrl(null), `https://${DEPLOY}`);
  });
  withEnv({ VERCEL_URL: DEPLOY, APP_URL: 'https://app.iconn.app' }, () => {
    assert.equal(getInternalApiBaseUrl(null), 'https://app.iconn.app');
  });
  withEnv({}, () => {
    assert.equal(getInternalApiBaseUrl(null), '');
  });
});
