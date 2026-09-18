import test from 'node:test';
import assert from 'node:assert/strict';

import { createPublicPageHandler } from './[slug].js';

const TENANT = { id: 'tenant-a', slug: 'tenant-a' };

function responseMock() {
  const headers = new Map();
  const response = {
    statusCode: 200,
    body: undefined,
    headers,
    setHeader(name, value) {
      headers.set(name, value);
    },
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(body) {
      response.body = body;
      return response;
    },
  };
  return response;
}

function request(slug, query = {}) {
  return {
    method: 'GET',
    query: { slug, ...query },
    headers: { host: 'tenant-a.example.test' },
  };
}

function pageRow(slug = 'login', extra = {}) {
  return {
    id: `page-${slug}`,
    tenant_id: TENANT.id,
    slug,
    status: 'published',
    layout_type: 'public',
    builder_type: 'ai_static',
    static_html: '<main>Welcome</main>',
    ...extra,
  };
}

function makeDb({
  page = null,
  pageError = null,
  pageFailure = null,
  track = {},
  micrositeRows = [],
} = {}) {
  return {
    from(table) {
      const filters = {};
      const query = {
        select() {
          return query;
        },
        eq(key, value) {
          filters[key] = value;
          return query;
        },
        in(key, value) {
          track.layout = { key, value };
          return query;
        },
        order() {
          return query;
        },
        async maybeSingle() {
          track.lookup = 'maybeSingle';
          track.filters = { ...filters };
          if (pageFailure) throw pageFailure;
          return { data: page, error: pageError };
        },
        async single() {
          track.lookup = 'single';
          track.filters = { ...filters };
          if (pageFailure) throw pageFailure;
          if (table === 'tenant') {
            return { data: micrositeRows[0] || null, error: pageError };
          }
          return { data: page, error: pageError };
        },
      };
      return query;
    },
  };
}

function handlerFor(options = {}) {
  return createPublicPageHandler({
    db: makeDb(options),
    resolveTenant: async () => TENANT,
    resolveViewer: async () => ({}),
    resolveMicrosite: async () => null,
  });
}

test('missing tenant returns 404 without attempting page lookup', async () => {
  const track = {};
  const handler = createPublicPageHandler({
    db: makeDb({ track }),
    resolveTenant: async () => null,
  });
  const res = responseMock();

  await handler(request('login'), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Tenant not found' });
  assert.equal(track.lookup, undefined);
});

test('login with zero rows is an optional missing page', async () => {
  const track = {};
  const handler = handlerFor({ track, page: null, pageError: null });
  const res = responseMock();

  await handler(request('login'), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Page not found or not published' });
  assert.equal(track.lookup, 'maybeSingle');
  assert.equal(track.filters.tenant_id, TENANT.id);
  assert.equal(track.filters.slug, 'login');
  assert.equal(track.filters.status, 'published');
  assert.deepEqual(track.layout, {
    key: 'layout_type',
    value: ['public', 'hybrid', 'public_no_chrome', 'public_header_only', 'public_footer_only'],
  });
});

test('login query failures return a generic 500 instead of a missing-page 404', async () => {
  for (const [failure, option] of [
    [{ code: 'PGRST116', message: 'database unavailable' }, { pageError: { code: 'PGRST116', message: 'database unavailable' } }],
    [new Error('network unavailable'), { pageFailure: new Error('network unavailable') }],
    [{ code: '23505', message: 'duplicate rows' }, { pageError: { code: '23505', message: 'duplicate rows' } }],
  ]) {
    const track = {};
    const handler = handlerFor({ track, page: null, ...option });
    const res = responseMock();

    await handler(request('login'), res);

    assert.equal(res.statusCode, 500, failure.message);
    assert.deepEqual(res.body, { error: 'Failed to fetch page' }, failure.message);
    assert.equal(track.lookup, 'maybeSingle', failure.message);
  }
});

test('published login page resolves successfully', async () => {
  const track = {};
  const handler = handlerFor({ track, page: pageRow(), pageError: null });
  const res = responseMock();

  await handler(request('login'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.page.id, 'page-login');
  assert.deepEqual(res.body.elements, []);
  assert.equal(track.lookup, 'maybeSingle');
});

test('bare microsite pages remain excluded from the public slug endpoint', async () => {
  const page = pageRow('login', { microsite_id: 'microsite-a' });
  const handler = handlerFor({ page });
  const res = responseMock();

  await handler(request('login'), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Page not found or not published' });
});

test('non-login lookup keeps existing single-query error behavior', async () => {
  const track = {};
  const handler = handlerFor({
    track,
    page: null,
    pageError: { code: 'PGRST116', message: 'not found' },
  });
  const res = responseMock();

  await handler(request('about'), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Page not found or not published' });
  assert.equal(track.lookup, 'single');
});
