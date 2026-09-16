import { test, expect } from '@playwright/test';

// Exercise the real dialog without accessing or modifying tenant data.
async function mount(page) {
  page.on('pageerror', error => console.error(error.message));
  await page.route('**/__group-dialog-test', route => route.fulfill({
    contentType: 'text/html',
    body: `<html><head><meta charset="utf-8"></head><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module">
      import React from '/@fs${process.cwd()}/node_modules/.vite/deps/react.js';
      import ReactDOM from '/@fs${process.cwd()}/node_modules/.vite/deps/react-dom_client.js';
      import Dialog from '/src/components/member-groups/AllMembersDialog.jsx';
      import '/src/index.css';
      const h = React.createElement;
      const assignments = [
        { id: 'alice-new', member_id: 'alice', name: 'Alice Johnson', role: 'Chair' },
        { id: 'guest', guest_id: 'guest', name: 'Gabrielle Guest', role: 'Advisor' },
        { id: 'alice-old', member_id: 'alice', name: 'Alice Johnson', role: 'Treasurer' },
        ...Array.from({length: 150}, (_, i) => ({ id: 'm'+i, member_id: 'm'+i, name: 'Member '+i, role: 'Member' })),
      ];
      function App() {
        const [group, setGroup] = React.useState('A');
        window.switchGroup = setGroup;
        return h(React.Fragment, null,
          h('button', {onClick: () => setGroup('A')}, 'Open members'),
          group && h(Dialog, {
            key: group, group: { name: 'Group '+group },
            assignments: group === 'Empty' ? [] : assignments,
            getAssigneeName: a => a.name,
            onClose: () => setGroup(null),
            renderAssignmentRow: a => h('div', {key: a.id, 'data-id': a.id, className: 'p-2 bg-slate-50'},
              a.name+' — '+a.role,
              h('button', {onClick: () => window.lastAction = a.id}, 'Edit')),
          })
        );
      }
      ReactDOM.createRoot(document.getElementById('root')).render(h(App));
    </script></body></html>`,
  }));
  await page.goto('/__group-dialog-test');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
}

test('type-ahead preserves assignment identity, unique counts, order, and session resets', async ({ page }) => {
  await mount(page);
  const search = page.getByLabel('Search by name');
  const rows = page.locator('[data-id]');
  await expect(page.getByRole('status')).toHaveText('152 people');
  await search.fill('  aLiCe jo  ');
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('status')).toHaveText('1 of 152 people match');
  await expect(rows.first()).toHaveAttribute('data-id', 'alice-new');
  await rows.last().getByRole('button', {name: 'Edit'}).click();
  expect(await page.evaluate(() => window.lastAction)).toBe('alice-old');
  await search.fill(' GABR ');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Gabrielle Guest');
  await search.fill('nobody');
  await expect(page.getByText('No members or guests match your search.')).toBeVisible();
  await page.getByRole('button', {name: 'Clear', exact: true}).click();
  await expect(search).toBeFocused();
  await expect(rows).toHaveCount(153);
  await search.fill('   ');
  await expect(rows).toHaveCount(153);
  await search.fill('alice');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', {name: 'Open members'}).click();
  await expect(search).toHaveValue('');
  await search.fill('alice');
  await page.evaluate(() => window.switchGroup('B'));
  await expect(search).toHaveValue('');
  await expect(page.getByRole('heading')).toHaveText('Members — Group B');
  await page.evaluate(() => window.switchGroup('Empty'));
  await expect(page.getByText('No members in this group.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('0 people');
});

for (const viewport of [{width: 1280, height: 800}, {width: 375, height: 667}]) {
  test(`results scroll independently at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mount(page);
    const list = page.getByTestId('list-all-members');
    const heading = page.getByRole('heading');
    const before = await heading.boundingBox();
    await page.screenshot({ path: `test-results/group-members-dialog/modal-${viewport.width}.png` });
    expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await heading.boundingBox()).toEqual(before);
    await expect(page.getByLabel('Search by name')).toBeVisible();
    await expect(page.getByRole('status')).toBeVisible();
    const box = await page.getByRole('dialog').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });
}