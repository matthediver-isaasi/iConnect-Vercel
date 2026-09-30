import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { matchRoutes } from 'react-router-dom';
import { getNavigationDestinationError, getNavigationPageSelectValue, getNavigationPageUrl } from './navigationItemDestination.js';

const source = readFileSync(new URL('../pages/NavigationManagement.jsx', import.meta.url), 'utf8');
const router = readFileSync(new URL('../pages/index.jsx', import.meta.url), 'utf8');
const utils = readFileSync(new URL('../utils/index.ts', import.meta.url), 'utf8');
const pages = vm.runInNewContext(source.match(/const hardcodedPublicPages = (\[[\s\S]*?\n\]);/)[1]);
const createPageUrl = new Function('pageName', utils.match(/export function createPageUrl\(pageName: string\) \{([\s\S]*?)\n\}/)[1]);
const galleryRoutes = [...router.matchAll(/<Route path="([^"]+)" element=\{<GalleryDirectory \/>\} \/>/g)]
  .map((match) => ({ path: match[1], id: 'gallery' }));

test('shared internal page picker offers Gallery Directory with sorted display labels', () => {
  assert.equal(pages.filter(page => page.name === 'GalleryDirectory').length, 1);
  assert.equal(pages.find(page => page.name === 'GalleryDirectory').label, 'Gallery Directory');
  assert.match(source, /hardcodedPublicPages, \.\.\.ieditPages, \.\.\.dynamicDirectories\]\.sort\(\(a, b\) => a\.label\.localeCompare\(b\.label\)\)/);
  assert.match(source, /availablePages\.map\(page =>/);
});

for (const location of ['top_nav', 'main_nav', 'footer']) {
  test(`${location}: actual create/edit handlers preserve the gallery selection and route`, () => {
    let saved;
    let editingItem;
    const context = vm.createContext({
      getNavigationDestinationError,
      HEADER_CONTENT_BLOCK_TYPES: [],
      navItems: [],
      setEditingItem: item => { editingItem = item; },
      setShowDialog: () => {},
      toast: { error: message => assert.fail(message) },
      createMutation: { mutate: data => { saved = { ...data, id: 'fixture' }; } },
      updateMutation: { mutate: ({ id, data }) => { saved = { ...data, id }; } },
    });
    const saveBody = `(() => {${source.match(/const handleSave = \(\) => \{([\s\S]*?)\n  \};/)[1]}})()`;
    const editBody = source.match(/const handleEdit = \(item\) => \{([\s\S]*?)\n  \};/)[1];
    context.editingItem = { title: 'Galleries', location, link_type: 'internal', url: getNavigationPageUrl('GalleryDirectory') };
    vm.runInContext(saveBody, context);
    context.item = saved;
    vm.runInContext(editBody, context);
    assert.equal(getNavigationPageSelectValue(editingItem.url), 'GalleryDirectory');
    context.editingItem = { ...editingItem, title: 'Updated galleries' };
    vm.runInContext(saveBody, context);
    context.item = saved;
    vm.runInContext(editBody, context);
    assert.equal(editingItem.title, 'Updated galleries');
    assert.equal(editingItem.location, location);
    assert.equal(getNavigationPageSelectValue(editingItem.url), 'GalleryDirectory');
    const destination = createPageUrl(editingItem.url);
    assert.equal(destination, '/GalleryDirectory');
    assert.equal(matchRoutes([...galleryRoutes, { path: '*', id: 'fallback' }], destination)[0].route.id, 'gallery');
  });
}

test('canonical, lowercase and galleries aliases resolve to Gallery Directory, not fallback', () => {
  assert.deepEqual(galleryRoutes.map(route => route.path), ['/galleries', '/GalleryDirectory']);
  for (const path of ['/GalleryDirectory', '/gallerydirectory', '/galleries']) {
    assert.equal(matchRoutes([...galleryRoutes, { path: '*', id: 'fallback' }], path)[0].route.id, 'gallery');
  }
  assert.match(router, /GalleryDirectory: GalleryDirectory/);
});