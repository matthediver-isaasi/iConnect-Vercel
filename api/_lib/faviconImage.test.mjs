import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { normalizeFavicon, tenantFaviconImage, faviconSource, FALLBACK_ICON, publicLookup, downloadFavicon } from './faviconImage.js';
import { createFaviconHandler } from '../public/favicon.js';
import { createManifestHandler } from '../public/manifest.js';
import { FAVICON_PATHS, faviconSize } from '../../shared/tenantFavicon.js';
import middleware, { config } from '../../middleware.js';
import { createPageTenantResolver } from './pageTenantResolver.js';

const source = 'https://example.supabase.co/storage/v1/object/public/files/icon.png';
const tenant = { id: 'a', name: 'Alpha', favicon_url: source };
const solid = (width, height, color = '#ff0000') => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
const response = () => ({ headers: {}, statusCode: 200,
  setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; },
  end(body) { this.body = body; return this; },
});

test('GFI-shaped 67x60 image is proportionally fitted with transparent padding', async () => {
  const out = await normalizeFavicon(await solid(67, 60), 192);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 192); assert.equal(info.height, 192);
  let top = 192, bottom = -1, left = 192, right = -1;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 192; x++) {
    if (data[(y * 192 + x) * 4 + 3]) {
      top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x);
    }
  }
  assert.equal(right - left + 1, 192);
  assert.ok(Math.abs((bottom - top + 1) - 192 * 60 / 67) <= 1);
  assert.ok(top > 0 && bottom < 191);
});

test('square PNG, SVG and legacy ICO inputs yield real PNG variants', async () => {
  const ico = fs.readFileSync('client/public/favicon.ico');
  for (const bytes of [await solid(48, 48), FALLBACK_ICON, ico]) {
    for (const size of [32, 180, 192, 512]) {
      const meta = await sharp(await normalizeFavicon(bytes, size)).metadata();
      assert.equal(meta.format, 'png'); assert.equal(meta.width, size); assert.equal(meta.height, size);
    }
  }
});

test('source allowlist refuses credentials, redirects targets, private hosts, local recursion and URL tricks', () => {
  assert.ok(faviconSource(source));
  for (const url of ['/favicon.ico', 'https://127.0.0.1/a', 'http://example.supabase.co/storage/v1/object/public/a',
    'https://example.supabase.co.evil.test/storage/v1/object/public/a', 'https://user@example.supabase.co/storage/v1/object/public/a',
    'https://example.supabase.co:8443/storage/v1/object/public/a', 'https://example.supabase.co/api/public/favicon',
    `${source}?url=http://localhost`, 'https://example.supabase.co/storage/v1/object/public/%2e%2e/private/a']) {
    assert.equal(faviconSource(url), null, url);
  }
});

test('DNS answers are checked and pinned; private and mixed public/private answers fail closed', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'fd00::1']) {
    await assert.rejects(new Promise((resolve, reject) => publicLookup('example.supabase.co', {},
      (err, value) => err ? reject(err) : resolve(value),
      (_host, _opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]))));
  }
  const pinned = await new Promise((resolve, reject) => publicLookup('example.supabase.co', {},
    (err, address) => err ? reject(err) : resolve(address),
    (_host, _opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }])));
  assert.equal(pinned, '8.8.8.8');
});

test('download rejects redirects and oversized streamed or declared payloads', async () => {
  for (const kind of ['redirect', 'declared', 'streamed']) {
    let calls = 0;
    const request = (_url, options, callback) => {
      calls++;
      assert.equal(options.lookup, publicLookup);
      const req = new EventEmitter();
      req.destroy = err => { if (err) req.emit('error', err); req.emit('close'); };
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = kind === 'redirect' ? 302 : 200;
        res.headers = kind === 'declared' ? { 'content-length': 3 * 1024 * 1024 } : { location: 'https://127.0.0.1/' };
        res.destroy = () => req.destroy();
        callback(res);
        if (kind === 'streamed') res.emit('data', Buffer.alloc(3 * 1024 * 1024));
      });
      return req;
    };
    await assert.rejects(downloadFavicon(new URL(source), request));
    assert.equal(calls, 1);
  }
});

test('malformed, unavailable, oversized, referenced SVG and absent images use the same neutral fallback', async () => {
  const fallback = await normalizeFavicon(FALLBACK_ICON, 192);
  for (const bytes of [Buffer.from('not an image'), Buffer.alloc(2 * 1024 * 1024 + 1),
    Buffer.from('<svg><image href="file:///etc/passwd"/></svg>')]) {
    assert.deepEqual(await tenantFaviconImage(tenant, 192, async () => bytes), fallback);
  }
  assert.deepEqual(await tenantFaviconImage(tenant, 192, async () => { throw new Error('unavailable'); }), fallback);
  assert.deepEqual(await tenantFaviconImage(null, 192), fallback);
  assert.deepEqual(await tenantFaviconImage({ id: 'b' }, 192), fallback);
});

test('two tenants and changed source (including replacement at same URL) cannot reuse derived output', async () => {
  let color = '#ff0000';
  const download = async () => solid(67, 60, color);
  const a = await tenantFaviconImage(tenant, 192, download);
  color = '#0000ff';
  const b = await tenantFaviconImage({ ...tenant, id: 'b' }, 192, download);
  assert.notDeepEqual(a, b);
  assert.deepEqual(await tenantFaviconImage(tenant, 192, download), b);
  assert.deepEqual(await tenantFaviconImage({ ...tenant, favicon_url: source.replace('icon', 'new') }, 192, download), b);
});

test('legacy GET/HEAD paths and manifest preserve host authority, dimensions, format and no-store', async () => {
  const resolveTenant = async (_req, options) => { assert.equal(options.fresh, true); return tenant; };
  const handler = createFaviconHandler({ resolveTenant, image: (_tenant, size) => normalizeFavicon(FALLBACK_ICON, size) });
  for (const path of FAVICON_PATHS) {
    assert.ok(config.matcher.includes(path));
    for (const method of ['GET', 'HEAD']) {
      const res = response();
      await handler({ method, url: path, headers: {} }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'image/png');
      assert.match(res.headers['Cache-Control'], /no-store/);
      if (method === 'HEAD') assert.equal(res.body, undefined);
      else assert.equal((await sharp(res.body).metadata()).width, faviconSize(path));
    }
  }
  for (const value of [tenant, { id: 'b', name: 'Beta' }, null]) {
    const res = response();
    await createManifestHandler({ resolveTenant: async () => value })({ method: 'GET' }, res);
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.name, value?.name || 'iConn');
    assert.equal(manifest.display, 'standalone'); assert.equal(manifest.start_url, '/');
    assert.deepEqual(manifest.icons.map(i => i.sizes), ['192x192', '512x512']);
  }
  const resolver = createPageTenantResolver({ resolveHost: async host => host === 'alpha.test' ? tenant : null,
    resolveRequest: async () => { throw new Error('Query override attempted'); } });
  assert.equal(await resolver({ headers: { host: 'unknown.test' }, query: { tenant: 'alpha' } }), null);
});

test('middleware routes every icon before static assets, forwards HEAD and never falls back to shipped assets on error', async () => {
  const saved = globalThis.fetch;
  try {
    for (const path of [...FAVICON_PATHS, '/site.webmanifest']) {
      globalThis.fetch = async (url, options) => {
        assert.equal(new URL(url).pathname, path.endsWith('webmanifest') ? '/api/public/manifest' : '/api/public/favicon');
        assert.equal(new URL(url).searchParams.get('path'), path);
        assert.equal(options.method, 'HEAD');
        return new Response(null, { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' } });
      };
      const res = await middleware(new Request(`https://alpha.test${path}`, { method: 'HEAD' }));
      assert.equal(res.status, 200); assert.equal(await res.text(), '');
    }
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal((await middleware(new Request('https://alpha.test/favicon.png'))).status, 503);
  } finally { globalThis.fetch = saved; }
});

test('hydration writers never restore raw configured artwork', () => {
  const context = fs.readFileSync('client/src/contexts/TenantBrandingContext.jsx', 'utf8');
  const layout = fs.readFileSync('client/src/pages/Layout.jsx', 'utf8');
  assert.doesNotMatch(context, /\.href = data\.branding\.faviconUrl/);
  assert.match(layout, /const faviconUrl = '\/favicon-192.png'/);
  assert.match(fs.readFileSync('client/index.html', 'utf8'), /sizes="192x192" href="\/favicon-192.png"/);
});
