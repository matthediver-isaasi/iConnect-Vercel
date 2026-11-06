import { expect, test } from '@playwright/test';

// Fixture-only, using the actual Vite-transformed designer, as in the existing
// certificate preview specs. All API access and unexpected writes fail closed.
const ROOT = '/api/cpd-certificate-templates';
const ID = 'signature-fixture';
const COPY_ID = 'signature-fixture-copy';
const ASSET = { id: '12345678-1234-4234-8234-123456789abc', sha256: 'a'.repeat(64),
  mime_type: 'image/png', width: 300, height: 100 };
const SECOND = { ...ASSET, id: '87654321-1234-4234-8234-123456789abc', sha256: 'b'.repeat(64), width: 100, height: 100 };
const imageField = { placeholder_key: 'signature.fixture', label: 'Signature', field_type: 'image',
  image_asset_id: ASSET.id, image_sha256: ASSET.sha256, page_number: 1,
  x: 72, y: 72, width: 180, height: 60 };
const previewUrl = asset => `${ROOT}/${ID}/signatures?assetId=${asset.id}`;

async function mount(page, request, { active = false, existing = false, uploadError = false, dropIdentity = false } = {}) {
  const response = await request.get('/src/pages/CPDCertificateTemplates.jsx');
  expect(response.ok(), 'Requires an already-running Vite preview').toBeTruthy();
  const origin = new URL(response.url()).origin;
  const transformed = await response.text();
  const react = transformed.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error('Vite React dependency was not transformed');
  const dependency = name => react.replace(/react\.js\?/, `${name}.js?`);
  const html = `<!doctype html><html><body><div id="root"></div><script type="module">
    import RefreshRuntime from "/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import("/@vite/client");
    await import("/src/index.css");
    const React = (await import(${JSON.stringify(react)})).default;
    const { createRoot } = (await import(${JSON.stringify(dependency('react-dom_client'))})).default;
    const { QueryClient, QueryClientProvider } = await import(${JSON.stringify(dependency('@tanstack_react-query'))});
    const { MemoryRouter, Routes, Route, useParams } = await import(${JSON.stringify(dependency('react-router-dom'))});
    const { TemplateDesigner, TemplateLibrary } = await import("/src/pages/CPDCertificateTemplates.jsx");
    const Designer = () => React.createElement(TemplateDesigner, {id: useParams().templateId});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    createRoot(document.getElementById("root")).render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(MemoryRouter, {initialEntries: [location.pathname + location.search]},
          React.createElement(Routes, null,
            React.createElement(Route, {path: "/CPDCertificateTemplates", element: React.createElement(TemplateLibrary)}),
            React.createElement(Route, {path: "/CPDCertificateTemplates/:templateId", element: React.createElement(Designer)})))));
    </script></body></html>`;
  const state = { uploads: [], saves: [], duplicates: [], unexpected: [], errors: [], failUpload: uploadError };
  const template = { id: ID, version: 7, name: 'Signature fixture', status: active ? 'active' : 'draft',
    pdf_metadata: { pages: [{ width: 612, height: 792 }, { width: 792, height: 612 }] },
    placeholders: existing ? [imageField] : [] };
  let duplicate = null;
  // A real 3:1 PNG generated locally, not a placeholder or external image URL.
  await page.goto('about:blank');
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 300; canvas.height = 100;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#28364a'; ctx.fillRect(20, 45, 260, 10);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  state.file = { name: 'chair.png', mimeType: 'image/png', buffer: png };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.context().routeWebSocket('**/*', socket => socket.onMessage(() => {}));
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/CPDCertificateTemplates' || url.pathname === `/CPDCertificateTemplates/${ID}` ||
        url.pathname === `/CPDCertificateTemplates/${COPY_ID}`) return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/src/hooks/useMemberAccess.js') return route.fulfill({ contentType: 'text/javascript',
      body: 'export const useMemberAccess = () => ({});' });
    if (url.pathname === ROOT && req.method() === 'GET') return json({ templates: [template, ...(duplicate ? [duplicate] : [])] });
    if ([`${ROOT}/${ID}/source`, `${ROOT}/${COPY_ID}/source`].includes(url.pathname) && req.method() === 'GET') return json({ signedUrl: '' });
    if ([`${ROOT}/${ID}/signatures`, `${ROOT}/${COPY_ID}/signatures`].includes(url.pathname)) {
      if (req.method() === 'POST') {
        state.uploads.push({ body: req.postDataBuffer().toString(), contentType: req.headers()['content-type'] });
        if (state.failUpload) return json({ error: 'Signature storage unavailable. Try again.' }, 503);
        const asset = state.uploads.length === 1 ? ASSET : SECOND;
        return json({ asset, previewUrl: previewUrl(asset) });
      }
      if (req.method() === 'GET') return route.fulfill({ contentType: 'image/png',
        headers: { 'Cache-Control': 'private, no-store' }, body: png });
    }
    if (url.pathname === `${ROOT}/${ID}/duplicate` && req.method() === 'POST') {
      state.duplicates.push(req.postDataJSON());
      duplicate = { ...structuredClone(template), id: COPY_ID, version: 1, status: 'draft', name: `${template.name} copy` };
      return json({ template: duplicate });
    }
    if (url.pathname === `${ROOT}/${COPY_ID}` && req.method() === 'GET') return json({ template: duplicate });
    if (url.pathname === `${ROOT}/${ID}`) {
      if (req.method() === 'GET') return json({ template });
      if (req.method() === 'PUT') {
        const body = req.postDataJSON(); state.saves.push(body);
        template.version++;
        template.placeholders = body.placeholders;
        return json({ template: { ...template, placeholders: body.placeholders.map(field =>
          dropIdentity ? { ...field, image_asset_id: null } : field) } });
      }
    }
    if (url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method())) {
      state.unexpected.push(`${req.method()} ${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`/CPDCertificateTemplates/${ID}`);
  await expect(page.getByTestId('certificate-page')).toBeVisible();
  return state;
}

test('signature upload, numeric/drag geometry, page, duplicate, save/reload, replacement and removal', async ({ page, request }) => {
  const state = await mount(page, request);
  await page.getByLabel('Upload signature image', { exact: true }).setInputFiles(state.file);
  const signature = page.getByTestId('certificate-signature');
  await expect(signature).toHaveCount(1);
  await expect(signature.locator('img')).toHaveAttribute('src', previewUrl(ASSET));
  await expect(signature.locator('img')).toHaveJSProperty('naturalWidth', 300);
  expect(state.uploads[0].contentType).toContain('multipart/form-data; boundary=');
  expect(state.uploads[0].body).toMatch(/name="expectedVersion"\r\n\r\n7/);
  expect(state.uploads[0].body).toContain('name="file"; filename="chair.png"');
  await expect(page.getByText('Sample / preview value', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Font family', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/field\(s\) have no sample value/)).toHaveCount(0);
  await page.getByLabel('Width (pt)', { exact: true }).fill('240');
  await expect(page.getByLabel('Height (pt)', { exact: true })).toHaveValue('80');
  await page.getByLabel('Height (pt)', { exact: true }).fill('60');
  await expect(page.getByLabel('Width (pt)', { exact: true })).toHaveValue('180');
  await page.locator('#signature-page').selectOption('2');
  await expect(page.getByLabel('Page', { exact: true }).first()).toHaveValue('2');
  await page.getByLabel('Zoom', { exact: true }).selectOption('1');
  const before = await signature.boundingBox();
  await page.mouse.move(before.x + 15, before.y + 15);
  await page.mouse.down(); await page.mouse.move(before.x + 45, before.y + 35); await page.mouse.up();
  await expect(page.getByLabel('X (pt)', { exact: true })).toHaveValue('102');
  const handle = page.getByLabel('Resize field', { exact: true });
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 2, box.y + 2); await page.mouse.down();
  await page.mouse.move(box.x + 62, box.y + 2); await page.mouse.up();
  await expect(page.getByLabel('Width (pt)', { exact: true })).toHaveValue('240');
  await expect(page.getByLabel('Height (pt)', { exact: true })).toHaveValue('80');
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(signature).toHaveCount(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(state.saves[0].expectedVersion).toBe(7); // upload did not increment version
  expect(state.saves[0].placeholders).toHaveLength(2);
  for (const field of state.saves[0].placeholders) {
    expect(field).toMatchObject({ field_type: 'image', image_asset_id: ASSET.id, image_sha256: ASSET.sha256, page_number: 2 });
    expect(field).not.toHaveProperty('image_width');
    expect(field).not.toHaveProperty('image_height');
    expect(field).not.toHaveProperty('image_preview_url');
  }
  await page.reload();
  await page.getByLabel('Page', { exact: true }).selectOption('2');
  await expect(signature).toHaveCount(2);
  await signature.first().click({ position: { x: 5, y: 5 } });
  await page.getByLabel('Replace signature image', { exact: true }).setInputFiles(state.file);
  await expect(signature.first().locator('img')).toHaveAttribute('src', previewUrl(SECOND));
  expect(state.uploads[1].body).toMatch(/name="expectedVersion"\r\n\r\n8/);
  const replacement = await signature.first().boundingBox();
  expect(Math.abs(replacement.width - replacement.height)).toBeLessThan(1);
  await page.getByRole('button', { name: 'Remove signature', exact: true }).click();
  await expect(signature).toHaveCount(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(state.saves.at(-1).placeholders).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('invalid/oversized files and failed uploads show errors without replacing the existing signature; retry works', async ({ page, request }) => {
  const state = await mount(page, request, { existing: true, uploadError: true });
  const input = page.getByLabel('Upload signature image', { exact: true });
  await input.setInputFiles({ name: 'signature.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByRole('alert')).toContainText('JPG, JPEG or PNG');
  await input.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await expect(page.getByRole('alert')).toContainText('2 MiB');
  expect(state.uploads).toHaveLength(0);
  const signature = page.getByTestId('certificate-signature');
  await signature.click();
  const replacement = page.getByLabel('Replace signature image', { exact: true });
  await replacement.setInputFiles(state.file);
  await expect(page.getByRole('alert')).toContainText('Signature storage unavailable');
  await expect(signature.locator('img')).toHaveAttribute('src', previewUrl(ASSET));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  state.failUpload = false;
  await replacement.setInputFiles(state.file);
  await expect(signature.locator('img')).toHaveAttribute('src', previewUrl(SECOND));
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('template duplication opens an independently editable copy with the same private signature identity and geometry', async ({ page, request }) => {
  const state = await mount(page, request, { existing: true });
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CPD Certificate Templates', exact: true })).toBeVisible();
  await page.getByRole('button').filter({ has: page.locator('svg.lucide-copy') }).click();
  await expect(page.locator('header input:not([type="file"])')).toHaveValue('Signature fixture copy');
  const signature = page.getByTestId('certificate-signature');
  await expect(signature).toHaveCount(1);
  await expect(signature.locator('img')).toHaveAttribute('src', `${ROOT}/${COPY_ID}/signatures?assetId=${ASSET.id}`);
  await expect(signature.locator('img')).toHaveJSProperty('naturalWidth', 300);
  await signature.click();
  await expect(page.getByLabel('X (pt)', { exact: true })).toHaveValue('72');
  await expect(page.getByLabel('Y (pt)', { exact: true })).toHaveValue('72');
  await expect(page.getByLabel('Width (pt)', { exact: true })).toHaveValue('180');
  await expect(page.getByLabel('Height (pt)', { exact: true })).toHaveValue('60');
  await expect(page.getByRole('button', { name: 'Replace signature', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Remove signature', exact: true })).toBeEnabled();
  expect(state.duplicates).toEqual([{}]);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('active signatures preview privately but cannot be edited, uploaded or removed', async ({ page, request }) => {
  const state = await mount(page, request, { active: true, existing: true });
  const signature = page.getByTestId('certificate-signature');
  await expect(signature.locator('img')).toHaveAttribute('src', previewUrl(ASSET));
  await signature.click();
  for (const name of ['Upload signature', 'Replace signature', 'Remove signature', 'Duplicate', 'Save']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByLabel('Resize field')).toHaveCount(0);
  expect(state.uploads).toEqual([]);
  expect(state.saves).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('checked save retains dirty signature draft when the server drops image identity', async ({ page, request }) => {
  const state = await mount(page, request, { dropIdentity: true });
  await page.getByLabel('Upload signature image', { exact: true }).setInputFiles(state.file);
  await expect(page.getByTestId('certificate-signature')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('signature identity and geometry');
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  await expect(page.getByTestId('certificate-signature').locator('img')).toHaveAttribute('src', previewUrl(ASSET));
  expect(state.errors).toEqual([]);
});
