import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublicBaseUrl, getInternalApiBaseUrl, isVercelDeploymentHost, getTenantTrustedBaseUrl } from './publicBaseUrl.js';

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

// Task #3387: cross-check request origin against the tenant's real slug.
test('getTenantTrustedBaseUrl keeps a matching origin (any environment)', () => {
  withEnv({}, () => {
    const tenant = { slug: 'gfi', domain: 'graduatefutures.org' };
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://gfi.dev.iconn.app' } }, tenant),
      'https://gfi.dev.iconn.app'
    );
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://gfi.iconn.app' } }, tenant),
      'https://gfi.iconn.app'
    );
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://GFI.testing.iconn.app' } }, tenant),
      'https://GFI.testing.iconn.app'
    );
  });
});

test('getTenantTrustedBaseUrl corrects a transposed/typo\'d slug', () => {
  withEnv({}, () => {
    const tenant = { slug: 'gfi', domain: null };
    // The real incident: fgi.dev.iconn.app for the gfi tenant.
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://fgi.dev.iconn.app' } }, tenant),
      'https://gfi.dev.iconn.app'
    );
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://fgi.iconn.app' } }, tenant),
      'https://gfi.iconn.app'
    );
    // Bare environment host has no slug at all — rebuild with the slug.
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://dev.iconn.app' } }, tenant),
      'https://gfi.dev.iconn.app'
    );
  });
});

test('getTenantTrustedBaseUrl prefers the custom domain on production hosts', () => {
  withEnv({}, () => {
    const tenant = { slug: 'gfi', domain: 'www.graduatefutures.org' };
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://fgi.iconn.app' } }, tenant),
      'https://graduatefutures.org'
    );
    // …but environment hosts stay on the environment, never jump to prod.
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://fgi.dev.iconn.app' } }, tenant),
      'https://gfi.dev.iconn.app'
    );
  });
});

test('getTenantTrustedBaseUrl leaves custom domains and fallbacks alone', () => {
  withEnv({}, () => {
    const tenant = { slug: 'gfi', domain: 'graduatefutures.org' };
    // Origin on the tenant's custom domain: echoed unchanged.
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://graduatefutures.org' } }, tenant),
      'https://graduatefutures.org'
    );
    // Any non-iconn host (proxy, other domain) is not second-guessed.
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://members.example.org' } }, tenant),
      'https://members.example.org'
    );
    // No request → production fallback passes through untouched.
    assert.equal(getTenantTrustedBaseUrl(null, tenant), 'https://iconn.app');
    // No tenant/slug → plain getPublicBaseUrl behaviour.
    assert.equal(
      getTenantTrustedBaseUrl({ headers: { origin: 'https://fgi.dev.iconn.app' } }, null),
      'https://fgi.dev.iconn.app'
    );
  });
});

test('getTenantTrustedBaseUrl never builds a link from a malformed stored domain', () => {
  withEnv({}, () => {
    const origin = { headers: { origin: 'https://fgi.iconn.app' } };
    for (const bad of [
      'trusted.example@attacker.example',
      'graduatefutures.org/evil',
      'graduatefutures.org:8443',
      'https://graduatefutures.org',
      'attacker.example#x',
      'no-dots',
      '',
      null,
    ]) {
      assert.equal(
        getTenantTrustedBaseUrl(origin, { slug: 'gfi', domain: bad }),
        'https://gfi.iconn.app',
        `domain ${JSON.stringify(bad)} must fall back to the slug host`
      );
    }
    // A clean domain (with www.) is still used.
    assert.equal(
      getTenantTrustedBaseUrl(origin, { slug: 'gfi', domain: 'www.graduatefutures.org' }),
      'https://graduatefutures.org'
    );
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
