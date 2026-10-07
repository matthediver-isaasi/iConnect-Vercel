import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { crawlerRichText } from './crawlerRichText.js';
import { createPrerenderHandler, renderCanvasDesignBody } from '../public/prerender.js';
import { projectCanvasDesignForGuest } from '../../shared/canvasMemberOnly.js';

const content = `<h2>First section</h2><p>${'Full public text &amp; meaning. '.repeat(350)}</p>
<h3>More detail</h3><ul><li>A point</li></ul><blockquote><p>A quotation</p></blockquote>
<p><a href="/join?type=member&amp;from=article">Join us</a> <strong>Important</strong></p>
<h4>Final section</h4><p>ARTICLE-END-SENTINEL</p>`;

test('full semantic content survives without truncation or double escaping', () => {
  const clean = crawlerRichText(content);
  const doc = new JSDOM(clean).window.document;
  assert.match(doc.body.textContent, /ARTICLE-END-SENTINEL/);
  assert.ok(doc.body.textContent.length > 8000);
  assert.equal(doc.querySelector('h2').textContent, 'First section');
  assert.equal(doc.querySelector('h3').textContent, 'More detail');
  assert.equal(doc.querySelector('h4').textContent, 'Final section');
  assert.equal(doc.querySelector('a').getAttribute('href'), '/join?type=member&from=article');
  for (const tag of ['p', 'ul', 'li', 'blockquote', 'strong']) assert.ok(doc.querySelector(tag));
  assert.doesNotMatch(clean, /&amp;amp;/);
});

test('unsafe active HTML and URL schemes are removed while safe text/links remain', () => {
  const doc = new JSDOM(crawlerRichText(`<h1 onclick="alert(1)" style="color:red">Heading</h1>
  <script>secretScript()</script><style>body{display:none}</style><iframe src="https://bad.test">hidden</iframe>
  <form><input value="secret"></form><svg onload="alert(1)"><script>alert(1)</script></svg>
  <a href="javascript:alert(1)">unsafe</a><a href="data:text/html,x">data</a>
  <img src="data:image/svg+xml,x" onerror="alert(1)" alt="Picture">
  <a href="https://safe.test/path">Safe</a><a href="mailto:hello@example.invalid">Email</a>
  <h2>&lt;script&gt;literal&lt;/script&gt;</h2>`)).window.document;
  assert.equal(doc.querySelector('script,style,iframe,form,input,svg,[onclick],[onerror],[style]'), null);
  assert.equal(doc.querySelectorAll('a[href]').length, 2);
  assert.equal(doc.querySelector('img').getAttribute('src'), null);
  assert.equal(doc.querySelector('h2').textContent, '<script>literal</script>');
});

test('plain text paragraphs and line breaks remain readable and empty values stay empty', () => {
  assert.equal(crawlerRichText(null), '');
  assert.equal(crawlerRichText(''), '');
  assert.equal(crawlerRichText('Meaning &amp; &#169; &lt;script&gt;literal&lt;/script&gt;'),
    '<p>Meaning &amp; © &lt;script&gt;literal&lt;/script&gt;</p>');
  assert.equal(crawlerRichText('First & second\nNext line\n\nAnother paragraph'),
    '<p>First &amp; second<br>Next line</p><p>Another paragraph</p>');
});

const tenant = { id: 'tenant', name: 'Test Institute', domain: 'example.invalid', settings: { allow_search_indexing: true } };
function database(tables) {
  return { from(table) {
    let rows = tables[table] || [], single = false;
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { rows = rows.filter(r => r[k] === v); return q; },
      is(k, v) { rows = rows.filter(r => (r[k] ?? null) === v); return q; },
      not(k, op, v) { rows = rows.filter(r => (r[k] ?? null) !== v); return q; },
      in(k, vs) { rows = rows.filter(r => vs.includes(r[k])); return q; },
      like(k, v) { rows = rows.filter(r => String(r[k] || '').startsWith(v.replace(/%$/, ''))); return q; },
      ilike(k, v) { rows = rows.filter(r => String(r[k] || '').toLowerCase() === String(v).toLowerCase()); return q; },
      or() { rows = rows.filter(r => r.slug === 'article' || r.slug?.startsWith('article-by-')); return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; },
      then(resolve, reject) { return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject); },
    };
    return q;
  } };
}
async function render(path, tables, tenantOverride = tenant) {
  const handler = createPrerenderHandler({ database: database(tables), resolveTenant: async () => tenantOverride,
    renderShell: async () => '<html><body>Public shell</body></html>' });
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, send(html) { this.body = html; return this; },
    json(body) { this.body = JSON.stringify(body); return this; }, end() { return this; } };
  await handler({ method: 'GET', url: path, query: { path }, headers: { host: 'example.invalid' } }, res);
  return res;
}

for (const [name, path, table, fields] of [
  ['article', '/articles/guest/article', 'blog_post', { guest_writer_id: 'writer', status: 'published', content }],
  ['news', '/NewsView?slug=article', 'news_post', { status: 'published', content }],
  ['job', '/JobDetails?id=record', 'job_posting', { status: 'active', description: content }],
]) {
  test(`${name} real prerender handler emits title H1 and complete structured body`, async () => {
    const tables = { [table]: [{ id: 'record', tenant_id: tenant.id, slug: 'article', title: 'Page title', ...fields }] };
    const result = await render(path, tables);
    assert.equal(result.code, 200);
    const doc = new JSDOM(result.body).window.document;
    assert.equal(doc.querySelectorAll('h1').length, 1);
    assert.equal(doc.querySelector('main h1')?.textContent, 'Page title');
    assert.equal(doc.querySelector('header h1'), null);
    assert.ok(doc.querySelector('main h2'));
    assert.match(doc.querySelector('main').textContent, /ARTICLE-END-SENTINEL/);
    assert.ok(doc.querySelector('meta[name="description"]').content.length <= 163);
    for (const change of [{ status: 'draft' }, { tenant_id: 'other' }]) {
      const excluded = await render(path, { [table]: [{ ...tables[table][0], ...change }] });
      assert.ok(excluded.code < 500, `Unexpected failure: ${excluded.code}`);
      assert.doesNotMatch(excluded.body || '', /ARTICLE-END-SENTINEL/);
    }
  });
}

test('tenant indexing opt-out still excludes article content', async () => {
  const result = await render('/articles/guest/article', {}, { ...tenant, settings: { allow_search_indexing: false } });
  assert.equal(result.code, 404);
  assert.doesNotMatch(result.body || '', /ARTICLE-END-SENTINEL/);
});

test('Canvas text and HTML retain semantic markup while member-only HTML stays redacted', () => {
  const design = { root: { sections: [{ id: 'section', children: [
    { id: 'text', type: 'text', content: { html: '<h2>Canvas section</h2><p><a href="/public">Public link</a></p>' } },
    { id: 'html', type: 'custom-html', content: { html: '<h3>HTML section</h3><p>Public body</p>' } },
    { id: 'private', type: 'custom-html', content: { memberOnly: true, html: '<h2>PRIVATE-SENTINEL</h2>' } },
  ] }] } };
  const result = renderCanvasDesignBody(projectCanvasDesignForGuest(design));
  const html = result.sections.join('\n');
  assert.match(html, /<h2>Canvas section<\/h2>/);
  assert.match(html, /<h3>HTML section<\/h3>/);
  assert.match(html, /href="\/public"/);
  assert.doesNotMatch(html, /PRIVATE-SENTINEL/);
});
