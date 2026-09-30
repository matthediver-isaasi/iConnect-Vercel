import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const management = read('../pages/PageBannerManagement.jsx');
const portal = read('../pages/Layout.jsx');
const publicLayout = read('../components/layouts/PublicLayout.jsx');
const router = read('../pages/index.jsx');
const evaluate = (code, context = {}) => vm.runInNewContext(code, context);
const literal = (source, name, end) =>
  source.slice(source.indexOf(`const ${name} = `) + `const ${name} = `.length,
    source.indexOf(end, source.indexOf(`const ${name} = `)) + 1);
const pageMap = (source) => evaluate(`(${literal(source, 'pageToPortalPageMap', '};')})`);
const destination = 'portal_member_groups';

test('both selectors register the same directory destination, distinct from management', () => {
  for (const name of ['BUILT_IN_PUBLIC_PAGES', 'BUILT_IN_PORTAL_PAGES']) {
    const pages = evaluate(literal(management, name, '];'));
    assert.equal(pages.filter(p => p.value === destination).length, 1);
    assert.equal(pages.find(p => p.value === destination).label, 'Member Groups (Directory)');
  }
  assert.match(management, /value: "portal_member_group_management", label: "Member Group Management"/);
});

test('real selection, save payload, and reopen handlers preserve either selector selection', () => {
  for (const name of ['BUILT_IN_PUBLIC_PAGES', 'BUILT_IN_PORTAL_PAGES']) {
    const option = evaluate(literal(management, name, '];')).find(p => p.value === destination);
    let editingBanner = { name: 'Directory banner', banner_type: 'image', image_url: '/banner.png', associated_pages: [], is_active: true };
    const context = {
      editingBanner,
      setEditingBanner: value => { editingBanner = value; },
    };
    const toggle = management.slice(management.indexOf('const togglePage ='), management.indexOf('\n  if (!accessChecked)'));
    evaluate(`${toggle}; togglePage(${JSON.stringify(option.value)});`, context);
    let saved;
    const save = management.slice(management.indexOf('const handleSave ='), management.indexOf('const togglePage ='));
    evaluate(`${save}; handleSave();`, {
      editingBanner, console: { log() {} },
      toast: { error(message) { throw new Error(message); } },
      createBannerMutation: { mutate(data) { saved = JSON.parse(JSON.stringify(data)); } },
    });
    assert.deepEqual(saved.associated_pages, [destination]);
    const edit = management.slice(management.indexOf('const handleEdit ='), management.indexOf('const handleDuplicate ='));
    evaluate(`${edit}; handleEdit(saved);`, {
      saved: { ...saved, id: 'saved-banner' },
      setEditingBanner(value) { editingBanner = value; },
      setShowDialog(value) { assert.equal(value, true); },
    });
    assert.deepEqual(editingBanner.associated_pages, [destination]);
  }
});

test('both route spellings resolve to the canonical page and both layout mappings', () => {
  // Execute the router's actual case-insensitive built-in page lookup.
  const lookup = router.match(/const pageName = Object\.keys\(PAGES\)\.find\([^\n]+/)[0];
  for (const path of ['/memberGroups', '/MemberGroups']) {
    const page = evaluate(`${lookup}; pageName`, {
      PAGES: { MemberGroups: {} }, urlLastPart: path.slice(1),
    });
    assert.equal(page, 'MemberGroups');
    for (const source of [portal, publicLayout]) assert.equal(pageMap(source)[page], destination);
  }
  assert.match(router, /<Route path="\/MemberGroups" element={<MemberGroups \/>} \/>/);
  assert.equal(pageMap(portal).MemberGroupDetail, undefined);
  assert.equal(pageMap(publicLayout).MemberGroupDetail, undefined);
});

test('actual layout filters match only assigned banners and preserve ordering and positions', () => {
  const banners = [
    { id: 'second', is_active: true, associated_pages: [destination], display_order: 2, page_position: 'below_first_element' },
    { id: 'inactive', is_active: false, associated_pages: [destination], display_order: 0 },
    { id: 'first', is_active: true, associated_pages: [destination], display_order: 1 },
    { id: 'events', is_active: true, associated_pages: ['portal_events'], display_order: 0 },
    { id: 'management', is_active: true, associated_pages: ['portal_member_group_management'] },
  ];
  // Both existing data sources filter active rows before layout matching.
  assert.match(portal, /filter: \{ is_active: true \}/);
  assert.match(read('../../../api/public/banners.js'), /\.eq\('is_active', true\)/);
  const active = banners.filter(b => b.is_active).sort((a, b) => a.display_order - b.display_order);
  const portalFilter = portal.slice(portal.indexOf('const matchingBanners ='), portal.indexOf("console.log('[Layout] Matched banners"));
  const publicFilter = publicLayout.slice(publicLayout.indexOf('const pageBanners ='), publicLayout.indexOf("console.log('[PublicLayout] Matched banners:"));
  for (const [page, expected] of [['MemberGroups', ['first', 'second']], ['Events', ['events']]]) {
    const portalPageId = pageMap(portal)[page];
    const matchedPortal = evaluate(`${portalFilter}; matchingBanners`, { banners: active, currentPortalPageId: portalPageId });
    const matchedPublic = evaluate(`${publicFilter}; pageBanners`, {
      allBanners: active, portalPageId, currentPageName: page,
      pageToPortalPageMap: pageMap(publicLayout), console: { log() {} },
    });
    for (const result of [matchedPortal, matchedPublic]) {
      assert.deepEqual(Array.from(result, b => b.id), expected);
      if (page === 'MemberGroups') assert.equal(result[1].page_position, 'below_first_element');
    }
  }
});

test('guest page visibility remains settings-controlled, not made public by banner registration', () => {
  assert.match(portal, /if \(pageVisibilitySettings\[pageName\]\) \{\s*return pageVisibilitySettings\[pageName\]/);
  for (const name of ['publicPages', 'hybridPages']) {
    assert.equal(evaluate(literal(portal, name, '];')).includes('MemberGroups'), false);
  }
  assert.match(portal, /<PublicLayout currentPageName=\{effectivePageName\}>/);
});