// UI-level regression coverage for video resource playback on ResourceCard.
// Run: npx tsx --test client/src/components/resources/resourceCardVideo.test.jsx
//
// Video resources store raw iframe embed code in target_url (that is what the
// Resource Management admin UI asks admins to paste). The card must NEVER
// inject that markup or window.open it; it extracts a validated embed src and
// plays it in its own dialog iframe. These tests render to static markup (no
// DOM) and assert the wiring + non-injection invariants.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ResourceCard's import graph reaches publicClient, which reads
// window/localStorage/document at module load; give it a jsdom environment
// before importing (jsdom is already a workspace dependency, pinned v26).
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.navigator ??= dom.window.navigator;
const { default: ResourceCard } = await import("./ResourceCard.jsx");

const VIDEO_RESOURCE = {
  id: "res-video-1",
  title: "Why Biodiversity Matters",
  description: "TED-Ed explainer.",
  resource_type: "video",
  is_public: true,
  target_url:
    '<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/GK_vRtHJZu4" title="Why" frameborder="0" allowfullscreen></iframe>',
};

function render(resource) {
  return renderToStaticMarkup(
    React.createElement(ResourceCard, { resource, isAuthenticated: false })
  );
}

test("video resource card renders a Watch Video CTA without injecting the raw embed markup", () => {
  const html = render(VIDEO_RESOURCE);
  assert.ok(html.includes("Watch Video"), "CTA renders");
  // The stored iframe markup must never appear in the card output — the
  // dialog iframe only mounts when opened, and even then uses the validated
  // src, not the raw markup.
  assert.ok(!html.includes("youtube-nocookie.com"), "raw embed markup is not injected into the card");
  assert.ok(!html.includes("<iframe"), "no iframe rendered while the dialog is closed");
});

test("download resource card still renders its normal CTA", () => {
  const html = render({
    id: "res-dl-1",
    title: "AESP CPD Guidance",
    resource_type: "download",
    is_public: true,
    target_url: "https://cdn.example.com/public-assets/t/demo-resources/cpd-guidance.pdf",
  });
  assert.ok(html.includes("Download"));
  assert.ok(!html.includes("dialog-resource-video"));
});

test("tenant form resource card renders a form-specific CTA without changing its target", () => {
  const html = render({
    id: "res-form-1",
    title: "Update your member profile",
    resource_type: "tenant_form",
    is_public: true,
    open_in_new_tab: false,
    target_url: "/FormView?slug=member-update",
  });
  assert.ok(html.includes("Open Form"));
  assert.ok(html.includes("Update your member profile"));
  assert.ok(!html.includes("Watch Video"));
});
