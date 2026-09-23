import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPublicPageHandler,
  buildPublicCanvasPagePayload,
} from './page/[slug].js';
import {
  createCanvasSymbolsHandler,
  projectPublicSymbols,
} from './canvas-symbols.js';
import {
  createTenantBrandingHandler,
} from './tenant-branding.js';
import { renderCanvasDesignBody } from './prerender.js';
import { buildPublicPageSearchResult } from './search.js';
import {
  resolveCanvasViewer,
  viewerFromTenantContext,
} from '../_lib/canvasMemberOnly.js';
import { projectCanvasDesignForGuest } from '../../shared/canvasMemberOnly.js';
import {
  buildGoogleFinalRedirect,
} from '../auth/google/callback.js';
import {
  buildOutlookSuccessRedirect,
} from '../auth/outlook/callback.js';

const TENANT_ID = 'tenant-a';
const SECRET = '<p>member secret — do not expose</p>';
let blockSequence = 0;

function customHtmlBlock(html = SECRET, extra = {}) {
  return {
    id: `html-${++blockSequence}`,
    type: 'custom-html',
    content: {
      html,
      memberOnly: true,
      guestMessage: '<strong>Log in to continue</strong>',
      ...extra,
    },
  };
}

function makeDesign() {
  return {
    version: 1,
    root: {
      sections: [{
        id: 'section-1',
        children: [
          customHtmlBlock(),
          {
            id: 'symbol-block',
            type: 'symbol',
            content: { symbolId: 'symbol-1' },
          },
        ],
      }],
    },
  };
}

function makeDb({ page, symbols = [] }) {
  const rows = {
    i_edit_page: [page],
    canvas_symbol: symbols,
    i_edit_page_element: [],
  };
  return {
    from(table) {
      const filters = {};
      let ids = null;
      const query = {
        select() { return query; },
        eq(key, value) { filters[key] = value; return query; },
        in(key, values) { if (key === 'id') ids = values; return query; },
        order() { return query; },
        async single() {
          const result = (rows[table] || []).filter((row) => {
            for (const [key, value] of Object.entries(filters)) {
              if (row[key] !== value) return false;
            }
            if (ids && !ids.includes(row.id)) return false;
            return true;
          });
          return { data: result[0] || null, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({
            data: (rows[table] || []).filter((row) => {
              for (const [key, value] of Object.entries(filters)) {
                if (row[key] !== value) return false;
              }
              if (ids && !ids.includes(row.id)) return false;
              return true;
            }),
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function responseMock() {
  const headers = new Map();
  const response = {
    statusCode: 200,
    body: undefined,
    headers,
    setHeader(name, value) { headers.set(name, value); },
    getHeader(name) { return headers.get(name); },
    status(code) { response.statusCode = code; return response; },
    json(body) { response.body = body; return response; },
    send(body) { response.body = body; return response; },
    end(body) { response.body = body; return response; },
  };
  return response;
}

function request(query = {}) {
  return {
    method: 'GET',
    query,
    headers: { host: 'tenant-a.example.test' },
  };
}

function memberViewer(memberId = 'member-a') {
  return viewerFromTenantContext({
    tenantId: TENANT_ID,
    memberId,
    isAuthenticated: true,
  }, TENANT_ID);
}

function editorViewer() {
  return viewerFromTenantContext({
    tenantId: TENANT_ID,
    tenantUserId: 'editor-a',
    isAuthenticated: true,
  }, TENANT_ID);
}

function guestViewer() {
  return viewerFromTenantContext(null, TENANT_ID);
}

test('public page endpoint guest/member/editor projections and cache isolation', async () => {
  const page = {
    id: 'page-1',
    tenant_id: TENANT_ID,
    slug: 'members',
    status: 'published',
    layout_type: 'public',
    builder_type: 'canvas',
    canvas_design: makeDesign(),
  };
  const symbols = [{
    id: 'symbol-1',
    tenant_id: TENANT_ID,
    design: { root: { sections: [{ children: [customHtmlBlock('<p>symbol secret</p>')] }] } },
  }];
  const db = makeDb({ page, symbols });

  for (const [label, viewer, shouldExpose] of [
    ['guest', guestViewer(), false],
    ['member', memberViewer(), true],
    ['editor', editorViewer(), true],
    ['cross-tenant', viewerFromTenantContext({
      tenantId: 'tenant-b',
      memberId: 'member-b',
      isAuthenticated: true,
    }, TENANT_ID), false],
  ]) {
    const handler = createPublicPageHandler({
      db,
      resolveTenant: async () => ({ id: TENANT_ID }),
      resolveViewer: async () => viewer,
    });
    const res = responseMock();
    await handler(request({ slug: 'members' }), res);
    assert.equal(res.statusCode, 200, label);
    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes('member secret'), shouldExpose, label);
    assert.equal(serialized.includes('symbol secret'), shouldExpose, label);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store, must-revalidate', label);
    assert.match(res.headers.get('Vary'), /Cookie/);
    assert.match(res.headers.get('Vary'), /Authorization/);
    if (!shouldExpose) {
      assert.equal(res.body.page.canvas_design.root.sections[0].children[0].content.html, undefined);
      assert.equal(
        res.body.page.canvas_design.root.sections[0].children[0].content.memberOnlyRedacted,
        true
      );
    }
  }
});

test('public page endpoint enforces tenant-scoped page lookup', async () => {
  const page = {
    id: 'page-b',
    tenant_id: 'tenant-b',
    slug: 'members',
    status: 'published',
    layout_type: 'public',
    builder_type: 'canvas',
    canvas_design: makeDesign(),
  };
  const handler = createPublicPageHandler({
    db: makeDb({ page }),
    resolveTenant: async () => ({ id: TENANT_ID }),
    resolveViewer: async () => guestViewer(),
  });
  const res = responseMock();
  await handler(request({ slug: 'members' }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.stringify(res.body).includes('member secret'), false);
});

test('symbol fallback endpoint projects guest symbols and preserves member/editor symbols', async () => {
  const page = {
    tenant_id: TENANT_ID,
    builder_type: 'canvas',
    status: 'published',
    layout_type: 'public',
    canvas_design: makeDesign(),
  };
  const symbols = [{
    id: 'symbol-1',
    tenant_id: TENANT_ID,
    design: { children: [customHtmlBlock()] },
  }];
  for (const [viewer, shouldExpose] of [
    [guestViewer(), false],
    [memberViewer(), true],
    [editorViewer(), true],
  ]) {
    const handler = createCanvasSymbolsHandler({
      db: makeDb({ page, symbols }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      resolveViewer: async () => viewer,
    });
    const res = responseMock();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.stringify(res.body).includes('member secret'), shouldExpose);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store, must-revalidate');
  }
});

test('tenant branding endpoint passes guest/member audience to canvas footer payload', async () => {
  const footer = {
    id: 'footer-1',
    design: { root: { sections: [{ children: [customHtmlBlock('<p>footer secret</p>')] }] } },
  };
  for (const [viewer, shouldExpose] of [[guestViewer(), false], [memberViewer(), true]]) {
    const handler = createTenantBrandingHandler({
      db: {},
      resolveTenant: async () => ({ id: TENANT_ID }),
      resolveViewer: async () => viewer,
      resolveBranding: async (_tenant, _microsite, options) => ({
        canvasFooter: options.allowMemberOnlyContent ? footer : {
          ...footer,
          design: projectCanvasDesignForGuest(footer.design),
        },
      }),
    });
    const res = responseMock();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.stringify(res.body).includes('footer secret'), shouldExpose);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store, must-revalidate');
  }
});

test('prerender and SEO/search helpers only expose guest-visible content', () => {
  const guestDesign = projectCanvasDesignForGuest(makeDesign());
  const prerendered = renderCanvasDesignBody(guestDesign);
  const prerenderedHtml = prerendered.sections.join('\n');
  assert.equal(prerenderedHtml.includes('member secret'), false);
  assert.match(prerenderedHtml, /Log in to continue/);

  const staleSecretPage = {
    id: 'page-1',
    title: 'Public title',
    slug: 'members',
    builder_type: 'canvas',
    canvas_design: makeDesign(),
    search_text: 'member secret do not expose',
  };
  assert.equal(buildPublicPageSearchResult(staleSecretPage, 'member secret'), null);
  const guestMessageResult = buildPublicPageSearchResult(staleSecretPage, 'log in to continue');
  assert.match(guestMessageResult?.description || '', /Log in to continue/);
});

test('auth failures and tenant mismatches fail closed before any projection is trusted', async () => {
  assert.equal(viewerFromTenantContext(null, TENANT_ID).allowMemberOnlyContent, false);
  assert.equal(viewerFromTenantContext({
    tenantId: 'tenant-b',
    isAuthenticated: true,
  }, TENANT_ID).allowMemberOnlyContent, false);
  assert.equal(viewerFromTenantContext({
    tenantId: TENANT_ID,
    isAuthenticated: false,
  }, TENANT_ID).allowMemberOnlyContent, false);

  const viewer = await resolveCanvasViewer({}, TENANT_ID, {
    resolveContext: async () => {
      throw new Error('session validation unavailable');
    },
  });
  assert.equal(viewer.allowMemberOnlyContent, false);
});

test('OAuth callback redirect sinks reject external returnTo values', () => {
  assert.equal(
    buildGoogleFinalRedirect({
      tenantSlug: 'tenant-a',
      returnTo: 'https://evil.example/phish',
      landingPage: '/preferences',
      isProduction: false,
    }),
    '/preferences'
  );
  assert.equal(
    buildGoogleFinalRedirect({
      tenantSlug: 'tenant-a',
      returnTo: '/safe?tab=one',
      landingPage: '/preferences',
      isProduction: true,
    }),
    'https://tenant-a.iconn.app/safe?tab=one'
  );
  assert.equal(
    buildOutlookSuccessRedirect({
      returnTo: '//evil.example/phish',
      isProduction: false,
      originHost: 'tenant-a.iconn.app',
    }),
    '/admin/settings?outlook_connected=true'
  );
});
