import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { publicClient } from '@/api/publicClient';
import {
  createPublicPageHandoff, eligiblePublicPageLink, PublicNavigationPending,
  PublicPageNavigationProvider, usePublicPageNavigation,
} from './PublicPageNavigation';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid/a' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
const request = slug => ({ slug, micrositePrefix: null });

test('handoff is one-use, tenant/prefix/audience scoped, and explicitly disposable', () => {
  const handoff = createPublicPageHandoff();
  const promise = Promise.resolve({ data: { page: { hide_chrome: true } } });
  handoff.put('tenant-a/guest', request('a'), promise);
  assert.equal(handoff.take('tenant-b/guest', request('a')), null);
  assert.equal(handoff.take('tenant-a/member', request('a')), null);
  assert.equal(handoff.take('tenant-a/guest', { slug: 'a', micrositePrefix: 'branch' }), null);
  assert.equal(handoff.take('tenant-a/guest', request('a')).promise, promise);
  assert.equal(handoff.take('tenant-a/guest', request('a')), null, 'A-B-A must obtain a fresh response');
  handoff.put('tenant-a/guest', request('a'), promise);
  handoff.clear();
  assert.equal(handoff.take('tenant-a/guest', request('a')), null);
  handoff.put('tenant-a/guest', request('a'), promise, undefined, '/branch/a');
  handoff.retain('tenant-a/guest', '/branch/a');
  assert.equal(handoff.take('tenant-a/guest', request('a')).promise, promise,
    'destination metadata readiness can close without discarding its one-use transport');
  handoff.put('tenant-a/guest', request('a'), promise, undefined, '/branch/a');
  handoff.retain('tenant-a/member', '/branch/a');
  assert.equal(handoff.take('tenant-a/guest', request('a')), null, 'audience closure still discards transport');
  handoff.put('tenant-a/guest', request('a'), promise, undefined, '/branch/a');
  handoff.retain('tenant-a/guest', '/other/a');
  assert.equal(handoff.take('tenant-a/guest', request('a')), null, 'an unrelated route cannot keep a handoff');
});

test('eligible navigation preserves browser semantics and excludes unmatched endpoints and previews', () => {
  const anchor = document.createElement('a');
  const event = { button: 0 };
  const current = new URL('https://fixture.invalid/a');
  const resolve = path => path === '/b' ? request('b') : null;
  anchor.href = '/b#content';
  assert.deepEqual(eligiblePublicPageLink(anchor, event, current, resolve), { to: '/b#content', request: request('b') });
  for (const changed of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true },
    { button: 1 }, { defaultPrevented: true }]) {
    assert.equal(eligiblePublicPageLink(anchor, { ...event, ...changed }, current, resolve), null);
  }
  for (const href of ['#content', '/a#content', '/b?_canvasPreview=1', '/api/download', '/Login', 'https://other.invalid/b', 'mailto:fixture@example.invalid']) {
    anchor.href = href;
    assert.equal(eligiblePublicPageLink(anchor, event, current, resolve), null, href);
  }
  anchor.href = '/b';
  anchor.target = '_blank';
  assert.equal(eligiblePublicPageLink(anchor, event, current, resolve), null);
  anchor.target = '';
  anchor.setAttribute('download', '');
  assert.equal(eligiblePublicPageLink(anchor, event, current, resolve), null);
});

for (const prefix of ['', '/branch']) {
  test(`slow A-B-A preserves current website until destination read; no reusable cache: ${prefix || 'main site'}`, async () => {
    const original = publicClient.getPage;
    const reads = [];
    let finish;
    publicClient.getPage = async (slug, micrositePrefix) => {
      reads.push({ slug, micrositePrefix });
      return new Promise(resolve => { finish = resolve; });
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let location;
    let consumed;
    function Site() {
      location = useLocation();
      window.history.replaceState({}, '', location.pathname);
      const navigation = usePublicPageNavigation();
      const slug = location.pathname.split('/').pop();
      if (slug === 'hidden') consumed = navigation.take({ slug, micrositePrefix: prefix ? 'branch' : null });
      return <div onClickCapture={navigation.onClick}>
        <PublicNavigationPending />
        {slug !== 'hidden' && <header><input defaultValue="menu state" /></header>}
        <p>{slug} content</p>
        <a href={`${prefix}/${slug === 'a' ? 'b' : 'a'}`}>Next</a>
        <a href={`${prefix}/hidden`}>Hidden</a>
      </div>;
    }
    const render = scope => act(async () => root.render(
      <MemoryRouter initialEntries={[`${prefix}/a`]}>
        <PublicPageNavigationProvider scope={scope} enabled resolveDestination={path => ({
          slug: path.split('/').pop(), micrositePrefix: prefix ? 'branch' : null,
        })}><Site /></PublicPageNavigationProvider>
      </MemoryRouter>,
    ));
    const click = label => act(async () => {
      [...container.querySelectorAll('a')].find(node => node.textContent === label)
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    try {
      await render('tenant-a/guest');
      const header = container.querySelector('header');
      for (const slug of ['b', 'a']) {
        await click('Next');
        assert.equal(container.querySelector('header'), header);
        assert.equal(location.pathname, `${prefix}/${slug === 'b' ? 'a' : 'b'}`);
        assert.match(container.querySelector('[role=status]').textContent, /Opening page/);
        assert.equal(container.querySelector('[role=status]').className, 'sr-only');
        assert.equal(container.querySelector('button'), null);
        await act(async () => finish({ page: { slug, public_chrome: 'both' } }));
        assert.equal(location.pathname, `${prefix}/${slug}`);
        assert.equal(container.querySelector('header'), header);
      }
      await click('Hidden');
      assert.equal(container.querySelector('header'), header, 'old chrome belongs only to old URL');
      await act(async () => finish({ page: { slug: 'hidden', hide_chrome: true } }));
      assert.equal(location.pathname, `${prefix}/hidden`);
      assert.equal(container.querySelector('header'), null);
      assert.equal(consumed.result.data.page.hide_chrome, true);
      assert.equal(reads.length, 3);
      assert.equal(reads[0].micrositePrefix, prefix ? 'branch' : null);
    } finally {
      await act(async () => root.unmount());
      publicClient.getPage = original;
      container.remove();
    }
  });
}

test('cancel and audience changes suppress late navigation and its response', async () => {
  const original = publicClient.getPage;
  let finish;
  publicClient.getPage = () => new Promise(resolve => { finish = resolve; });
  const container = document.createElement('div');
  const root = createRoot(container);
  let location;
  let navigation;
  function Site() {
    location = useLocation();
    navigation = usePublicPageNavigation();
    return <div onClickCapture={navigation.onClick}><PublicNavigationPending /><a href="/b">Next</a></div>;
  }
  const render = (scope, enabled = true) => act(async () => root.render(
    <MemoryRouter initialEntries={['/a']}>
      <PublicPageNavigationProvider scope={scope} enabled={enabled} resolveDestination={() => request('b')}>
        <Site />
      </PublicPageNavigationProvider>
    </MemoryRouter>,
  ));
  const click = () => act(async () => container.querySelector('a').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
  ));
  try {
    for (const transition of ['cancel', 'guest-to-member', 'member-to-guest', 'tenant', 'unresolved', 'storage']) {
      await render(`initial-${transition}`);
      await click();
      if (transition === 'cancel') await act(async () => navigation.cancel());
      else if (transition === 'storage') await act(async () => window.dispatchEvent(
        new window.StorageEvent('storage', { key: 'agcas_member', oldValue: '{"id":"a"}', newValue: null }),
      ));
      else await render(`changed-${transition}`, transition !== 'unresolved');
      await act(async () => finish({ page: { slug: 'b' } }));
      assert.equal(location.pathname, '/a', transition);
      assert.equal(navigation.take(request('b')), null, transition);
    }
  } finally {
    await act(async () => root.unmount());
    publicClient.getPage = original;
  }
});
