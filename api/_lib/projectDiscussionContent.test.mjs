import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDiscussionContent as normalize, safeDiscussionLink } from './projectDiscussionContent.js';
const id = '00000000-0000-0000-0000-000000000001';
const rich = (...content) => ({ version: 1, doc: { type: 'doc', content } });
const paragraph = (...content) => ({ type: 'paragraph', content });
const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
test('historical strings are literal, including HTML-like text and line breaks', () => {
  assert.deepEqual(normalize({ content: '<script>not HTML</script>\nsecond line' }), {
    content: '<script>not HTML</script>\nsecond line', richContent: null, attachmentIds: [], mentionIdentityIds: [],
  });
});
test('narrow formatting round-trips with readable headings, lists, quotes, mentions and emoji', () => {
  const value = normalize({ content: 'forged projection', mentionIdentityIds: [],
    richContent: rich(
      { type: 'heading', attrs: { level: 2, onclick: 'bad' }, content: [text('Heading')] },
      paragraph(text('Bold ', [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }]),
        { type: 'mention', attrs: { id, label: 'Board Member' } }, text(' 😊 ', [{ type: 'link', attrs: { href: 'https://example.invalid/a?x=1&y=2', onclick: 'bad' } }])),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('One'))] }] },
      { type: 'orderedList', attrs: { start: 2 }, content: [{ type: 'listItem', content: [paragraph(text('Two'))] }] },
      { type: 'blockquote', content: [paragraph(text('Quote'))] },
    ),
  });
  assert.equal(value.content, 'Heading\nBold @Board Member 😊 \nOne\nTwo\nQuote');
  assert.deepEqual(value.mentionIdentityIds, [id]);
  assert.ok(!JSON.stringify(value.richContent).includes('onclick'));
  assert.equal(normalize({ ...value, richContent: value.richContent }).content, value.content);
});
test('images require current attachment IDs; markup-only and unsafe structures fail explicitly', () => {
  const image = { type: 'commentImage', attrs: { attachmentId: id, src: 'https://external.invalid/tracker' } };
  assert.deepEqual(normalize({ richContent: rich(image), attachmentIds: [id] }).richContent.doc.content[0], {
    type: 'commentImage', attrs: { attachmentId: id },
  });
  for (const payload of [
    { richContent: rich(image) },
    { richContent: rich(paragraph()) },
    { richContent: rich(paragraph(text('\u200b'))) },
    { richContent: rich({ type: 'script', content: [text('bad')] }) },
    { richContent: rich({ type: 'codeBlock', content: [text('bad')] }) },
    { richContent: rich(paragraph(text('bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))) },
    { richContent: rich(paragraph(text('bad', [{ type: 'style', attrs: { style: 'position:fixed' } }]))) },
    { richContent: { version: 2, doc: { type: 'doc' } } },
    { content: 'x'.repeat(20001) },
  ]) assert.throws(() => normalize(payload));
});
test('URL validation rejects protocol tricks, controls, credentials and incomplete URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', '//example.invalid', 'https://', 'https://a:b@example.invalid', 'java\nscript:x', 'mailto:', 'https://evil.invalid/\u0000']) {
    assert.equal(safeDiscussionLink(url), false, url);
  }
  for (const url of ['https://example.invalid/a?x=1&y=2', 'http://example.invalid', 'mailto:person@example.invalid']) assert.equal(safeDiscussionLink(url), true);
});
