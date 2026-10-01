import { test, expect } from '@playwright/test';
import { mountTable, table, block, geometry, prose, token, plain, tableDesign, scheduleContent } from './fixtures/canvas-table-wrapping.task4910.fixture.mjs';

async function wrapping(page) {
  await expect.poll(async () => {
    const g = await geometry(page);
    return g.scrollWidth - g.clientWidth;
  }).toBeLessThanOrEqual(1);
  const g = await geometry(page);
  expect(g.table.width).toBeCloseTo(g.scroller.width, 0);
  for (const header of g.headings) expect(header.width).toBeCloseTo(g.table.width / 3, 0);
  expect(g.headings[0].height).toBeGreaterThan(40);
  expect(g.rows[0].height).toBeGreaterThan(g.rows[1].height * 2);
  expect(g.cells.slice(0, 3).map(c => c.text)).toEqual([prose, token, plain]);
  expect(g.cells[0].whiteSpace).toBe('pre-wrap');
  expect(g.cells[1].overflowWrap).toBe('anywhere');
  for (const cell of g.textFragments) for (const fragment of cell) {
    expect(fragment.leftOverflow).toBeLessThanOrEqual(1);
    expect(fragment.rightOverflow).toBeLessThanOrEqual(1);
  }
  expect(g.textFragments[4].length, 'Unbroken body value has multiple rendered lines').toBeGreaterThan(1);
  expect(g.textFragments[5].length, 'Explicit body newlines survive rendering').toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => window.tableInjected)).toBeUndefined();
  await expect(table(page).locator('img, a, script')).toHaveCount(0);
  return g;
}

async function followingDoesNotOverlap(page) {
  await expect.poll(async () => {
    const t = await block(page, 'wrapping-table').boundingBox();
    const next = await block(page, 'after-table').boundingBox();
    return next.y - (t.y + t.height);
  }).toBeGreaterThanOrEqual(20);
  const next = await block(page, 'after-table').boundingBox();
  const section = await block(page, 'following-section').boundingBox();
  expect(section.y).toBeGreaterThanOrEqual(next.y + next.height);
  const owner = await block(page, 'table-section').boundingBox();
  expect(owner.y + owner.height).toBeGreaterThanOrEqual(next.y + next.height);
}

for (const version of [1, 2]) {
  for (const surface of ['editor', 'public']) {
    test(`v${version} ${surface}: narrow/wide wrapping, semantic plain text, following content and responsive typography`, async ({ page, request }, info) => {
      const { state, initialDesign } = await mountTable(page, request, { version, surface });
      const wide = await wrapping(page);
      await followingDoesNotOverlap(page);
      if (surface === 'editor') {
        await expect(page.getByTestId('fixture-save')).toBeDisabled();
        expect(await page.evaluate(() => window.fixtureDesign)).toEqual(initialDesign);
        expect(await page.evaluate(() => window.fixtureSaves)).toEqual([]);
      }
      expect(wide.headerFont).toBe('20px');
      expect(wide.bodyFont).toBe('16px');
      if (surface === 'editor') {
        await page.evaluate(() => window.fixtureSetBreakpoint('tablet'));
      } else {
        await page.setViewportSize({ width: 768, height: 1000 });
      }
      await expect.poll(async () => (await geometry(page)).headerFont).toBe('18px');
      await wrapping(page);
      await followingDoesNotOverlap(page);
      if (surface === 'editor') {
        await page.evaluate(() => window.fixtureSetBreakpoint('mobile'));
      } else {
        await page.setViewportSize({ width: 375, height: 900 });
      }
      await expect.poll(async () => (await geometry(page)).headerFont).toBe('16px');
      const narrow = await wrapping(page);
      expect(narrow.bodyFont).toBe('14px');
      expect(narrow.rows[0].height).toBeGreaterThan(wide.rows[0].height);
      await followingDoesNotOverlap(page);
      await page.screenshot({ path: info.outputPath(`v${version}-${surface}-mobile.png`), fullPage: true });
      if (surface === 'editor') {
        await expect(page.getByTestId('fixture-save')).toBeDisabled();
        expect(await page.evaluate(() => window.fixtureDesign)).toEqual(initialDesign);
      }
      expect(state.errors).toEqual([]);
      expect(state.denied).toEqual([]);
    });
  }
}

test('v1 editor: real resize handles rewrap, zoom is measurement-neutral, and an explicit local save/reload preserves content', async ({ page, request }) => {
  const { state, initialDesign } = await mountTable(page, request);
  const wide = await wrapping(page);
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  expect(await page.evaluate(() => window.fixtureDesign)).toEqual(initialDesign);
  await block(page, 'wrapping-table').click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('input-w')).toHaveValue('900');
  const handle = page.getByTestId('resize-handle-wrapping-table-e');
  const r = await handle.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 - 480, r.y + r.height / 2, { steps: 15 });
  await page.mouse.up();
  const narrow = await wrapping(page);
  expect(narrow.table.width).toBeLessThan(wide.table.width - 400);
  expect(narrow.rows[0].height).toBeGreaterThan(wide.rows[0].height);
  await followingDoesNotOverlap(page);
  await page.getByTestId('fixture-save').click();
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  const saved = await page.evaluate(() => window.fixtureSaves.at(-1));
  const contents = d => d.root.sections[0].children.find(n => n.id === 'wrapping-table').content;
  expect(contents(saved)).toEqual(contents(initialDesign));
  const stored = saved.root.sections[0].children.find(n => n.id === 'wrapping-table');
  expect(stored.bp.desktop.h, 'Render-only height never repairs historical geometry').toBe(100);
  for (let i = 0; i < 3; i++) await page.getByTestId('button-zoom-in').click();
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  const zoomed = await geometry(page);
  expect(zoomed.table.width).toBeGreaterThan(narrow.table.width);
  expect(await page.evaluate(() => window.fixtureDesign)).toEqual(saved);
  for (let i = 0; i < 6; i++) await page.getByTestId('button-zoom-out').click();
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  expect(await page.evaluate(() => window.fixtureDesign)).toEqual(saved);
  await page.getByTestId('fixture-reload').click();
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  const reloaded = await wrapping(page);
  expect(reloaded.table.width).toBeCloseTo(narrow.table.width, 0);
  expect(await page.evaluate(() => window.fixtureDesign)).toEqual(saved);
  expect(await page.evaluate(() => window.fixtureSaves.length)).toBe(1);
  await page.getByTestId('fixture-open-public').click();
  await expect(page.getByTestId('canvas-stage')).toHaveCount(0);
  const publicSaved = await wrapping(page);
  expect(publicSaved.table.width).toBeCloseTo(reloaded.table.width, 0);
  await followingDoesNotOverlap(page);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('table4910.saved')))).toEqual(saved);
  expect(await page.evaluate(() => window.fixtureSaves.length)).toBe(1);
  expect(state.denied).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('v2 flow editor: resize/reflow at narrow width is render-only and local save/reload does not rewrite table data', async ({ page, request }) => {
  const { state, initialDesign } = await mountTable(page, request, { version: 2 });
  const wide = await wrapping(page);
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  expect(await page.evaluate(() => window.fixtureDesign)).toEqual(initialDesign);
  const narrowDesign = tableDesign(2, 320);
  await page.evaluate(design => window.fixtureReplaceDesign(design), narrowDesign);
  await expect.poll(async () => (await geometry(page)).table.width).toBeLessThan(325);
  const narrow = await wrapping(page);
  expect(narrow.rows[0].height).toBeGreaterThan(wide.rows[0].height);
  await followingDoesNotOverlap(page);
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  expect(await page.evaluate(() => window.fixtureDesign)).toEqual(narrowDesign);
  // A user content edit, not ResizeObserver activity, is what marks this dirty.
  await block(page, 'wrapping-table').click({ position: { x: 10, y: 10 } });
  const heading = page.getByTestId('table-column-heading-0');
  await heading.fill('A deliberately edited heading');
  await page.getByTestId('fixture-save').click();
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  const saved = await page.evaluate(() => window.fixtureSaves.at(-1));
  await page.getByTestId('fixture-reload').click();
  await expect(table(page).locator('th').first()).toHaveText('A deliberately edited heading');
  await followingDoesNotOverlap(page);
  await expect(page.getByTestId('fixture-save')).toBeDisabled();
  expect(await page.evaluate(() => window.fixtureDesign)).toEqual(saved);
  await page.getByTestId('fixture-open-public').click();
  await expect(page.getByTestId('canvas-flow-stage')).toHaveCount(0);
  await expect(table(page).locator('th').first()).toHaveText('A deliberately edited heading');
  await wrapping(page);
  await followingDoesNotOverlap(page);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('table4910.saved')))).toEqual(saved);
  expect(await page.evaluate(() => window.fixtureSaves.length)).toBe(1);
  expect(state.denied).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const version of [1, 2]) {
  for (const surface of ['editor', 'public']) {
    test(`v${version} ${surface}: narrow two-column Time/Session schedule preserves complete session names without scrolling`, async ({ page, request }, info) => {
      const { state, initialDesign } = await mountTable(page, request, {
        version, surface, width: 320, content: scheduleContent,
      });
      await expect(table(page).locator('th')).toHaveText(['Time', 'Session']);
      for (const heading of await table(page).locator('th').all()) {
        await expect(heading).toHaveAttribute('scope', 'col');
      }
      await expect.poll(async () => {
        const g = await geometry(page);
        return g.scrollWidth - g.clientWidth;
      }).toBeLessThanOrEqual(1);
      const g = await geometry(page);
      expect(g.table.width).toBeLessThan(320);
      expect(g.table.width).toBeCloseTo(g.scroller.width, 0);
      for (const heading of g.headings) expect(heading.width).toBeCloseTo(g.table.width / 2, 0);
      expect(g.cells.map(cell => cell.text)).toEqual(
        scheduleContent.rows.flatMap(row => [row.cells.time, row.cells.session]),
      );
      for (const row of g.rows) expect(row.height).toBeGreaterThan(50);
      for (const index of [3, 5, 7]) {
        expect(g.textFragments[index].length, 'Complete session name wraps onto multiple lines').toBeGreaterThan(1);
        for (const fragment of g.textFragments[index]) {
          expect(fragment.leftOverflow).toBeLessThanOrEqual(1);
          expect(fragment.rightOverflow).toBeLessThanOrEqual(1);
        }
      }
      await followingDoesNotOverlap(page);
      if (surface === 'editor') {
        await expect(page.getByTestId('fixture-save')).toBeDisabled();
        expect(await page.evaluate(() => window.fixtureDesign)).toEqual(initialDesign);
      }
      await page.screenshot({ path: info.outputPath(`v${version}-${surface}-time-session.png`), fullPage: true });
      expect(state.denied).toEqual([]);
      expect(state.errors).toEqual([]);
    });
  }
}

test('legacy CSS reproduction: max-content and pre-line cause the original horizontal overflow', async ({ page, request }, info) => {
  const { state } = await mountTable(page, request, { version: 1, surface: 'public', width: 320 });
  const fixed = await wrapping(page);
  // Reproduce the historical renderer's CSS on the SAME semantic table/data.
  // This is an isolated DOM-class comparison, not a reverted production build.
  await table(page).evaluate(el => {
    el.parentElement.className = 'w-full overflow-x-auto';
    el.className = 'w-full min-w-max border-collapse text-left';
    for (const cell of el.querySelectorAll('th, td')) {
      cell.className = cell.className
        .replace('whitespace-pre-wrap', 'whitespace-pre-line')
        .replace('[overflow-wrap:anywhere]', '');
    }
  });
  const legacy = await geometry(page);
  expect(legacy.scrollWidth - legacy.clientWidth).toBeGreaterThan(500);
  expect(legacy.table.width).toBeGreaterThan(fixed.table.width * 3);
  expect(legacy.rows[0].height).toBeLessThan(fixed.rows[0].height);
  await page.screenshot({ path: info.outputPath('legacy-css-overflow.png'), fullPage: true });
  expect(state.denied).toEqual([]);
  expect(state.errors).toEqual([]);
});