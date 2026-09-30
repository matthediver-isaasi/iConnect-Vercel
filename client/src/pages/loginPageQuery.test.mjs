import test from 'node:test';
import assert from 'node:assert/strict';
import { getOptionalLoginPage } from './loginPageQuery.js';
import { publicClient } from '../api/publicClient.js';

test('optional login resolution uses real public API error metadata without changing other page reads', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let respond;
  globalThis.fetch = async (url) => {
    requests.push(url);
    return respond();
  };
  const reply = (status, body) => {
    respond = () => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await t.test('missing/unpublished optional login resolves as a successful default', async () => {
      reply(404, { error: 'Page not found or not published' });
      assert.equal(await getOptionalLoginPage(), null);
      assert.equal(requests.at(-1), '/api/public/page/login');
      await assert.rejects(publicClient.getPage('other-page'), {
        status: 404,
        errorData: { error: 'Page not found or not published' },
      });
    });

    await t.test('published page payload and symbols pass through unchanged', async () => {
      const payload = {
        page: { builder_type: 'canvas', status: 'published', public_chrome: 'footer' },
        symbols: [{ id: 'fixture-symbol' }],
      };
      reply(200, payload);
      assert.deepEqual(await getOptionalLoginPage(), payload);
    });

    for (const [status, error] of [
      [404, 'Tenant not found'],
      [404, 'Microsite not found'],
      [404, 'Not found'],
      [403, 'Forbidden'],
      [500, 'Page not found or not published'],
      [503, 'Database not configured'],
    ]) {
      await t.test(`${status} ${error} remains a failure`, async () => {
        reply(status, { error });
        await assert.rejects(getOptionalLoginPage(), { status, errorData: { error } });
      });
    }

    await t.test('plain-text proxy 404 cannot impersonate the page response', async () => {
      respond = () => new Response('Page not found or not published', { status: 404 });
      await assert.rejects(getOptionalLoginPage(), { status: 404, errorData: null });
    });

    await t.test('network and malformed-response failures are not absence', async () => {
      respond = () => { throw new TypeError('Failed to fetch'); };
      await assert.rejects(getOptionalLoginPage(), /Network Error: Failed to fetch/);
      respond = () => new Response('<html>Bad gateway</html>', { status: 200 });
      await assert.rejects(getOptionalLoginPage(), SyntaxError);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});