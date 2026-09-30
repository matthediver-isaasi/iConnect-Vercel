import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ShowcaseCard from "./ShowcaseCard.jsx";

function renderCard(props = {}) {
  return renderToStaticMarkup(
    React.createElement(ShowcaseCard, {
      asEditor: true,
      title: "A news story",
      imageUrl: "https://cdn.example.com/news.jpg",
      imageFocalPoint: { x: 73, y: 28 },
      summary: "A summary that remains available below the responsive image.",
      showPublishedDate: true,
      publishedDate: "2026-08-19T00:00:00.000Z",
      ...props,
    }),
  );
}

test("ratio mode makes the image responsive and lets the card grow beyond its minimum height", () => {
  const html = renderCard({
    cardHeight: 400,
    imageAspectRatio: "1200 / 630",
  });

  assert.match(html, /aspect-ratio:1200 \/ 630/);
  assert.match(html, /min-height:400px/);
  assert.match(html, /height:auto/);
  assert.match(html, /flex:1 1 auto/);
  assert.match(html, /object-position:73% 28%/);
  assert.match(html, /A summary that remains available below the responsive image/);
});

test("legacy mode keeps the percentage image height and fixed card height", () => {
  const html = renderCard({
    cardHeight: 400,
    imageHeightPercent: 50,
  });

  assert.match(html, /height:200px/);
  assert.match(html, /height:400px/);
  assert.doesNotMatch(html, /aspect-ratio:/);
  assert.doesNotMatch(html, /min-height:400px/);
});