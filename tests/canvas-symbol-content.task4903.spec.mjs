import { test, expect } from '@playwright/test';
import {
  installSymbolFixture, symbolId, pageId, symbolDesign, positioned,
  parentEditor, symbolEditor, savedBlock, visitEditor, openContent, readyContent,
  selectBlock, editRichText, saveContent, closeContent, assertSafe,
} from './fixtures/canvas-symbol-content.task4903.fixture.mjs';

const meta = 'Meta';
const parentSave = page => parentEditor(page).getByTestId('button-save');
const blur = page => page.keyboard.press('Tab');
const stageBlocks = editor => editor.getByTestId('canvas-stage').locator('[data-testid^="canvas-block-"][data-block-id]');

async function dispatchBlockedShortcuts(page) {
  // No text-input exclusion can hide a builder isolation bug: these events
  // target window directly while a nested modal owns interaction.
  await page.evaluate(() => {
    document.activeElement?.blur();
    for (const event of [
      { key: 'Delete' },
      { key: 's', metaKey: true },
      { key: 'z', metaKey: true },
      { key: 'v', metaKey: true },
    ]) window.dispatchEvent(new KeyboardEvent('keydown', { ...event, bubbles: true, cancelable: true }));
  });
}

test('saved symbol opens without a page selection; Rename is a separate metadata-only operation', async ({ page }, info) => {
  const { state, originalSymbol } = await installSymbolFixture(page, { allowRename: true });
  await visitEditor(page);
  await expect(parentEditor(page).getByTestId('inspector-empty')).toBeVisible();
  await readyContent(page);
  const editor = symbolEditor(page);
  await expect(editor.getByRole('heading', { name: 'Edit symbol content — Saved shared banner' })).toBeVisible();
  await expect(editor).toContainText('including published pages');
  await expect(editor).toContainText('Detached copies do not change');
  await expect(editor.getByTestId('canvas-block-symbol-text')).toContainText('Saved shared heading');
  await expect(editor.getByTestId('button-save-symbol-content')).toBeDisabled();
  await selectBlock(editor, 'symbol-text');
  await page.screenshot({ path: info.outputPath('working-symbol-content-editor.png') });
  await closeContent(page);
  await expect(parentEditor(page).getByTestId('inspector-empty')).toBeVisible();
  expect(state.writes).toEqual([]);
  await parentEditor(page).getByTestId('button-open-symbols').click();
  await page.getByTestId(`button-rename-symbol-${symbolId}`).click();
  const row = page.getByTestId(`symbol-row-${symbolId}`);
  await row.getByTestId(`input-edit-symbol-name-${symbolId}`).fill('Renamed shared banner');
  await row.locator('button').filter({ has: page.locator('svg.lucide-save') }).click();
  await expect(row).toContainText('Renamed shared banner');
  expect(state.writes).toEqual([{ method: 'PATCH', path: `/api/canvas-symbols/${symbolId}`, body: { name: 'Renamed shared banner' } }]);
  expect(state.symbol.design).toEqual(originalSymbol.design);
  assertSafe(state);
});

test('normal inspector edits text, links, assets, appearance and responsive geometry; repeated saves keep hydrated draft and metadata', async ({ page }) => {
  const { state } = await installSymbolFixture(page);
  await visitEditor(page);
  await readyContent(page);
  const editor = symbolEditor(page);
  await selectBlock(editor, 'symbol-text');
  await editRichText(editor, 'First committed shared heading');
  await editor.getByTestId('input-w').fill('680');
  await editor.getByTestId('input-border-radius').fill('12');
  await editor.getByTestId('input-border-width').fill('3');
  await editor.getByTestId('input-opacity').fill('0.8');
  await editor.getByTestId('symbol-breakpoint-tablet').click();
  await editor.getByTestId('input-w').fill('420');
  await editor.getByTestId('input-h').fill('130');
  await editor.getByTestId('symbol-breakpoint-mobile').click();
  await editor.getByTestId('input-w').fill('340');
  await editor.getByTestId('input-h').fill('150');
  await editor.getByTestId('symbol-breakpoint-desktop').click();
  await expect(editor.getByTestId('input-w')).toHaveValue('680');
  await selectBlock(editor, 'symbol-button');
  await editor.getByTestId('input-button-label').fill('Updated shared CTA');
  await editor.getByTestId('input-button-href').fill('/updated-shared-target');
  await selectBlock(editor, 'symbol-image');
  await editor.getByTestId('button-browse-repository').click();
  await page.getByTestId('file-select-image-4903').click();
  await expect(editor.getByTestId('canvas-block-symbol-image').locator('img')).toHaveAttribute('src', '/__symbol4903/replacement.svg');
  await saveContent(page, state);
  const first = structuredClone(state.symbol.design);
  const text = savedBlock(state, 'symbol-text');
  expect(text.content.html).toContain('First committed shared heading');
  expect(text.content.extension).toBe('content metadata');
  expect(text.extension).toBe('block metadata');
  expect(text.bp.desktop.w).toBe(680);
  expect(text.bp.tablet).toMatchObject({ w: 420, h: 130 });
  expect(text.bp.mobile).toMatchObject({ w: 340, h: 150 });
  expect(text.style).toMatchObject({ borderRadius: 12, borderWidth: 3, opacity: 0.8 });
  expect(savedBlock(state, 'symbol-button').content).toMatchObject({ label: 'Updated shared CTA', href: '/updated-shared-target' });
  expect(savedBlock(state, 'symbol-image').content.src).toBe('/__symbol4903/replacement.svg');
  expect(first.extension).toEqual({ preserved: 'definition metadata' });
  expect(first.root.extension).toBe('root metadata');
  expect(first.root.sections[0].extension).toBe('section metadata');
  await selectBlock(editor, 'symbol-text');
  await expect(editor.getByTestId('input-w')).toHaveValue('680');
  await editRichText(editor, 'Second committed shared heading');
  await saveContent(page, state);
  expect(savedBlock(state, 'symbol-text').content.html).toContain('Second committed shared heading');
  for (const id of ['symbol-button', 'symbol-image']) {
    expect(savedBlock(state, id)).toEqual(first.root.sections[0].children.find(b => b.id === id));
  }
  expect(savedBlock(state, 'symbol-text').bp).toEqual(text.bp);
  await closeContent(page);
  await readyContent(page);
  await expect(editor.getByTestId('canvas-block-symbol-text')).toContainText('Second committed shared heading');
  await selectBlock(editor, 'symbol-text');
  await editor.getByTestId('symbol-breakpoint-mobile').click();
  await expect(editor.getByTestId('input-w')).toHaveValue('340');
  await expect(editor.getByTestId('input-h')).toHaveValue('150');
  expect(state.writes).toHaveLength(2);
  for (const write of state.writes) expect(Object.keys(write.body)).toEqual(['design']);
  assertSafe(state);
});

test('failed PATCH retains draft, selection and dirty state; retry commits only the symbol', async ({ page }) => {
  const { state, originalSymbol } = await installSymbolFixture(page, { failNextPatch: true });
  await visitEditor(page);
  await readyContent(page);
  const editor = symbolEditor(page);
  await selectBlock(editor, 'symbol-button');
  await editor.getByTestId('input-button-label').fill('Draft survives failure');
  await editor.getByTestId('button-save-symbol-content').click();
  await expect(editor.getByRole('alert')).toContainText('Fixture symbol save failed');
  await expect(editor.getByRole('alert')).toContainText('Your changes are still here');
  await expect(editor.getByTestId('input-button-label')).toHaveValue('Draft survives failure');
  await expect(editor.getByTestId('button-save-symbol-content')).toBeEnabled();
  expect(state.symbol).toEqual(originalSymbol);
  await saveContent(page, state);
  await expect(editor.getByRole('alert')).not.toBeVisible();
  expect(savedBlock(state, 'symbol-button').content.label).toBe('Draft survives failure');
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  await closeContent(page);
  await expect(parentSave(page)).toBeDisabled();
  assertSafe(state);
});

test('dirty cancel/escape prompts; Keep editing retains edits and Discard makes no PATCH', async ({ page }) => {
  const { state, originalSymbol } = await installSymbolFixture(page);
  await visitEditor(page);
  await readyContent(page);
  const editor = symbolEditor(page);
  await selectBlock(editor, 'symbol-button');
  await page.keyboard.press(`${meta}+c`);
  await editor.getByTestId('input-button-label').fill('Uncommitted draft');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toContainText('Discard symbol changes?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor.getByTestId('input-button-label')).toHaveValue('Uncommitted draft');
  await editor.getByRole('button', { name: 'Close', exact: true }).first().click();
  await dispatchBlockedShortcuts(page);
  await expect(stageBlocks(editor)).toHaveCount(3);
  await expect(editor.getByTestId('input-button-label')).toHaveValue('Uncommitted draft');
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.symbol).toEqual(originalSymbol);
  await readyContent(page);
  await selectBlock(editor, 'symbol-button');
  await expect(editor.getByTestId('input-button-label')).toHaveValue('Saved shared link');
  await expect(editor.getByTestId('button-save-symbol-content')).toBeDisabled();
  assertSafe(state);
});

test('parent dirty draft, selection and undo history survive symbol saves, delete, undo and paste; Cmd+S never saves page', async ({ page }) => {
  const { state } = await installSymbolFixture(page);
  await visitEditor(page);
  const parent = parentEditor(page);
  await selectBlock(parent, 'parent-button');
  await parent.getByTestId('input-button-label').fill('Unsaved parent CTA');
  await expect(parentSave(page)).toBeEnabled();
  await readyContent(page);
  const editor = symbolEditor(page);
  await selectBlock(editor, 'symbol-button');
  await editor.getByTestId('input-button-label').fill('Keyboard saved symbol CTA');
  await blur(page);
  await page.keyboard.press(`${meta}+s`);
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(editor.getByTestId('button-save-symbol-content')).toBeDisabled();
  // Clipboard shortcuts target only the foreground builder. Copies remain
  // linked to no page API and undo reverses each change in the symbol session.
  await selectBlock(editor, 'symbol-button');
  await page.keyboard.press(`${meta}+c`);
  await page.keyboard.press(`${meta}+v`);
  await expect(stageBlocks(editor)).toHaveCount(4);
  await page.keyboard.press(`${meta}+z`);
  await expect(stageBlocks(editor)).toHaveCount(3);
  await selectBlock(editor, 'symbol-image');
  await page.keyboard.press('Delete');
  await expect(editor.getByTestId('canvas-block-symbol-image')).not.toBeVisible();
  await page.keyboard.press(`${meta}+z`);
  await expect(editor.getByTestId('canvas-block-symbol-image')).toBeVisible();
  await closeContent(page);
  await expect(parent.getByTestId('input-block-name')).toHaveValue('parent-button');
  await expect(parent.getByTestId('input-button-label')).toHaveValue('Unsaved parent CTA');
  await expect(parentSave(page)).toBeEnabled();
  await expect(parent.getByTestId('canvas-block-parent-button')).toBeVisible();
  await expect(stageBlocks(parent)).toHaveCount(5);
  await parent.getByTestId('button-undo').click();
  await expect(parent.getByTestId('input-button-label')).toHaveValue('Parent link');
  await expect(parentSave(page)).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  assertSafe(state);
});

test('internal-page and file picker events are handled once and update only the active symbol', async ({ page }) => {
  const { state } = await installSymbolFixture(page);
  await visitEditor(page);
  const parent = parentEditor(page);
  await selectBlock(parent, 'parent-button');
  await readyContent(page);
  const editor = symbolEditor(page);
  await selectBlock(editor, 'symbol-button');
  await page.keyboard.press(`${meta}+c`);
  await editor.getByTestId('input-button-href-page-picker').click();
  await expect(page.getByRole('dialog').filter({ has: page.getByTestId('input-search-picker-pages') })).toHaveCount(1);
  await dispatchBlockedShortcuts(page);
  await expect(stageBlocks(editor)).toHaveCount(3);
  expect(state.writes).toEqual([]);
  await page.getByTestId('input-search-picker-pages').fill('Target internal page');
  await page.getByText('Target internal page', { exact: true }).click();
  await expect(editor.getByTestId('input-button-href')).toHaveValue('/target-4903');
  await editor.getByTestId('input-button-href-file-picker').click();
  await expect(page.getByTestId('input-file-browser-search')).toHaveCount(1);
  // The foreground builder must not process Delete/save/undo/paste while a
  // nested picker owns focus, even when the event comes from the document.
  await dispatchBlockedShortcuts(page);
  await expect(stageBlocks(editor)).toHaveCount(3);
  expect(state.writes).toEqual([]);
  await page.getByTestId('file-select-document-4903').click();
  await expect(editor.getByTestId('input-button-href')).toHaveValue('/__symbol4903/shared.pdf');
  await expect(editor.getByTestId('canvas-block-symbol-button')).toBeVisible();
  await saveContent(page, state);
  expect(savedBlock(state, 'symbol-button').content.href).toBe('/__symbol4903/shared.pdf');
  await closeContent(page);
  await expect(parent.getByTestId('input-button-href')).toHaveValue('/parent-original');
  await expect(parentSave(page)).toBeDisabled();
  assertSafe(state);
});

test('successful content save refreshes both linked renderings and bounds, retains symbol references and leaves detached blocks unchanged', async ({ page }) => {
  const { state, record } = await installSymbolFixture(page);
  await visitEditor(page);
  const parent = parentEditor(page);
  const linked = parent.getByTestId('canvas-block-linked-one');
  await expect(linked).toContainText('Saved shared heading');
  const beforeWidth = await linked.evaluate(node => node.style.width);
  const reference = structuredClone(record.canvas_design);
  await readyContent(page);
  const editor = symbolEditor(page);
  await selectBlock(editor, 'symbol-text');
  await editRichText(editor, 'Updated globally linked heading');
  await editor.getByTestId('input-w').fill('760');
  await saveContent(page, state);
  await closeContent(page);
  for (const id of ['linked-one', 'linked-two']) {
    await expect(parent.getByTestId(`canvas-block-${id}`)).toContainText('Updated globally linked heading');
    await expect(parent.getByTestId(`canvas-block-${id}`)).not.toContainText('Saved shared heading');
  }
  await expect.poll(() => linked.evaluate(node => node.style.width)).not.toBe(beforeWidth);
  await expect(linked).toHaveCSS('width', '760px');
  await expect(parent.getByTestId('canvas-block-detached-text')).toContainText('Saved shared heading');
  await selectBlock(parent, 'linked-one');
  await expect(parent.getByTestId('button-unlink-symbol')).toBeVisible();
  await expect(parentSave(page)).toBeDisabled();
  expect(record.canvas_design).toEqual(reference);
  expect(reference.root.sections[0].children.filter(block => block.type === 'symbol').map(block => block.content.symbolId)).toEqual([symbolId, symbolId]);
  expect(state.reads.filter(path => path === '/api/canvas-symbols?full=1').length).toBeGreaterThan(1);
  expect(state.writes).toHaveLength(1);
  assertSafe(state);
});

for (const unsupported of [
  { name: 'version 2 flow', design: () => ({ ...symbolDesign(), version: 2 }), reason: 'Only version 1 positioned symbols' },
  { name: 'multiple root sections', design: () => {
    const design = symbolDesign();
    design.root.sections.push({ id: 'additional-section', children: [positioned('extra', 'text', { html: '<p>Must not be lost</p>' }, [0, 0, 100, 100])] });
    return design;
  }, reason: 'unsupported section structure' },
  { name: 'nested shared symbols', design: () => {
    const design = symbolDesign();
    design.root.sections[0].children.push(positioned('nested-symbol', 'symbol', { symbolId: 'other-symbol' }, [0, 400, 200, 100]));
    return design;
  }, reason: 'nested symbols' },
]) {
  test(`unsupported ${unsupported.name} fails closed and never writes`, async ({ page }) => {
    const { state, originalSymbol } = await installSymbolFixture(page, { design: unsupported.design() });
    await visitEditor(page);
    await openContent(page);
    const editor = symbolEditor(page);
    await expect(editor.getByRole('alert')).toContainText(unsupported.reason);
    await expect(editor.getByRole('alert')).toContainText('No changes have been written');
    await expect(editor.getByTestId('canvas-stage')).toHaveCount(0);
    await page.keyboard.press(`${meta}+s`);
    await editor.getByRole('button', { name: 'Retry loading' }).click();
    await expect(editor.getByRole('alert')).toContainText(unsupported.reason);
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeVisible();
    expect(state.symbol).toEqual(originalSymbol);
    expect(state.writes).toEqual([]);
    assertSafe(state);
  });
}

test('load error shows retry without writes, retry loads the saved definition and clean Back closes only the symbol', async ({ page }) => {
  const { state } = await installSymbolFixture(page, { failNextLoad: true });
  await visitEditor(page);
  await openContent(page);
  const editor = symbolEditor(page);
  await expect(editor.getByRole('alert')).toContainText('Fixture symbol load failed');
  await expect(editor.getByTestId('button-save-symbol-content')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Retry loading' }).click();
  await expect(editor.getByTestId('canvas-block-symbol-text')).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(editor).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`CanvasPageEditor\\?pageId=${pageId}`));
  expect(state.writes).toEqual([]);
  assertSafe(state);
});

test('browser Back on a dirty symbol requests discard without leaving or altering the dirty parent', async ({ page }) => {
  const { state } = await installSymbolFixture(page);
  await visitEditor(page);
  const parent = parentEditor(page);
  await selectBlock(parent, 'parent-button');
  await parent.getByTestId('input-button-label').fill('Parent draft retained');
  await readyContent(page);
  const editor = symbolEditor(page);
  await selectBlock(editor, 'symbol-button');
  await editor.getByTestId('input-button-label').fill('Unsaved symbol draft');
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole('alertdialog')).toContainText('Discard symbol changes?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor.getByTestId('input-button-label')).toHaveValue('Unsaved symbol draft');
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole('alertdialog')).toContainText('Discard symbol changes?');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(parent.getByTestId('input-button-label')).toHaveValue('Parent draft retained');
  await expect(parentSave(page)).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`CanvasPageEditor\\?pageId=${pageId}`));
  expect(state.writes).toEqual([]);
  assertSafe(state);
});