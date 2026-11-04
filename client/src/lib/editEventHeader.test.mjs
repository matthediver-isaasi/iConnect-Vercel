import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../pages/EditEvent.jsx', import.meta.url), 'utf8');
const heading = source.match(/<h1[^>]*data-testid="event-editor-title"[^>]*>[\s\S]*?<\/h1>/)?.[0];
assert(heading, 'The edit page must have an identifiable event heading');
const compiled = transformSync(`(${heading})`, { loader: 'jsx' }).code;
const renderHeading = new Function('React', 'event', `return ${compiled}`);

test('event header identifies the saved event, including long names', () => {
  for (const title of ['Annual conference', 'A very long event title '.repeat(25)]) {
    const html = renderToStaticMarkup(renderHeading(React, { title }));
    assert(html.includes(title.trim()));
    assert(html.includes('overflow-wrap:anywhere'));
    assert(!html.includes('truncate'));
  }
});

test('event heading safely renders names and handles missing titles', () => {
  assert(renderToStaticMarkup(renderHeading(React, { title: '<script>test</script>' })).includes('&lt;script&gt;'));
  for (const title of [null, undefined, '', '   ']) {
    assert(renderToStaticMarkup(renderHeading(React, { title })).includes('Untitled event'));
  }
});

test('the complete edit page remains valid JSX', () => {
  assert.doesNotThrow(() => transformSync(source, { loader: 'jsx' }));
});
