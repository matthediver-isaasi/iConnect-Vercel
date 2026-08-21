import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.navigator ??= dom.window.navigator;
globalThis.React = React;

const { MemoryRouter } = await import('react-router-dom');
const { default: NewsCard } = await import('./NewsCard.jsx');
const { default: ArticleCard } = await import('../blog/ArticleCard.jsx');

const ARTICLE = {
  id: 'news-1',
  title: 'News card design parity',
  slug: 'news-card-design-parity',
  status: 'published',
  feature_image_url: 'https://cdn.example.com/news.jpg',
};

function inRouter(element) {
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, null, element),
  );
}

function renderSignedInCard(cardDesign) {
  return inRouter(
    React.createElement(NewsCard, {
      article: ARTICLE,
      showAuthor: false,
      cardDesign,
    }),
  );
}

function renderPublicCard(newsCardDesign) {
  return inRouter(
    React.createElement(ArticleCard, {
      article: ARTICLE,
      viewPageUrl: 'NewsView',
      showActions: false,
      newsCardDesign,
    }),
  );
}

test('signed-in and public News cards render the same explicit divider and CTA radius', () => {
  const design = {
    ctaRadius: 18,
    divider: { enabled: true, color: '#abcdef', weight: 6 },
  };

  for (const html of [renderSignedInCard(design), renderPublicCard(design)]) {
    assert.match(html, /height:6px/);
    assert.match(html, /background-color:#abcdef/);
    assert.match(html, /border-radius:18px/);
  }
});

test('signed-in and public News cards both honor an explicitly hidden divider', () => {
  const design = {
    ctaRadius: null,
    divider: { enabled: false, color: '#abcdef', weight: 6 },
  };

  for (const html of [renderSignedInCard(design), renderPublicCard(design)]) {
    assert.doesNotMatch(html, /background-color:#abcdef/);
    assert.doesNotMatch(html, /height:6px/);
    assert.doesNotMatch(html, /border-radius:0px/);
  }
});

test('ordinary ArticleCard rendering does not receive News-specific overrides', () => {
  const html = renderPublicCard(null);

  assert.match(html, /background-color:#5d0d77/);
  assert.doesNotMatch(html, /background-color:#abcdef/);
  assert.doesNotMatch(html, /border-radius:18px/);
});