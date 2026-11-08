import { test, expect } from '@playwright/test';
import {
  installSymbolFixture, symbolDesign, positioned, visitEditor, readyContent,
  symbolEditor, selectBlock, saveContent, closeContent, assertSafe,
} from './fixtures/canvas-symbol-content.task4903.fixture.mjs';

async function geometry(editor, id, info) {
  const input = editor.getByTestId(id);
  await input.scrollIntoViewIfNeeded();
  const measured = await input.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const parent = node.parentElement.getBoundingClientRect();
    const pane = node.closest('[data-testid="panel-inspector"]');
    const buttons = [...node.parentElement.querySelectorAll('button[title]')].map(button => {
      const box = button.getBoundingClientRect();
      return { width: box.width, top: box.top, right: box.right };
    });
    return { width: rect.width, available: parent.width, bottom: rect.bottom, right: parent.right,
      paneWidth: pane.getBoundingClientRect().width, overflow: pane.scrollWidth - pane.clientWidth, buttons };
  });
  await info.attach(id, { body: JSON.stringify(measured), contentType: 'application/json' });
  expect(measured.paneWidth).toBeLessThanOrEqual(288);
  expect(measured.width).toBeGreaterThan(150);
  expect(Math.abs(measured.width - measured.available)).toBeLessThan(2);
  expect(measured.overflow).toBeLessThanOrEqual(1);
  for (const button of measured.buttons) {
    expect(button.width).toBeGreaterThanOrEqual(32);
    expect(button.top).toBeGreaterThanOrEqual(measured.bottom);
    expect(button.right).toBeLessThanOrEqual(measured.right + 1);
  }
}

for (const surface of [
  { type: 'mega-menu', content: { items: [{ label: 'Menu', hasPanel: true, columns: [{ heading: 'Column', links: [{ label: 'Link', href: '/nested' }] }] }] }, ids: ['mega-item-0-col-0-link-0-href', 'mega-item-0-featured-href'] },
  { type: 'payment-details', content: {}, ids: ['membership-manage-link', 'membership-renewal-link'] },
  { type: 'sponsor-grid', content: {}, ids: ['input-sponsor-grid-empty-cat-cta-href'] },
  { type: 'advanced-accordion', content: { items: [{ id: 'item', title: 'Panel', children: [positioned('nested-button', 'button', { label: 'Nested', href: '/nested' }, [0, 0, 200, 50])] }] }, ids: ['input-button-href'], child: true },
]) {
  test(`delegated inspector geometry: ${surface.type}`, async ({ page }, info) => {
    const design = symbolDesign();
    design.root.sections[0].children[0].anchorId = 'details';
    design.root.sections[0].children[1] = positioned('subject', surface.type, surface.content, [0, 140, 500, 300]);
    design.root.sections[0].children.splice(2);
    const { state } = await installSymbolFixture(page, { design });
    await visitEditor(page);
    await readyContent(page);
    const editor = symbolEditor(page);
    await selectBlock(editor, 'subject');
    if (surface.child) await editor.getByTestId('panel-inspector').getByRole('button', { name: 'nested-button', exact: true }).click();
    for (const id of surface.ids) await geometry(editor, id, info);
    assertSafe(state);
  });
}

for (const anchors of [false, true]) {
  test(`narrow real inspector links, anchors=${anchors}`, async ({ page }, info) => {
    const design = symbolDesign();
    const children = design.root.sections[0].children;
    if (anchors) children[0].anchorId = 'details';
    children.push(
      positioned('faq', 'accordion', { items: [{ q: 'Question', a: '<p>Answer</p>', links: [{ label: 'Read', url: '/faq' }] }] }, [0, 370, 500, 200]),
      positioned('carousel', 'hero-carousel', { slides: [{ id: 'slide', headerText: 'Slide', ctaText: 'Read more', ctaLink: '/slide' }] }, [0, 600, 500, 250]),
    );
    const { state } = await installSymbolFixture(page, { design });
    await visitEditor(page);
    await readyContent(page);
    const editor = symbolEditor(page);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1200, height: 800 }]) {
      await page.setViewportSize(viewport);
      for (const [block, id] of [['symbol-button', 'input-button-href'], ['faq', 'accordion-0-link-0-url'], ['carousel', 'hcc-slide-0-cta-link']]) {
        await selectBlock(editor, block);
        await geometry(editor, id, info);
        await expect(editor.getByTestId(`${id}-anchor-picker`)).toHaveCount(anchors ? 1 : 0);
        if (block === 'carousel') {
          const text = await editor.getByTestId('hcc-slide-0-cta-text').boundingBox();
          const link = await editor.getByTestId(id).boundingBox();
          expect(link.y).toBeGreaterThan(text.y + text.height);
          expect(link.width).toBeCloseTo(text.width, 0);
        }
      }
    }
    await selectBlock(editor, 'symbol-button');
    const input = editor.getByTestId('input-button-href');
    const longUrl = `https://example.invalid/${'long-path/'.repeat(35)}?query=value`;
    await input.fill(longUrl);
    await input.press('End');
    expect(await input.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await editor.getByTestId('input-button-href-newtab').click();
    if (anchors) {
      await editor.getByTestId('input-button-href-anchor-picker').click();
      await page.getByTestId('anchor-option-details').click();
      await expect(input).toHaveValue('#details');
      await input.fill(longUrl);
    }
    await saveContent(page, state);
    await closeContent(page);
    await readyContent(page);
    await selectBlock(editor, 'symbol-button');
    await expect(input).toHaveValue(longUrl);
    await expect(editor.getByTestId('input-button-href-newtab')).toBeChecked();
    await page.screenshot({ path: info.outputPath('narrow-link.png') });
    await selectBlock(editor, 'symbol-text');
    const rte = editor.getByTestId('input-text-content');
    await rte.getByTitle('Add link', { exact: true }).click();
    const inline = rte.getByTestId('rte-link-input');
    await inline.fill(longUrl);
    const sizes = await inline.evaluate(node => ({
      width: node.clientWidth, parent: node.parentElement.clientWidth,
      overflow: node.closest('[data-testid="panel-inspector"]').scrollWidth - node.closest('[data-testid="panel-inspector"]').clientWidth,
    }));
    expect(sizes.parent - sizes.width).toBeLessThan(12);
    expect(sizes.width).toBeGreaterThan(180);
    expect(sizes.overflow).toBeLessThanOrEqual(1);
    await rte.getByTestId('rte-link-confirm').click();
    assertSafe(state);
  });
}
