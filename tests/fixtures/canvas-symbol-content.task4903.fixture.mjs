import { expect } from '@playwright/test';

export const symbolId = 'symbol-content-4903';
export const pageId = 'symbol-page-4903';
const member = {
  id: 'symbol-member-4903', tenant_id: 'symbol-tenant-4903', role_id: 'symbol-role-4903',
  email: 'symbol-editor@example.invalid', member_excluded_features: [],
};
const tenant = { id: member.tenant_id, slug: 'symbol-fixture-4903' };
const frame = (x, y, w, h) => ({ x, y, w, h, hidden: false });
export const positioned = (id, type, content, geometry) => ({
  id, type, name: id, bp: { desktop: frame(...geometry) }, content,
});
export const symbolDesign = () => ({
  version: 1, extension: { preserved: 'definition metadata' },
  root: { background: '#ffffff', extension: 'root metadata', sections: [{
    id: 'symbol-root', extension: 'section metadata', children: [
      { ...positioned('symbol-text', 'text', { html: '<h2>Saved shared heading</h2>', extension: 'content metadata' }, [0, 0, 500, 110]), extension: 'block metadata' },
      positioned('symbol-button', 'button', { label: 'Saved shared link', href: '/original-target' }, [0, 140, 240, 56]),
      positioned('symbol-image', 'image', { src: '/__symbol4903/original.svg', alt: 'Original shared image', objectFit: 'cover' }, [0, 220, 280, 100]),
    ],
  }] },
});

export async function installSymbolFixture(page, options = {}) {
  const state = {
    writes: [], deniedWrites: [], errors: [], reads: [],
    failNextPatch: options.failNextPatch || false,
    failNextLoad: options.failNextLoad || false,
    symbol: {
      id: symbolId, name: 'Saved shared banner', description: 'Shared symbol regression fixture',
      design: options.design || symbolDesign(),
    },
  };
  const originalSymbol = structuredClone(state.symbol);
  const record = {
    id: pageId, title: 'Shared content regression page', slug: pageId,
    builder_type: 'canvas', layout_type: 'member', status: 'draft',
    canvas_design: { version: 1, root: { sections: [{ id: 'page-root', children: [
      positioned('parent-text', 'text', { html: '<h1>Parent draft heading</h1>' }, [0, 0, 450, 110]),
      positioned('parent-button', 'button', { label: 'Parent link', href: '/parent-original' }, [600, 0, 220, 56]),
      positioned('linked-one', 'symbol', { symbolId, symbolName: state.symbol.name }, [0, 160, 500, 320]),
      positioned('linked-two', 'symbol', { symbolId, symbolName: state.symbol.name }, [600, 160, 500, 320]),
      positioned('detached-text', 'text', { html: '<h2>Saved shared heading</h2>' }, [0, 530, 500, 110]),
    ] }] } },
  };
  const targetPage = {
    id: 'target-4903', title: 'Target internal page', slug: 'target-4903',
    builder_type: 'canvas', layout_type: 'public', status: 'published',
    canvas_design: { version: 1, root: { sections: [{ id: 'target-root', children: [] }] } },
  };
  const files = [
    { id: 'image-4903', name: 'Replacement shared image', file_name: 'Replacement shared image', file_type: 'image', mime_type: 'image/svg+xml', file_url: '/__symbol4903/replacement.svg', url: '/__symbol4903/replacement.svg', alt_text: 'Replacement shared image', folder_id: null },
    { id: 'document-4903', name: 'Shared information PDF', file_name: 'Shared information PDF', file_type: 'document', mime_type: 'application/pdf', file_url: '/__symbol4903/shared.pdf', url: '/__symbol4903/shared.pdf', folder_id: null },
  ];
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(member => {
    localStorage.setItem('agcas_member', JSON.stringify(member));
    localStorage.setItem('canvas.layersPanel.open', 'false');
  }, member);
  // No API request ever reaches a real backend. In particular page persistence,
  // publishing, versions, symbol creation/deletion and file uploads are denied.
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    // Vite source imports such as /src/api/base44Client.js are modules, not
    // backend requests; the broad route glob also matches those paths.
    if (!path.startsWith('/api/')) return route.continue();
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (method !== 'GET') {
      const body = request.postDataJSON();
      const write = { method, path, body };
      state.writes.push(write);
      const allowedKeys = options.allowRename ? ['name', 'design'] : ['design'];
      if (method !== 'PATCH' || path !== `/api/canvas-symbols/${symbolId}` ||
          !body || !Object.keys(body).length || Object.keys(body).some(key => !allowedKeys.includes(key))) {
        state.deniedWrites.push(write);
        return json({ error: `Unexpected mutation denied: ${method} ${path}` }, 405);
      }
      if (state.failNextPatch) {
        state.failNextPatch = false;
        return json({ error: 'Fixture symbol save failed' }, 503);
      }
      Object.assign(state.symbol, structuredClone(body));
      return json({ symbol: state.symbol });
    }
    state.reads.push(`${path}${url.search}`);
    if (path === '/api/auth/me') return json(member);
    if (path === '/api/auth/tenant-user-me') return json({
      ...member, member, user: member, tenant, tenantId: tenant.id, memberId: member.id,
    });
    if (path === `/api/entities/Member/${member.id}`) return json(member);
    if (path.startsWith('/api/entities/Role')) {
      const role = { id: member.role_id, name: 'Editor', excluded_features: [] };
      return json(path.endsWith(member.role_id) ? role : [role]);
    }
    if (path === '/api/entities/IEditPage') return json([record, targetPage]);
    if (path === `/api/canvas-design/${pageId}`) return json({ page: record });
    if (path === '/api/canvas-symbols') return json({ symbols: [state.symbol] });
    if (path === `/api/canvas-symbols/${symbolId}`) {
      if (state.failNextLoad) {
        state.failNextLoad = false;
        return json({ error: 'Fixture symbol load failed' }, 503);
      }
      return json({ symbol: state.symbol });
    }
    if (path === '/api/public/canvas-symbols') return json({ symbols: [state.symbol] });
    if (path === '/api/entities/FileRepository') return json(files);
    if (path === '/api/public/tenant-branding') return json({
      success: true, branding: { tenant, tenantSlug: tenant.slug },
    });
    if (path.includes('settings') && !path.includes('system-settings')) return json({ settings: {}, tenant, branding: {} });
    // Auxiliary portal reads receive empty fixture responses; never pass through.
    return json([]);
  });
  await page.route('**/__symbol4903/**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="100"><rect width="280" height="100" fill="#dbeafe"/><text x="18" y="55" fill="#1e40af">Shared image fixture</text></svg>',
  }));
  return { ...state, originalSymbol, record, targetPage, state };
}

export const parentEditor = page => page.getByTestId('canvas-page-editor');
export const symbolEditor = page => page.getByTestId('symbol-content-editor');
export const symbolChildren = state => state.symbol.design.root.sections[0].children;
export const savedBlock = (state, id) => symbolChildren(state).find(block => block.id === id);

export async function visitEditor(page) {
  await page.goto(`/CanvasPageEditor?pageId=${pageId}`);
  await expect(parentEditor(page)).toBeVisible();
  await expect(parentEditor(page).getByTestId('canvas-block-parent-text')).toContainText('Parent draft heading');
  if (await page.getByTestId('banner-cookie-consent').isVisible()) {
    await page.getByTestId('button-decline-cookies').click();
  }
}

export async function openContent(page) {
  await parentEditor(page).getByTestId('button-open-symbols').click();
  await page.getByTestId(`button-edit-symbol-content-${symbolId}`).click();
  await expect(symbolEditor(page)).toBeVisible();
}

export async function readyContent(page) {
  await openContent(page);
  await expect(symbolEditor(page).getByTestId('canvas-block-symbol-text')).toBeVisible();
}

export async function selectBlock(editor, id) {
  await editor.getByTestId(`canvas-block-${id}`).click();
  await expect(editor.getByTestId('input-block-name')).toHaveValue(id);
}

export async function editRichText(editor, text) {
  const rte = editor.getByTestId('input-text-content').locator('[contenteditable="true"]');
  await expect(rte).toBeVisible();
  await rte.fill(text);
}

export async function saveContent(page, state) {
  const count = state.writes.length;
  await symbolEditor(page).getByTestId('button-save-symbol-content').click();
  await expect.poll(() => state.writes.length).toBe(count + 1);
  await expect(symbolEditor(page).getByTestId('button-save-symbol-content')).toBeDisabled();
  await expect(symbolEditor(page).getByText('Symbol saved', { exact: true })).toBeVisible();
}

export async function closeContent(page) {
  await symbolEditor(page).getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(symbolEditor(page)).not.toBeVisible();
}

export function assertSafe(state) {
  expect(state.deniedWrites, 'No underlying page, publish, version, upload, create/delete or other mutation').toEqual([]);
  expect(state.errors, 'No uncaught browser errors').toEqual([]);
}