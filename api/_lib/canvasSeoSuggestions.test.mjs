import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeoContext, validateSeoSuggestions, generateSeoSuggestions } from './canvasSeoSuggestions.js';

test('extracts authored content from both canvas layouts, bounds context and excludes configuration', () => {
  const context = buildSeoContext({
    title: 'Careers', slug: 'careers',
    design: { root: { sections: [{ children: [
      { content: { html: '<h1>Careers &amp; skills</h1><script>bad()</script>' }, config: { memberId: 'private' } },
      { content: { src: 'https://example.org/photo.jpg', text: 'x'.repeat(30000) } },
      { content: { src: 'javascript:alert(1)' } },
    ] }] } },
  });
  assert.match(context.copy, /^Careers & skills/);
  assert.doesNotMatch(context.copy, /private|bad\(\)/);
  assert.ok(context.copy.length <= 18002);
  assert.deepEqual(context.images, ['https://example.org/photo.jpg']);
});

const valid = { meta_title: 'Careers', meta_description: 'Explore careers.', seo_title: 'Careers for you', seo_description: 'Find careers information.', og_image_url: 'https://example.org/photo.jpg' };
test('requires all text suggestions and refuses invented image URLs', () => {
  assert.throws(() => validateSeoSuggestions('{}', { images: [] }), /incomplete/);
  assert.throws(() => validateSeoSuggestions({ ...valid, seo_title: '<br>' }, { images: [] }), /empty/);
  assert.equal(validateSeoSuggestions(valid, { images: [] }).og_image_url, '');
  assert.equal(validateSeoSuggestions(valid, { images: [valid.og_image_url] }).og_image_url, valid.og_image_url);
});

test('AI call uses JSON and untrusted-source instructions without changing supplied document', async () => {
  const context = buildSeoContext({ title: 'Careers', design: { content: { text: 'Explore careers' } } });
  let request;
  const client = { chat: { completions: { create: async value => {
    request = value;
    return { choices: [{ message: { content: JSON.stringify(valid) } }] };
  } } } };
  const result = await generateSeoSuggestions(client, context);
  assert.equal(request.response_format.type, 'json_object');
  assert.match(request.messages[0].content, /untrusted/);
  assert.equal(JSON.parse(request.messages[1].content).copy, 'Explore careers');
  assert.equal(result.meta_title, 'Careers');
});
