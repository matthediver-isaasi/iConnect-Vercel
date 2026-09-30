import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createDynamicPageRequestScope,
  getEarlyPublicPageRequest,
  isRelevantAccountStorageTransition,
  projectPublicPageDataForAudience,
} from './dynamicPageFirstLoad.js';

const dynamicPageSource = readFileSync(new URL('./DynamicPage.jsx', import.meta.url), 'utf8');

test('raw public transport scope is unique to each DynamicPage mount', () => {
  const first = createDynamicPageRequestScope();
  const second = createDynamicPageRequestScope();
  assert.notEqual(first, second);
});

test('account storage switches invalidate even before auth initializes', () => {
  assert.equal(isRelevantAccountStorageTransition({
    key: 'agcas_member',
    oldValue: JSON.stringify({ id: 'a', tenant_id: 't', organization_id: 'o' }),
    newValue: JSON.stringify({ id: 'b', tenant_id: 't', organization_id: 'o' }),
  }), true);
  assert.equal(isRelevantAccountStorageTransition({
    key: 'agcas_member',
    oldValue: JSON.stringify({ id: 'a', tenant_id: 't', organization_id: 'o' }),
    newValue: JSON.stringify({ id: 'a', tenant_id: 't', organization_id: 'o' }),
  }), false);
  assert.equal(isRelevantAccountStorageTransition({
    key: 'unrelated-setting',
    oldValue: 'a',
    newValue: 'b',
  }), false);
});

test('public page transport can be keyed directly from ordinary and microsite routes', () => {
  assert.deepEqual(
    getEarlyPublicPageRequest({ slug: 'about' }),
    { slug: 'about', micrositePrefix: null },
  );
  assert.deepEqual(
    getEarlyPublicPageRequest({
      slug: 'news',
      routeMicrositePrefix: 'Community',
    }),
    { slug: 'news', micrositePrefix: 'community' },
  );
  assert.deepEqual(
    getEarlyPublicPageRequest({
      slug: 'community',
      micrositeHome: { path_prefix: 'community', home_slug: 'welcome' },
    }),
    { slug: 'welcome', micrositePrefix: 'community' },
  );
});

test('an early member-shaped response is re-projected before guest consumption', () => {
  const protectedBlock = {
    type: 'custom-html',
    content: {
      memberOnly: true,
      html: '<p>member secret</p>',
      guestMessage: 'Please sign in',
    },
  };
  const response = {
    page: { canvas_design: { root: { sections: [{ children: [protectedBlock] }] } } },
    elements: [{ id: 'public-element' }],
    symbols: [{ id: 'symbol-1', design: { root: { sections: [{ children: [protectedBlock] }] } } }],
  };

  const guest = projectPublicPageDataForAudience(response, false);
  const guestBlock = guest.page.canvas_design.root.sections[0].children[0];
  const guestSymbolBlock = guest.symbols[0].design.root.sections[0].children[0];
  assert.equal(guestBlock.content.html, undefined);
  assert.equal(guestBlock.content.memberOnlyRedacted, true);
  assert.equal(guestSymbolBlock.content.html, undefined);
  assert.deepEqual(guest.elements, response.elements);

  const member = projectPublicPageDataForAudience(response, true);
  assert.equal(
    member.page.canvas_design.root.sections[0].children[0].content.html,
    '<p>member secret</p>',
  );
});

test('DynamicPage starts public transport outside route prerequisites and consumes it only afterward', () => {
  const earlyQueryIndex = dynamicPageSource.indexOf("'iedit-dynamic-page-public'");
  const pageEnabledIndex = dynamicPageSource.indexOf('const pageQueryEnabled');
  const resolvedQueryIndex = dynamicPageSource.indexOf("queryKey: ['iedit-dynamic-page'");

  assert.ok(earlyQueryIndex > 0);
  assert.ok(earlyQueryIndex < pageEnabledIndex);
  assert.ok(pageEnabledIndex < resolvedQueryIndex);
  assert.match(
    dynamicPageSource,
    /enabled: !!earlyPublicRequest[\s\S]*?!audienceTransitionPending[\s\S]*?!storageInvalidationPending/,
  );
  assert.match(dynamicPageSource, /queryKey: \[\s*'iedit-dynamic-page-public',\s*publicRequestScope/);
  assert.match(dynamicPageSource, /queryKey: \['iedit-dynamic-page', publicRequestScope/);
  assert.match(dynamicPageSource, /gcTime: 0/);
  assert.match(
    dynamicPageSource,
    /const pageQueryEnabled = routePrerequisitesReady[\s\S]*?earlyPublicPageFetched/,
  );
  assert.match(
    dynamicPageSource,
    /usePageLayoutDecision\(decisionReady \? \{[\s\S]*?\} : null\)/,
  );
});

test('auth reset and account transitions invalidate transport before content can render', () => {
  assert.match(
    dynamicPageSource,
    /if \(!authResolved\) \{[\s\S]*?tracker\.authResolved = false;[\s\S]*?setAudienceGeneration/,
  );
  assert.match(
    dynamicPageSource,
    /tracker\.identity !== resolvedAudienceIdentity[\s\S]*?setAudienceGeneration/,
  );
  assert.match(
    dynamicPageSource,
    /const routePrerequisitesReady =[\s\S]*?authResolved[\s\S]*?!audienceTransitionPending/,
  );
  assert.match(
    dynamicPageSource,
    /isRelevantAccountStorageTransition\(event\)[\s\S]*?setStorageInvalidationPending\(true\)[\s\S]*?setAudienceGeneration/,
  );
  assert.match(
    dynamicPageSource,
    /\(!canPreviewDrafts && !!earlyPublicRequest && !earlyPublicPageFetched\)/,
  );
});

test('authorized Canvas preview never starts the public page transport', () => {
  assert.match(
    dynamicPageSource,
    /&& \(!isCanvasPreview \|\| \(!previewAuthPending && !canPreviewDrafts\)\)/,
  );
  assert.match(
    dynamicPageSource,
    /pageQueryEnabled =[\s\S]*?\(canPreviewDrafts \|\| earlyPublicPageFetched\)/,
  );
});

test('all DynamicPage pending states provide visible neutral feedback', () => {
  for (const testId of [
    'loading-microsite',
    'loading-dynamic-page',
    'page-checking-redirect',
    'loading-access-check',
  ]) {
    assert.match(
      dynamicPageSource,
      new RegExp(`<NeutralPageLoading testId="${testId}"`),
    );
  }
  assert.doesNotMatch(dynamicPageSource, /className="sr-only">(?:Loading content|Checking page)/);
  assert.match(dynamicPageSource, /role="status"/);
});