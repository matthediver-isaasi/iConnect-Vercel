import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import {
  CANVAS_MEMBER_TOKENS,
  resolveCanvasMemberHtml,
  removeCanvasMemberTokens,
  projectCanvasMemberTokensForGuest,
} from './canvasMemberTokens.js';

const token = '{{member.first_name}}';
const values = {
  'member.first_name': 'Ada',
  'member.last_name': 'Lovelace',
  'member.job_title': 'Writer',
  'member.organization.name': 'Analytical Society',
};
const design = (children) => ({ root: { sections: [{ children }] } });

test('the contract exposes exactly four immutable literal tokens', () => {
  assert.deepEqual(CANVAS_MEMBER_TOKENS.map(({ key }) => key), Object.keys(values));
  for (const option of CANVAS_MEMBER_TOKENS) {
    assert.equal(option.token, `{{${option.key}}}`);
    assert.ok(option.label);
    assert.ok(Object.isFrozen(option));
  }
  assert.ok(Object.isFrozen(CANVAS_MEMBER_TOKENS));
});

test('rich text retains markup and formatting and resolves repeated tokens', () => {
  const input = `<h2 style='color:red'>Welcome <strong>${token}</strong></h2><p>${token} {{member.last_name}}, {{member.job_title}} at {{member.organization.name}}</p>`;
  assert.equal(resolveCanvasMemberHtml(input, values),
    "<h2 style='color:red'>Welcome <strong>Ada</strong></h2><p>Ada Lovelace, Writer at Analytical Society</p>");
});

test('guest, missing and invalid fields become empty without changing unknown syntax', () => {
  const input = `<p>${token} {{member.last_name}} {{member.email}} {{other}} {{ member.first_name }}</p>`;
  assert.equal(resolveCanvasMemberHtml(input), '<p>  {{member.email}} {{other}} {{ member.first_name }}</p>');
  assert.equal(resolveCanvasMemberHtml(token, { 'member.first_name': 123 }), '');
  assert.equal(resolveCanvasMemberHtml(token, Object.create(values)), '');
  assert.equal(resolveCanvasMemberHtml(token, null), '');
  assert.equal(resolveCanvasMemberHtml(null), '');
  assert.equal(resolveCanvasMemberHtml(token, { 'member.first_name': '' }), '');
});

test('URLs, attributes, comments and raw-text/hidden containers are not evaluated', () => {
  const input = `<a href="/${token}" title='${token}' data-token="${token}">${token}</a><!-- ${token} --><script>${token}</script><style>${token}</style><textarea>${token}</textarea><template><p>${token}</p></template><iframe>${token}</iframe>`;
  assert.equal(resolveCanvasMemberHtml(input, values), input.replace(`>${token}</a>`, '>Ada</a>'));
  assert.equal(resolveCanvasMemberHtml(`<img alt="${token}">`, values), `<img alt="${token}">`);
});

test('member strings can never create markup or recursively evaluate tokens', () => {
  const malicious = `<img src=x onerror="alert(1)"> & ' " {{member.last_name}} </p><script>alert(1)</script>`;
  const output = resolveCanvasMemberHtml(`<p>${token}</p>`, { ...values, 'member.first_name': malicious });
  const tree = parseFragment(output);
  assert.equal(tree.childNodes.length, 1);
  assert.equal(tree.childNodes[0].tagName, 'p');
  assert.equal(tree.childNodes[0].childNodes.length, 1);
  assert.equal(tree.childNodes[0].childNodes[0].nodeName, '#text');
  assert.equal(tree.childNodes[0].childNodes[0].value, malicious);
  assert.ok(!output.includes('<img'));
  assert.ok(!output.includes('Lovelace'));
});

test('token-free and unknown-token HTML is byte-identical', () => {
  for (const input of ['', '<P class=test>A &amp; B&nbsp; C</P>', '<p>{{member.email}}</p>', '<p>{{hello}}</p>']) {
    assert.equal(resolveCanvasMemberHtml(input, values), input);
  }
});

test('entities adjacent to tokens retain their text meaning and formatting boundaries are respected', () => {
  const input = `<p>&lt;span&gt; &amp; ${token}&nbsp;</p>`;
  const output = resolveCanvasMemberHtml(input, values);
  assert.equal(parseFragment(output).childNodes[0].childNodes[0].value, '<span> & Ada\u00a0');
  const split = '<p>{{member.<strong>first_name</strong>}}</p>';
  assert.equal(resolveCanvasMemberHtml(split, values), split);
});

test('plain removal is allowlisted and nonrecursive', () => {
  assert.equal(removeCanvasMemberTokens(`Hello ${token} {{member.organization.name}} {{member.email}}`),
    'Hello   {{member.email}}');
  assert.equal(removeCanvasMemberTokens(null), '');
});

test('guest projection covers all TipTap fields including nested nodes without mutating designs', () => {
  const input = design([
    { type: 'text', content: { html: `<p>Hello ${token}</p>`, heading: token } },
    { type: 'card', content: { body: token, heading: token, ctaHref: token } },
    { type: 'columns', content: { items: [{ html: token, title: token }] } },
    { type: 'accordion', content: { items: [{ q: token, a: token }] } },
    { type: 'card-flip-grid', content: { cards: [
      { summary: `<p>${token}</p>`, backText: `<p>${token}</p>`, content: token, title: token },
      { summary: token, backText: token },
    ] } },
    ...['hero-carousel', 'hero-carousel-mobile'].map((type) => ({
      type, content: { slides: [{ headerText: token, subheadingText: token, contentText: token, title: token }] },
    })),
    { type: 'section', children: [{ type: 'text', content: { html: token } }] },
    { type: 'advanced-accordion', content: { items: [{ children: [{ type: 'text', content: { html: token } }] }] } },
    { type: 'custom-html', content: { html: `<p>${token}</p>` } },
    { type: 'button', content: { label: token, href: token } },
  ]);
  const saved = JSON.stringify(input);
  const projected = projectCanvasMemberTokensForGuest(input);
  assert.equal(JSON.stringify(input), saved);
  const blocks = projected.root.sections[0].children;
  assert.equal(blocks[0].content.html, '<p>Hello </p>');
  assert.equal(blocks[0].content.heading, token);
  assert.equal(blocks[1].content.body, '');
  assert.equal(blocks[1].content.ctaHref, token);
  assert.deepEqual(blocks[2].content.items, [{ html: '', title: token }]);
  assert.deepEqual(blocks[3].content.items, [{ q: token, a: '' }]);
  assert.deepEqual(blocks[4].content.cards, [
    { summary: '<p></p>', backText: '<p></p>', content: '', title: token },
    { summary: token, backText: token },
  ]);
  for (const index of [5, 6]) {
    assert.deepEqual(blocks[index].content.slides, [{ headerText: '', subheadingText: '', contentText: '', title: token }]);
  }
  assert.equal(blocks[7].children[0].content.html, '');
  assert.equal(blocks[8].content.items[0].children[0].content.html, '');
  assert.equal(blocks[9], input.root.sections[0].children[9]);
  assert.equal(blocks[10], input.root.sections[0].children[10]);
  assert.equal(projectCanvasMemberTokensForGuest(projected), projected);
});