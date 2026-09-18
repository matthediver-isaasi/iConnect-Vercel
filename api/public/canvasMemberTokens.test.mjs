import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCanvasDesignBody } from './prerender.js';
import { buildPublicPageSearchResult } from './search.js';
import { buildPageSearchText } from '../_lib/searchTextBuilder.js';

const token = '{{member.first_name}}';
const makePage = () => ({
  id: 'page',
  title: 'Public welcome',
  builder_type: 'canvas',
  search_text: `Welcome ${token} stale private name`,
  canvas_design: { root: { sections: [{ children: [
    { type: 'text', content: { html: `<h2>Welcome ${token}</h2>` } },
    { type: 'card', content: { body: `<p>Role {{member.job_title}}</p>` } },
    { type: 'columns', content: { items: [{ html: '<p>Organisation {{member.organization.name}}</p>' }] } },
    { type: 'accordion', content: { items: [{ q: 'Who?', a: `<p>Person ${token}</p>` }] } },
  ] }] } },
});

test('crawler HTML and extracted metadata prose always use neutral TipTap fields', () => {
  const page = makePage();
  const snapshot = JSON.stringify(page);
  const result = renderCanvasDesignBody(page.canvas_design);
  assert.match(result.sections.join(''), /Welcome/);
  assert.match(result.sections.join(''), /Role/);
  assert.match(result.sections.join(''), /Organisation/);
  assert.match(result.sections.join(''), /Person/);
  assert.doesNotMatch(JSON.stringify(result), /\{\{member\./);
  assert.equal(JSON.stringify(page), snapshot);
});

test('public search ignores stale personalized index text and supported tokens', () => {
  const page = makePage();
  assert.equal(buildPublicPageSearchResult(page, 'member.first_name'), null);
  assert.equal(buildPublicPageSearchResult(page, 'stale private name'), null);
  const result = buildPublicPageSearchResult(page, 'Organisation');
  assert.ok(result);
  assert.doesNotMatch(result.description, /\{\{member\./);
});

test('persisted public search index uses the same neutral projection', async () => {
  const page = makePage();
  const snapshot = JSON.stringify(page);
  const db = {
    from(table) {
      assert.equal(table, 'i_edit_page');
      return {
        select() { return this; },
        eq() { return this; },
        async single() { return { data: page, error: null }; },
      };
    },
  };
  const text = await buildPageSearchText(db, page.id);
  assert.match(text, /Welcome/);
  assert.doesNotMatch(text, /\{\{member\./);
  assert.equal(JSON.stringify(page), snapshot);
});

test('Custom HTML and plain headings are not a member-template surface', () => {
  const d = { root: { sections: [{ children: [
    { type: 'hero', content: { headline: token } },
    { type: 'custom-html', content: { html: `<p>${token}</p>` } },
  ] }] } };
  const rendered = renderCanvasDesignBody(d);
  assert.ok(rendered.sections.join('').includes(token));
});