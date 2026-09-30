import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { wrapEmailFooter } from './emailFooterLayout.js';

const FOOTER_HTML = '<table data-footer-fixture="outer" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:100%;background-color:#17324d;"><tr><td style="color:#f6c344;padding:7px;"><table data-footer-fixture="nested" role="presentation" width="100%" style="width:100%;max-width:100%;background-color:#264f73;"><tr><td><img data-footer-image src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22900%22 height=%22180%22%3E%3Crect width=%22900%22 height=%22180%22 fill=%22%23c94c4c%22/%3E%3C/svg%3E" width="900" alt="Wide footer fixture" style="display:block;max-width:100%;height:auto;"><span data-footer-text>Footer fixture text</span> <a data-footer-link href="https://example.invalid/footer?source=regression" style="color:#7ee0c3;">Footer fixture link</a></td></tr></table></td></tr></table>';

const launchChromium = async (t) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    t.skip('Playwright is not installed');
    return null;
  }

  const pathChromium = String(process.env.PATH || '')
    .split(':')
    .map(directory => join(directory, 'chromium'))
    .find(existsSync);
  const executables = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    pathChromium,
    undefined,
  ].filter((value, index, values) => values.indexOf(value) === index);

  for (const executablePath of executables) {
    try {
      return await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
    } catch {
      // Try the environment-supported binary, then Playwright's bundled one.
    }
  }
  t.skip('No runnable Chromium binary is available');
  return null;
};

const removeStylesheets = page => page.evaluate(() => {
  document.querySelectorAll('style, link[rel~="stylesheet"]').forEach(node => node.remove());
});

test('generated source has a fluid wrapper, fixed-width MSO ghost, and unchanged inner HTML', () => {
  for (const width of [500, 600, 700]) {
    const wrapped = wrapEmailFooter(FOOTER_HTML, width);

    assert.match(
      wrapped,
      new RegExp(`<!--\\[if mso\\]><table[^>]*\\bwidth="${width}"[^>]*style="width:${width}px;"`),
      `${width}px MSO ghost table has matching attribute and CSS dimensions`,
    );
    assert.match(
      wrapped,
      new RegExp(`<table[^>]*\\bwidth="100%"[^>]*style="width:100%;max-width:${width}px;margin:0 auto;"`),
      `${width}px modern-client wrapper remains fluid and centered`,
    );
    assert.match(wrapped, /<td style="padding:12px 0;">/);
    assert.equal(wrapped.split(FOOTER_HTML).length - 1, 1, 'footer HTML is inserted byte-for-byte exactly once');
    assert.equal(
      wrapped.slice(
        wrapped.indexOf('<td style="padding:12px 0;">') + '<td style="padding:12px 0;">'.length,
        wrapped.indexOf('</td></tr></table><!--[if mso]>'),
      ),
      FOOTER_HTML,
      'the wrapper does not rewrite already-constrained footer HTML',
    );
  }
});

test('default and invalid content widths consistently use 600 pixels', () => {
  const invalidWidths = [undefined, null, '', 'not-a-width', 0, -1, 1.5, Infinity, '600em'];
  for (const width of invalidWidths) {
    const wrapped = wrapEmailFooter(FOOTER_HTML, width);
    assert.match(wrapped, /\bwidth="600" style="width:600px;"/, `${String(width)} gets a 600px MSO ghost`);
    assert.match(wrapped, /\bwidth="100%" style="width:100%;max-width:600px;margin:0 auto;"/);
    assert.equal(wrapped.split(FOOTER_HTML).length - 1, 1);
  }

  const pixelString = wrapEmailFooter(FOOTER_HTML, '500px');
  assert.match(pixelString, /\bwidth="500" style="width:500px;"/);
  assert.match(pixelString, /max-width:500px/);
});

test('optional Chromium matrix: footer is centered, constrained, preserved, and overflow-free with or without stylesheets', async (t) => {
  const browser = await launchChromium(t);
  if (!browser) return;
  t.after(() => browser.close());

  for (const configuredWidth of [500, 600, 700]) {
    const wrapped = wrapEmailFooter(FOOTER_HTML, configuredWidth);
    for (const viewportWidth of [320, 375, 479, 480, 481, 1000]) {
      for (const cssEnabled of [true, false]) {
        const page = await browser.newPage({ viewport: { width: viewportWidth, height: 900 } });
        await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;} body{background:#eee;}</style></head><body>${wrapped}</body></html>`);
        if (!cssEnabled) await removeStylesheets(page);
        await page.locator('[data-footer-image]').waitFor({ state: 'visible' });

        const layout = await page.evaluate(() => {
          const tables = [...document.querySelectorAll('table')];
          const wrapper = tables.find(table => table.style.maxWidth && !table.dataset.footerFixture);
          const footer = document.querySelector('[data-footer-fixture="outer"]');
          const nested = document.querySelector('[data-footer-fixture="nested"]');
          const image = document.querySelector('[data-footer-image]');
          const text = document.querySelector('[data-footer-text]');
          const link = document.querySelector('[data-footer-link]');
          const rect = element => element.getBoundingClientRect().toJSON();
          return {
            viewportWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            body: rect(document.body),
            wrapper: rect(wrapper),
            footer: rect(footer),
            nested: rect(nested),
            image: rect(image),
            text: text.textContent,
            linkText: link.textContent,
            linkHref: link.getAttribute('href'),
            outerColor: getComputedStyle(footer).backgroundColor,
            textColor: getComputedStyle(footer.querySelector('td')).color,
            linkColor: getComputedStyle(link).color,
          };
        });
        const context = `${configuredWidth}px footer, ${viewportWidth}px viewport, CSS ${cssEnabled ? 'on' : 'off'}`;
        const availableWidth = Math.min(configuredWidth, layout.body.width);
        const leftGap = layout.wrapper.left - layout.body.left;
        const rightGap = layout.body.right - layout.wrapper.right;

        assert.ok(layout.scrollWidth <= layout.viewportWidth, `${context}: no document overflow`);
        assert.ok(Math.abs(layout.wrapper.width - availableWidth) <= 1, `${context}: fluid/max width`);
        assert.ok(Math.abs(leftGap - rightGap) <= 1, `${context}: centered`);
        for (const [name, box] of [
          ['footer', layout.footer],
          ['nested table', layout.nested],
          ['900px image', layout.image],
        ]) {
          assert.ok(box.left >= layout.wrapper.left - 1, `${context}: ${name} left bound`);
          assert.ok(box.right <= layout.wrapper.right + 1, `${context}: ${name} right bound`);
        }
        assert.ok(layout.image.width <= layout.wrapper.width + 1, `${context}: wide image is constrained`);
        assert.equal(layout.text, 'Footer fixture text', `${context}: text preserved`);
        assert.equal(layout.linkText, 'Footer fixture link', `${context}: link text preserved`);
        assert.equal(layout.linkHref, 'https://example.invalid/footer?source=regression', `${context}: link target preserved`);
        assert.equal(layout.outerColor, 'rgb(23, 50, 77)', `${context}: outer color preserved`);
        assert.equal(layout.textColor, 'rgb(246, 195, 68)', `${context}: text color preserved`);
        assert.equal(layout.linkColor, 'rgb(126, 224, 195)', `${context}: link color preserved`);
        await page.close();
      }
    }
  }
});