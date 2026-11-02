// Controlled local receivers only; no tenant session, provider calls or live data.
// Run: node --import tsx --test tests/portal-menu-referrers.browser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PortalNavLink from '../client/src/components/navigation/PortalNavLink.jsx';
import { resolvePortalMenuDestination } from '../client/src/lib/portalMenuLinks.js';

test('portal anchors transmit only origin, isolate opener, and suppress downgrade referrers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-referrers-'));
  const received = [];
  let browser;
  let secure;
  let insecure;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=portal.test'], { stdio: 'ignore' });
    const meta = readFileSync('client/index.html', 'utf8')
      .match(/<meta name="referrer" content="no-referrer"\s*\/?>/)?.[0];
    assert.ok(meta, 'document privacy default must remain unchanged');
    let markup = '';
    const handler = (req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url.startsWith('/member/private')) {
        res.end(`<!doctype html><html><head>${meta}</head><body>${markup}</body></html>`);
      } else {
        received.push({ url: req.url, referer: req.headers.referer });
        res.end('<!doctype html><title>Local receiver</title>Received');
      }
    };
    secure = https.createServer({
      key: readFileSync(join(dir, 'key.pem')),
      cert: readFileSync(join(dir, 'cert.pem')),
    }, handler);
    insecure = http.createServer(handler);
    await Promise.all([secure, insecure].map(server =>
      new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
    const origin = `https://portal.test:${secure.address().port}`;
    const source = `${origin}/member/private?member=private-value#private-fragment`;
    browser = await chromium.launch({
      executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
      headless: true,
      args: ['--no-sandbox', '--no-proxy-server',
        '--host-resolver-rules=MAP portal.test 127.0.0.1, MAP destination.test 127.0.0.1'],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    let count = 0;
    for (const mobile of [false, true]) {
      for (const section of ['user', 'admin']) {
        for (const nested of [false, true]) {
          for (const newTab of [false, true]) {
            for (const protocol of ['https', 'http']) {
              const id = `/received-${++count}`;
              const port = protocol === 'https' ? secure.address().port : insecure.address().port;
              const destination = resolvePortalMenuDestination({
                section, parent_id: nested ? 'parent' : '', link_type: 'external',
                url: `${protocol}://destination.test:${port}${id}`,
                open_in_new_tab: newTab,
              });
              markup = renderToStaticMarkup(React.createElement(PortalNavLink,
                { destination, id: 'subject' }, 'Journal'));
              const page = await context.newPage();
              await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
              await page.goto(source);
              assert.equal(await page.locator('#subject').getAttribute('referrerpolicy'), 'strict-origin');
              let target = page;
              if (newTab) {
                [target] = await Promise.all([context.waitForEvent('page'), page.locator('#subject').click()]);
              } else {
                await page.locator('#subject').click();
              }
              await target.waitForURL(destination.url);
              await target.waitForLoadState();
              const request = received.find(row => row.url === id);
              assert.ok(request, `${id}: receiver must see actual request`);
              assert.equal(request.referer, protocol === 'https' ? `${origin}/` : undefined,
                JSON.stringify({ mobile, section, nested, newTab, protocol }));
              if (newTab) {
                assert.equal(await target.evaluate(() => window.opener === null), true);
                await target.close();
              }
              await page.close();
            }
          }
        }
      }
    }
    // A non-portal anchor continues to inherit no-referrer.
    markup = `<a id="subject" href="${origin}/control">Ordinary link</a>`;
    const page = await context.newPage();
    await page.goto(source);
    await page.locator('#subject').click();
    await page.waitForURL(`${origin}/control`);
    assert.equal(received.find(row => row.url === '/control')?.referer, undefined);
    assert.ok(received.some(row => row.url === '/control'));
    await context.close();
    console.log(`Verified ${count} menu/tab/protocol combinations and document-default control.`);
  } finally {
    await browser?.close();
    await Promise.all([secure, insecure].filter(Boolean).map(server =>
      new Promise(resolve => server.close(resolve))));
    rmSync(dir, { recursive: true, force: true });
  }
});
