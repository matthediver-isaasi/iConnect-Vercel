import { test, expect } from '@playwright/test';
import { installSymbolFixture, visitEditor, pageId } from './fixtures/canvas-symbol-content.task4903.fixture.mjs';

const preview = (view = 'member', nonce = 0) => `<!doctype html><html><head></head><body>
<header><button id="shell"></button></header><main>
<div data-block-id="parent-text"><img id="duplicate" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></div>
<p style="color:#aaa;background:white">Low contrast text</p></main>
<script type="module">
import { installPreviewAudit } from '/src/lib/canvasRenderedAudit.js';
window.dispose = installPreviewAudit({pageId:'${pageId}',nonce:${nonce},view:'${view}'});
parent.postMessage({type:'canvas-preview-ready',nonce:${nonce},publicView:${view === 'public'}},location.origin);
</script></body></html>`;

test('real axe runs in iframe realm, excludes editor and retains exact evidence and paths', async ({ page }) => {
  await page.route('**/__audit-parent', r => r.fulfill({ contentType: 'text/html', body: '<html lang="en"><title>Editor</title><body><button id="editor-only"></button><img id="duplicate"><iframe src="/__audit-frame"></iframe></body></html>' }));
  await page.route('**/__audit-frame', r => r.fulfill({ contentType: 'text/html', body: preview() }));
  await page.goto('/__audit-parent');
  await expect.poll(() => page.frames()[1]?.evaluate(() => !!window.__canvasPreviewAudit)).toBe(true);
  const result = await page.evaluate(async () => {
    const lib = await import('/src/lib/canvasRenderedAudit.js');
    const iframe = document.querySelector('iframe'), doc = iframe.contentDocument, runner = iframe.contentWindow.__canvasPreviewAudit;
    const signal = { document: doc, runner };
    lib.assertPreviewIdentity(iframe, signal, {pageId: runner.pageId, nonce: 0, view:'member'});
    const issues = lib.mapAuditResults(await runner.run(), doc, new Map([['parent-text','Text block']]), 'member');
    const mapped = issues.find(i => i.rule === 'axe:image-alt');
    const target = lib.verifiedAuditTarget(doc, mapped);
    const clear = lib.highlightAuditTarget(target);
    const animated = target.getAnimations().length;
    clear();
    target.setAttribute('alt', 'changed');
    let stale = false, wrongView = false, notReady = false;
    try { lib.verifiedAuditTarget(doc, mapped); } catch { stale = true; }
    try { lib.assertPreviewIdentity(iframe, signal, {pageId: runner.pageId, nonce:0, view:'public'}); } catch { wrongView = true; }
    try { lib.assertPreviewIdentity(iframe, null, {pageId: runner.pageId, nonce:0, view:'member'}); } catch { notReady = true; }
    const host = doc.createElement('div'); host.id = 'shadow'; doc.body.append(host);
    host.attachShadow({mode:'open'}).innerHTML = '<button id="nested">Nested</button>';
    const shadow = lib.resolveAuditTarget(doc, [['#shadow','#nested']])?.textContent;
    const nestedFrame = doc.createElement('iframe'); nestedFrame.id = 'nested-frame'; doc.body.append(nestedFrame);
    nestedFrame.contentDocument.body.innerHTML = '<button id="nested">Frame</button>';
    const nested = lib.resolveAuditTarget(doc, ['#nested-frame','#nested'])?.textContent;
    iframe.contentWindow.dispose();
    let replaced = false;
    try { lib.assertPreviewIdentity(iframe, signal, {pageId: runner.pageId, nonce:0, view:'member'}); } catch { replaced = true; }
    return {issues, animated, stale, wrongView, notReady, shadow, nested, replaced};
  });
  expect(JSON.stringify(result.issues)).not.toContain('editor-only');
  expect(result.issues.find(i => i.rule === 'axe:image-alt').blockId).toBe('parent-text');
  expect(result.issues.find(i => i.rule === 'axe:button-name').scope).toBe('element');
  expect(result.issues.find(i => i.rule === 'axe:html-has-lang').scope).toBe('document');
  expect(result.issues.find(i => i.rule === 'axe:color-contrast').checks.some(c => c.data?.contrastRatio)).toBe(true);
  expect(result).toMatchObject({animated:1, stale:true, wrongView:true, notReady:true, replaced:true, shadow:'Nested', nested:'Frame'});
});

for (const mode of ['dual', 'not-ready', 'replaced']) {
  test(`editor ${mode} run keeps view attribution and never saves a failed pass`, async ({page}) => {
    const fixture = await installSymbolFixture(page);
    fixture.record.layout_type = mode === 'dual' ? 'hybrid' : 'member';
    const saved = [];
    await page.route(`**/api/canvas-page-audits/${pageId}**`, r => {
      if (r.request().method() === 'POST') saved.push(r.request().postDataJSON());
      return r.fulfill({contentType:'application/json',body:'{"runs":[]}'});
    });
    await page.route(`**/${pageId}?**`, r => {
      const url = new URL(r.request().url());
      let body = preview(url.searchParams.get('_publicView') === '1' ? 'public':'member', Number(url.searchParams.get('_canvasPreview')));
      if (mode === 'not-ready') body = '<html><body>Loading</body></html>';
      if (mode === 'replaced') body = body.replace('parent.postMessage', `window.__canvasPreviewAudit.run = async () => {
        window.dispose(); return {violations:[]};
      }; parent.postMessage`);
      return r.fulfill({contentType:'text/html',body});
    });
    await visitEditor(page);
    await page.getByTestId('button-run-full-audit').click();
    if (mode === 'dual') {
      await expect.poll(() => saved.length, {timeout:20000}).toBe(1);
      expect(saved[0].viewsAudited).toEqual(['member','public']);
      expect(new Set(saved[0].issues.map(i => i.view))).toEqual(new Set(['member','public']));
      await page.getByTestId('button-modal-run-audit').click();
      await expect.poll(() => saved.length, {timeout:20000}).toBe(2);
    } else {
      await expect(page.getByTestId('button-modal-run-audit')).toHaveText('Run full audit', {timeout:15000});
      await expect(page.getByTestId('button-audit-summary')).toContainText('incomplete', {timeout:15000});
      expect(saved).toEqual([]);
    }
  });
}

test('editor audit Locate reaches the editable block and shell action opens preview', async ({ page }) => {
  await installSymbolFixture(page);
  const saved = [];
  await page.route(`**/api/canvas-page-audits/${pageId}**`, r => {
    if (r.request().method() === 'POST') saved.push(r.request().postDataJSON());
    return r.fulfill({ contentType:'application/json', body: JSON.stringify({runs:[]}) });
  });
  await page.route(`**/${pageId}?**`, r => {
    const url = new URL(r.request().url());
    return r.fulfill({contentType:'text/html',body:preview(url.searchParams.get('_publicView') === '1' ? 'public':'member', Number(url.searchParams.get('_canvasPreview')))});
  });
  await visitEditor(page);
  await page.getByTestId('button-run-full-audit').click();
  await expect.poll(() => saved.length).toBe(1);
  await page.getByTestId('dialog-preview-audit').getByRole('button', {name:'Close',exact:true}).click();
  await page.getByTestId('button-audit-summary').click();
  await page.getByTestId('a11y-issue-locate-axe:image-alt').click();
  await expect(page.getByTestId('input-block-name')).toHaveValue('parent-text');
  await expect(page.getByTestId('canvas-block-parent-text')).toHaveClass(/canvas-locate-pulse/);
  await page.getByTestId('button-audit-summary').click();
  await page.getByTestId('a11y-issue-axe:button-name').getByRole('button',{name:'Show in preview'}).click();
  await expect.poll(() => page.frames().some(f => f.url().includes(`/${pageId}?`))).toBe(true);
  const frame = page.frames().find(f => f.url().includes(`/${pageId}?`));
  await expect.poll(() => frame.locator('#shell').evaluate(el => el.getAnimations().length)).toBe(1);
});
