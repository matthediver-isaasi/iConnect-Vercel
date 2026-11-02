import { test, expect } from '@playwright/test';

test('SEO settings opens suggestions, edits and applies one field, closes without losing applied changes', async ({ page, request }) => {
  const source = await (await request.get('/src/components/iedit/PageSeoSocialFields.jsx')).text();
  const react = source.match(/from\s+"([^"]*\/\.vite\/deps\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error('Running Vite app required');
  const reactDom = react.replace(/react\.js\?/, 'react-dom_client.js?');
  page.on('pageerror', error => console.error(error.message));
  await page.route('**/api/ai-compositions/seo', async route => {
    expect(route.request().postDataJSON().design).toEqual({ content: { text: 'Live draft' } });
    await route.fulfill({ json: { suggestions: {
      meta_title: 'Suggested page title', meta_description: 'Suggested description',
      seo_title: 'Social title', seo_description: 'Social description', og_image_url: '',
    } } });
  });
  await page.route('**/seo-test-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
    <script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import(${JSON.stringify(react)})).default;
    const {createRoot} = (await import(${JSON.stringify(reactDom)})).default;
    const Fields = (await import('/src/components/iedit/PageSeoSocialFields.jsx')).default;
    await import('/src/index.css');
    function App(){
      const [values,setValues]=React.useState({title:'Page',slug:'page',meta_title:'Original',meta_description:'Original description'});
      return React.createElement('main',{style:{padding:32,maxWidth:700}},
        React.createElement(Fields,{values,onChange:patch=>setValues(v=>({...v,...patch})),
          suggestionContext:{pageId:'823c98c6-2bfe-443b-b459-49924c33f69a',getDesign:()=>({content:{text:'Live draft'}})}}));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
    </script></body></html>` }));
  await page.goto('/seo-test-fixture');
  await page.getByRole('button', { name: /AI suggest/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByLabel('Meta Title', { exact: true })).toHaveValue('Suggested page title');
  await modal.getByLabel('Meta Title', { exact: true }).fill('My edited title');
  await modal.getByRole('button', { name: 'Apply Meta Title', exact: true }).click();
  await expect(modal.getByText('Applied to page settings — not saved')).toBeVisible();
  await expect(modal.getByText(/No suitable image found/)).toBeVisible();
  await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByTestId('input-meta-title')).toHaveValue('My edited title');
  await expect(page.getByTestId('input-meta-description')).toHaveValue('Original description');
});
