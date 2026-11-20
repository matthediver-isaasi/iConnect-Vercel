import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

// Real mounted editor, URL provider and article view; only data/services and
// unrelated widgets are substituted. Every browser request is intercepted.
let script, css;
test.beforeAll(async () => {
  css = (await postcss([tailwindcss({
    content: ['client/src/pages/ArticleEditor.jsx', 'client/src/components/ui/button.jsx'],
    corePlugins: { preflight: true },
  })]).process('@tailwind base;@tailwind utilities;', { from: undefined })).css;
  css += ':root{--input:0 0% 80%;--background:0 0% 100%;--foreground:0 0% 10%}';
  const mocks = {
    '@/api/base44Client': `
      const call=async (entity, action, id, data)=>{
        const r=await fetch('/fixture/'+entity+'/'+action,{method:'POST',body:JSON.stringify({id,data})});
        const body=await r.json();if(!r.ok)throw Error(body.error);return body;
      };
      export const base44={entities:new Proxy({}, {get:(_,entity)=>({
        get:id=>call(entity,'get',id), list:()=>call(entity,'list'),
        listAll:()=>call(entity,'list'),update:(id,data)=>call(entity,'update',id,data),
        create:data=>call(entity,'create',null,data),delete:id=>call(entity,'delete',id),
      })}),integrations:{Core:{UploadFile:()=>call('Upload','create')}}};`,
    '@/api/publicClient': `export const publicClient={
      getSystemSetting:async()=>({setting_value:window.fixtureName}),
      getArticleSettings:async()=>({}),getArticle:async()=>({article:null})};`,
    '@/hooks/useMemberAccess': `export const useMemberAccess=()=>({
      memberInfo:{id:'m1',tenant_id:'tenant',handle:'alex',email:'fixture@example.test'},
      isAdmin:window.fixtureAdmin,isFeatureExcluded:()=>false});`,
    '@/contexts/TenantBrandingContext': `export const useTenantBranding=()=>({branding:{name:'Fixture'}});`,
    '@/contexts/LayoutContext': `export const useLayoutContext=()=>({sessionValidated:true});`,
    '@/components/MemberCombobox': `export default ()=>null;`,
    'sonner': `export const toast={success:()=>{},error:()=>{}};`,
    '@/lib/planQuotaError': `export const showUploadErrorToast=()=>{};`,
    // Quill's upload callback and insertion contract, without browser selection noise.
    'react-quill': `import React,{forwardRef,useImperativeHandle}from'react';
      export default forwardRef(({value,onChange,modules,readOnly},ref)=>{
        useImperativeHandle(ref,()=>({getEditor:()=>({getSelection:()=>({index:0}),
          insertEmbed:(_,type,url)=>onChange(value+'<img src="'+url+'">')})}));
        return <><textarea aria-label="Article content" readOnly={readOnly} value={value} onChange={e=>onChange(e.target.value)}/>
          <button type="button" onClick={()=>modules.toolbar.handlers.image()}>Insert content image</button></>;
      });`,
  };
  mocks['../../api/base44Client'] = mocks['@/api/base44Client'];
  for (const name of ['ArticleComments', 'ArticleReactions', 'AuthorFollowButton']) {
    mocks[`../components/blog/${name}`] = 'export default ()=>null;';
    mocks[`@/components/blog/${name}`] = 'export default ()=>null;';
  }
  mocks['@/components/bookmarks/BookmarkButton'] = 'export default ()=>null;';
  const result = await build({
    stdin: { contents: `
      import React from 'react';import{createRoot}from'react-dom/client';
      import{BrowserRouter,Routes,Route,Link,useNavigate}from'react-router-dom';
      import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
      import{ArticleUrlProvider}from'./client/src/contexts/ArticleUrlContext.jsx';
      import Editor from './client/src/pages/ArticleEditor.jsx';
      import View from './client/src/pages/ArticleView.jsx';
      const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
      // Seed a fresh stale-version cache entry: preview must evict this too.
      client.setQueryData(['article-by-slug','alex','original',true],{article:{
        id:'saved',title:'Cached obsolete title',slug:'original',author_id:'m1',status:'draft'}});
      window.fixtureClient=client;
      function Navigation(){
        window.fixtureNavigate=useNavigate();
        return <Link to="/elsewhere">Elsewhere</Link>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}>
      <BrowserRouter><ArticleUrlProvider><Navigation/><Routes>
        <Route path="/ArticleEditor" element={<Editor/>}/><Route path="/blogseditor" element={<Editor/>}/>
        <Route path="/articles/:authorHandle/:articleSlug" element={<View/>}/>
        <Route path="/blogs/:authorHandle/:articleSlug" element={<View/>}/>
        <Route path="*" element={<><h1>Other page</h1><Link to="/ArticleEditor?id=saved">Open editor</Link></>}/>
      </Routes></ArticleUrlProvider></BrowserRouter></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic', alias: { '@': path.resolve('client/src') },
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'mock' } : null);
      b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'jsx', resolveDir: process.cwd() }));
    } }],
  });
  script = result.outputFiles[0].text;
});

async function mount(page, { name = 'Articles', fresh = false, admin = false, record = {}, mobile = false, readDelay = 0, authorFail = false } = {}) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const state = {
    record: fresh ? null : { id: 'saved', title: 'Original title', slug: 'original',
      content: '<p>Saved content</p>', status: 'draft', author_id: 'm1', original_author_id: 'm1',
      feature_image_url: 'https://preview.test/retained.svg', published_date: '2030-01-01T12:00:00.000Z', ...record },
    writes: [], fail: false, unconfirmed: false, delay: 0, uploadDelay: 0, readDelay, slugDelay: 0, slugFail: false, duplicate: false,
  };
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>' });
    if (req.resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname.startsWith('/fixture/')) {
      const [, , entity, action] = url.pathname.split('/');
      const { id, data } = req.postDataJSON();
      let body = [];
      if (entity === 'Member') body = { id, handle: id === 'm1' ? 'alex' : 'other-author', first_name: id === 'm1' ? 'Alex' : 'Other' };
      if (entity === 'SystemSettings') body = [{ setting_key: 'article_display_name', setting_value: name }];
      if (entity === 'GuestWriter') body = [{ id: 'g1', full_name: 'Guest Writer', is_active: true }];
      if (entity === 'BlogPost') {
        if (action === 'get' && state.readDelay) await new Promise(r => setTimeout(r, state.readDelay));
        if (action === 'list' && state.slugDelay) await new Promise(r => setTimeout(r, state.slugDelay));
        body = action === 'get' ? state.record : state.record ? [state.record] : [];
        if (action === 'list' && state.slugFail) return route.fulfill({ status: 503, json: { error: 'URL check unavailable' } });
        if (action === 'list' && state.duplicate) body = [...body, { id: 'duplicate', slug: 'conflict', author_id: 'm1' }];
        if (['update', 'create'].includes(action)) {
          state.writes.push({ action, id, data });
          if (state.delay) await new Promise(r => setTimeout(r, state.delay));
          if (state.fail) return route.fulfill({ status: 503, json: { error: 'Fixture save failed. Your edits are still here.' } });
          if (state.unconfirmed) return route.fulfill({ json: {} });
          state.record = { ...state.record, ...data, id: id || 'created' };
          body = state.record;
        }
      }
      if (entity === 'Upload') {
        await new Promise(r => setTimeout(r, state.uploadDelay));
        body = { file_url: 'https://preview.test/uploaded.svg' };
      }
      return route.fulfill({ json: body });
    }
    if (url.pathname === '/api/articles/authors') return route.fulfill({ status: authorFail ? 503 : 200, json: { authors: [] } });
    if (url.pathname === '/api/article-follows/check') return route.fulfill({ json: { following: false } });
    if (url.pathname === '/api/integrations/upload-file') {
      await new Promise(r => setTimeout(r, state.uploadDelay));
      return route.fulfill({ json: { file_url: 'https://preview.test/social.svg' } });
    }
    throw new Error(`Unexpected fixture request: ${req.method()} ${url.pathname}`);
  });
  await page.goto(`https://preview.test/${name === 'Blogs' ? 'blogseditor' : 'ArticleEditor'}${fresh ? '' : '?id=saved'}`);
  await page.evaluate(({ name, admin }) => { window.fixtureName = name; window.fixtureAdmin = admin; localStorage.setItem('agcas_member', '{}'); }, { name, admin });
  await page.addScriptTag({ content: script });
  await page.addStyleTag({ content: css });
  if (readDelay) {
    await expect(preview(page)).toHaveCount(0);
    await expect(title(page)).toHaveCount(0);
  }
  await expect(page.getByTestId('input-article-title')).toBeVisible();
  return state;
}

const preview = page => page.getByTestId('button-preview-article');
const title = page => page.getByTestId('input-article-title');
const leaveDialog = page => page.getByRole('dialog', { name: 'Leave with unsaved changes?' });
const unloadBlocked = page => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

test('pristine drafts leave freely; even an untitled draft protects edits', async ({ page }) => {
  await mount(page, { fresh: true });
  expect(await unloadBlocked(page)).toBe(false);
  await page.getByLabel('Article content').fill('An untitled draft');
  expect(await unloadBlocked(page)).toBe(true);
  await page.getByRole('link', { name: 'Back to' }).click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Stay here' }).click();
  await expect(page.getByLabel('Article content')).toHaveValue('An untitled draft');
  await page.getByLabel('Article content').fill('');
  expect(await unloadBlocked(page)).toBe(false);
  await page.getByRole('link', { name: 'Elsewhere', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Other page' })).toBeVisible();
});

test('new titled drafts do not silently autosave and warn on other links and replace navigation', async ({ page }) => {
  const state = await mount(page, { fresh: true });
  await title(page).fill('Unsaved new title');
  await expect(preview(page)).toBeEnabled();
  await page.waitForTimeout(3300);
  expect(state.writes).toHaveLength(0);
  await page.getByRole('link', { name: 'Elsewhere', exact: true }).click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Stay here' }).click();
  await expect(title(page)).toHaveValue('Unsaved new title');
  await page.evaluate(() => window.fixtureNavigate('/elsewhere', { replace: true }));
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page.getByRole('heading', { name: 'Other page' })).toBeVisible();
  expect(await unloadBlocked(page)).toBe(false);
});

test('browser Back and Forward retain edits when cancelled and resume the requested route when discarded', async ({ page }) => {
  await mount(page);
  await expect(preview(page)).toBeEnabled();
  await page.getByRole('link', { name: 'Elsewhere', exact: true }).click();
  await page.getByRole('link', { name: 'Open editor' }).click();
  await expect(preview(page)).toBeEnabled();
  await title(page).fill('Retain across Back');
  await page.evaluate(() => window.history.back());
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page).toHaveURL(/ArticleEditor\?id=saved$/);
  await page.getByRole('button', { name: 'Stay here' }).click();
  await expect(title(page)).toHaveValue('Retain across Back');
  await page.evaluate(() => window.history.back());
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page.getByRole('heading', { name: 'Other page' })).toBeVisible();
  // Back once more returns to the first editor, with a forward entry available.
  await page.goBack();
  await expect(preview(page)).toBeEnabled();
  await title(page).fill('Retain across Forward');
  await page.evaluate(() => window.history.forward());
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Stay here' }).click();
  await expect(title(page)).toHaveValue('Retain across Forward');
  await page.evaluate(() => window.history.forward());
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page.getByRole('heading', { name: 'Other page' })).toBeVisible();
});

for (const unconfirmed of [false, true]) test(`${unconfirmed ? 'unconfirmed' : 'failed'} autosaves retain protection until a confirmed save`, async ({ page }) => {
  const state = await mount(page);
  await expect(preview(page)).toBeEnabled();
  state.fail = !unconfirmed;
  state.unconfirmed = unconfirmed;
  await title(page).fill('Not yet saved');
  await expect(page.getByRole('alert')).toContainText(unconfirmed ? 'could not be confirmed' : 'Fixture save failed', { timeout: 7000 });
  expect(await unloadBlocked(page)).toBe(true);
  await page.getByRole('link', { name: 'Elsewhere', exact: true }).click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Stay here' }).click();
  state.fail = false;
  state.unconfirmed = false;
  await page.getByTestId('button-save-article').click();
  await expect(preview(page)).toBeEnabled();
  expect(await unloadBlocked(page)).toBe(false);
  await page.getByRole('link', { name: 'Elsewhere', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Other page' })).toBeVisible();
});

test('an older successful autosave cannot clear newer edits; reverting to the saved value clears protection', async ({ page }) => {
  const state = await mount(page);
  await expect(preview(page)).toBeEnabled();
  state.delay = 1200;
  await title(page).fill('Saved by in-flight request');
  await expect.poll(() => state.writes.length, { timeout: 7000 }).toBe(1);
  await title(page).fill('Newer unsaved text');
  await expect(preview(page)).toBeEnabled();
  expect(await unloadBlocked(page)).toBe(true);
  await title(page).fill('Saved by in-flight request');
  expect(await unloadBlocked(page)).toBe(false);
});

test('failed manual saves stay guarded and a new draft Save redirect does not warn', async ({ page }) => {
  const state = await mount(page, { fresh: true });
  await title(page).fill('Save this new draft');
  await expect(preview(page)).toBeEnabled();
  state.fail = true;
  await page.getByTestId('button-save-article').click();
  await expect(page.getByRole('alert')).toContainText('Fixture save failed');
  expect(await unloadBlocked(page)).toBe(true);
  state.fail = false;
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.type()); dialog.dismiss(); });
  await page.getByTestId('button-save-article').click();
  await expect(page).toHaveURL(/ArticleEditor\?id=created$/);
  expect(dialogs).toEqual([]);
  expect(state.writes.map(write => write.action)).toEqual(['create', 'create']);
});

test('reload uses the native browser warning and cancellation preserves the draft', async ({ page }) => {
  await mount(page, { fresh: true });
  await title(page).fill('Do not lose this on reload');
  const dialogEvent = page.waitForEvent('dialog');
  const reload = page.evaluate(() => window.location.reload());
  const dialog = await dialogEvent;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await reload;
  await expect(title(page)).toHaveValue('Do not lose this on reload');
  const closeEvent = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const closeDialog = await closeEvent;
  expect(closeDialog.type()).toBe('beforeunload');
  await closeDialog.dismiss();
  expect(page.isClosed()).toBe(false);
  await expect(title(page)).toHaveValue('Do not lose this on reload');
});

test('image removal, focal changes and pending feature/content/social uploads are protected', async ({ page }) => {
  const state = await mount(page);
  await expect(preview(page)).toBeEnabled();
  // Keep the image-only edits unsaved while the navigation warning is checked.
  state.fail = true;
  await page.getByTestId('focal-point-picker').click({ position: { x: 10, y: 10 } });
  expect(await unloadBlocked(page)).toBe(true);
  await page.getByRole('link', { name: 'Elsewhere', exact: true }).click();
  await expect(leaveDialog(page)).toBeVisible();
  await page.getByRole('button', { name: 'Stay here' }).click();
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  expect(await unloadBlocked(page)).toBe(true);
  state.fail = false;
  await page.getByTestId('button-save-article').click();
  await expect(preview(page)).toBeEnabled();
  expect(await unloadBlocked(page)).toBe(false);
  state.uploadDelay = 800;
  const upload = { name: 'fixture.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') };
  await page.locator('input[type=file]').first().setInputFiles(upload);
  await expect(preview(page)).toBeDisabled();
  expect(await unloadBlocked(page)).toBe(true);
  await expect(preview(page)).toBeEnabled();
  expect(await unloadBlocked(page)).toBe(true);
  await page.getByTestId('button-save-article').click();
  await expect(preview(page)).toBeEnabled();
  expect(await unloadBlocked(page)).toBe(false);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert content image' }).click();
  await (await chooser).setFiles(upload);
  await expect(preview(page)).toBeDisabled();
  expect(await unloadBlocked(page)).toBe(true);
  await expect(preview(page)).toBeEnabled();
  await page.getByTestId('button-save-article').click();
  await expect(preview(page)).toBeEnabled();
  expect(await unloadBlocked(page)).toBe(false);
  await page.getByRole('button', { name: 'SEO & Social' }).click();
  await page.locator('input[type=file]').last().setInputFiles(upload);
  await expect(preview(page)).toBeDisabled();
  expect(await unloadBlocked(page)).toBe(true);
  await expect(preview(page)).toBeEnabled();
  expect(await unloadBlocked(page)).toBe(true);
});

for (const name of ['Articles', 'Blogs']) test(`${name}: immediate save, fresh cached preview, retained image and Edit round trip`, async ({ page }) => {
  const state = await mount(page, { name, mobile: name === 'Blogs' });
  await expect(preview(page)).toBeEnabled();
  const bounds = await preview(page).boundingBox();
  const saveBounds = await page.getByTestId('button-save-article').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(Math.abs(bounds.y - saveBounds.y)).toBeLessThan(2);
  await title(page).fill('Immediate changed title');
  await page.getByLabel('Article content').fill('<p>Immediate changed content</p>');
  await preview(page).click();
  await expect(page).toHaveURL(new RegExp(`/${name.toLowerCase()}/alex/original\\?preview=true$`));
  await expect(page.getByRole('heading', { name: 'Immediate changed title' })).toBeVisible();
  await expect(page.getByText('Immediate changed content', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Immediate changed title' })).toHaveAttribute('src', /retained.svg$/);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].data).not.toHaveProperty('feature_image_url');
  expect(state.record.status).toBe('draft');
  expect(state.record.published_date).toBe('2030-01-01T12:00:00.000Z');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/editor\?id=saved$/i);
  await expect(title(page)).toHaveValue('Immediate changed title');
});

test('new draft saves once despite repeated clicks; Edit reopens the created record', async ({ page }) => {
  const state = await mount(page, { fresh: true });
  await expect(preview(page)).toBeDisabled();
  await title(page).fill('My new draft');
  await expect(preview(page)).toBeEnabled();
  state.delay = 600;
  await preview(page).evaluate(button => { button.click(); button.click(); });
  await expect(preview(page)).toHaveText('Saving preview…');
  await expect(page.getByTestId('button-save-article')).toBeDisabled();
  await expect(title(page)).toBeDisabled();
  await expect(page).toHaveURL(/\/articles\/alex\/my-new-draft\?preview=true$/);
  expect(state.writes).toHaveLength(1);
  expect(state.record.status).toBe('draft');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/ArticleEditor\?id=created$/);
  await expect(title(page)).toHaveValue('My new draft');
  await preview(page).click();
  await expect(page).toHaveURL(/\/articles\/alex\/my-new-draft\?preview=true$/);
  expect(state.writes.map(w => w.action)).toEqual(['create', 'update']);
});

test('changed legacy slug and guest author use the saved canonical destination', async ({ page }) => {
  const state = await mount(page, { name: 'Blogs', admin: true, record: { slug: 'original-by-alex-old' } });
  await expect(page.locator('#slug')).toHaveValue('original');
  await page.getByTestId('radio-author-guest').check();
  await page.locator('select').first().selectOption('g1');
  await page.locator('#slug').fill('guest-story');
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await expect(page).toHaveURL(/\/blogs\/guest\/guest-story\?preview=true$/);
  await expect(page.getByText('Preview Mode', { exact: true })).toBeVisible();
  expect(state.record.author_id).toBeNull();
  expect(state.record.guest_writer_id).toBe('g1');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/blogseditor\?id=saved$/);
});

test('save failure retains edits and allows retry without navigation', async ({ page }) => {
  const state = await mount(page);
  await expect(preview(page)).toBeEnabled();
  await title(page).fill('Keep my unsaved edits');
  state.fail = true;
  await preview(page).click();
  await expect(page.getByRole('alert')).toContainText('Fixture save failed');
  await expect(page).toHaveURL(/ArticleEditor\?id=saved$/);
  await expect(title(page)).toHaveValue('Keep my unsaved edits');
  state.fail = false;
  await preview(page).click();
  await expect(page.getByRole('heading', { name: 'Keep my unsaved edits' })).toBeVisible();
});

test('in-flight autosave blocks preview; later edits win and no old timer writes after preview', async ({ page }) => {
  const state = await mount(page);
  await expect(preview(page)).toBeEnabled();
  state.delay = 1000;
  await title(page).fill('Autosaved older text');
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(preview(page)).toBeDisabled();
  await title(page).fill('Latest preview text');
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await expect(page.getByRole('heading', { name: 'Latest preview text' })).toBeVisible();
  await page.waitForTimeout(3200);
  expect(state.writes).toHaveLength(2);
  expect(state.record.title).toBe('Latest preview text');
});

test('feature and inline uploads block preview until the uploaded image is in the save', async ({ page }) => {
  const state = await mount(page, { record: { feature_image_url: '' } });
  await expect(preview(page)).toBeEnabled();
  state.uploadDelay = 900;
  const upload = { name: 'image.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') };
  await page.locator('input[type=file]').first().setInputFiles(upload);
  await expect(preview(page)).toBeDisabled();
  await expect(preview(page)).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert content image' }).click();
  await (await chooser).setFiles(upload);
  await expect(preview(page)).toBeDisabled();
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await expect(page).toHaveURL(/preview=true$/);
  expect(state.record.feature_image_url).toMatch(/uploaded.svg$/);
  expect(state.record.content).toContain('uploaded.svg');
});

test('blank titles, blank slugs and unresolved slug checks cannot navigate', async ({ page }) => {
  const state = await mount(page);
  await expect(preview(page)).toBeEnabled();
  await title(page).fill('   ');
  await expect(preview(page)).toBeDisabled();
  await title(page).fill('Restored title');
  await page.locator('#slug').fill('');
  await expect(preview(page)).toBeDisabled();
  state.slugDelay = 1000;
  await page.locator('#slug').fill('changed-slug');
  await expect(preview(page)).toBeDisabled();
  await expect(preview(page)).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});

test('an existing other member author is preserved and resolves their handle', async ({ page }) => {
  const state = await mount(page, { admin: true, record: { author_id: 'm2', original_author_id: 'm2' } });
  await expect(preview(page)).toBeEnabled();
  await page.locator('#slug').fill('revised');
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await expect(page).toHaveURL(/\/articles\/other-author\/revised\?preview=true$/);
  expect(state.record.author_id).toBe('m2');
});

test('preview does not publish a draft even when the unsaved status is Published', async ({ page }) => {
  const state = await mount(page, { fresh: true });
  await title(page).fill('Not a publish action');
  await page.getByRole('combobox').last().click();
  await page.getByRole('option', { name: 'Published', exact: true }).click();
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await expect(page).toHaveURL(/preview=true$/);
  expect(state.record.status).toBe('draft');
});

test('scheduled published articles preview without changing release time or status', async ({ page }) => {
  const state = await mount(page, { record: { status: 'published' } });
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await expect(page).toHaveURL(/preview=true$/);
  await expect(page.getByText('Preview Mode', { exact: true })).toBeVisible();
  expect(state.record.status).toBe('published');
  expect(state.record.published_date).toBe('2030-01-01T12:00:00.000Z');
});

test('normal Save retains explicit status changes and stays in an existing editor', async ({ page }) => {
  const state = await mount(page);
  await page.getByRole('combobox').last().click();
  await page.getByRole('option', { name: 'Published', exact: true }).click();
  await expect(page.getByTestId('button-save-article')).toBeEnabled();
  await page.getByTestId('button-save-article').click();
  await expect.poll(() => state.record.status).toBe('published');
  await expect(page).toHaveURL(/ArticleEditor\?id=saved$/);
});

for (const automatic of [false, true]) {
  for (const [initial, target] of [['published', 'draft'], ['draft', 'published']]) {
    test(`${automatic ? 'Autosave' : 'Save'} ${initial} → ${target} then Preview preserves the latest saved status`, async ({ page }) => {
      const state = await mount(page, { record: { status: initial, published_date: '2020-01-01T12:00:00.000Z' } });
      await expect(preview(page)).toBeEnabled();
      await page.getByRole('combobox').last().click();
      await page.getByRole('option', { name: target === 'draft' ? 'Draft' : 'Published', exact: true }).click();
      if (!automatic) await page.getByTestId('button-save-article').click();
      await expect.poll(() => state.record.status, { timeout: 7000 }).toBe(target);
      await expect(preview(page)).toBeEnabled();
      await preview(page).click();
      await expect(page).toHaveURL(target === 'draft'
        ? /\/articles\/alex\/original\?preview=true$/
        : /\/articles\/alex\/original$/);
      await expect(page.getByRole('heading', { name: 'Original title' })).toBeVisible();
      expect(state.record.status).toBe(target);
      expect(state.writes.map(w => w.data.status)).toEqual([target, target]);
    });
  }
}

test('loading and failed author discovery prevent unsafe saves', async ({ page }) => {
  const state = await mount(page, { readDelay: 700, authorFail: true });
  await expect(page.getByRole('alert')).toContainText('Could not load the saved authors');
  await expect(preview(page)).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test('duplicate and failed slug checks prevent preview, including after author changes', async ({ page }) => {
  const state = await mount(page);
  await expect(preview(page)).toBeEnabled();
  state.duplicate = true;
  await page.locator('#slug').fill('conflict');
  await expect(page.getByText('This URL is already in use.', { exact: false })).toBeVisible();
  await expect(preview(page)).toBeDisabled();
  state.duplicate = false; state.slugFail = true;
  await page.locator('#slug').fill('check-fails');
  await expect(page.getByText('Could not check this URL.', { exact: false })).toBeVisible();
  await expect(preview(page)).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test('social image uploads also prevent preview until their saved URL is ready', async ({ page }) => {
  const state = await mount(page);
  await expect(preview(page)).toBeEnabled();
  state.uploadDelay = 900;
  await page.getByRole('button', { name: 'SEO & Social Sharing' }).click();
  await page.getByTestId('input-og-image-file').setInputFiles({
    name: 'social.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"/>'),
  });
  await expect(preview(page)).toBeDisabled();
  await expect(preview(page)).toBeEnabled();
  await preview(page).click();
  await expect(page).toHaveURL(/preview=true$/);
  expect(state.record.og_image_url).toBe('https://preview.test/social.svg');
});
