import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BLOCK_TYPES, createBlock, createEmptyCanvasDesign, normalizeCanvasDesign,
  resolveEventCarouselImageFit,
} from '../../../lib/canvasDesign.js';

test('image fit accepts only supported modes and defaults safely to cover', () => {
  for (const mode of ['cover', 'contain', 'fill']) {
    assert.equal(resolveEventCarouselImageFit(mode), mode);
  }
  for (const value of [undefined, null, '', 'none', 'Cover', 'toString', {}, [], 1, true]) {
    assert.equal(resolveEventCarouselImageFit(value), 'cover');
  }
  assert.equal(createBlock(BLOCK_TYPES.EVENT_CAROUSEL).content.imageFit, 'cover');
});

test('save and reopen preserves fit and other content; legacy and invalid values normalize to cover', () => {
  for (const mode of ['cover', 'contain', 'fill', undefined, null, 'invalid']) {
    const block = createBlock(BLOCK_TYPES.EVENT_CAROUSEL, {
      content: { imageFit: mode, eventIds: ['wide', 'portrait'], imageSide: 'right', imageAspect: '21/9' },
    });
    const design = createEmptyCanvasDesign();
    design.root.sections[0].children.push(block);
    const reopened = normalizeCanvasDesign(JSON.parse(JSON.stringify(design)));
    const saved = reopened.root.sections[0].children[0];
    assert.equal(saved.content.imageFit, resolveEventCarouselImageFit(mode));
    assert.deepEqual(saved.content.eventIds, ['wide', 'portrait']);
    assert.equal(saved.content.imageSide, 'right');
    assert.equal(saved.content.imageAspect, '21/9');
    assert.deepEqual(saved.bp, block.bp);
    assert.deepEqual(normalizeCanvasDesign(JSON.parse(JSON.stringify(reopened))), reopened);
  }
});

test('editor and public use the same validated centered image rendering and inspector writes block content', () => {
  const source = fs.readFileSync(new URL('./dynamicBlocks.jsx', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function EventCarouselRender('), source.indexOf('function EventCarouselPickerRow('));
  assert.match(render, /objectFit: resolveEventCarouselImageFit\(c.imageFit\), objectPosition: 'center'/);
  assert.match(render, /relative bg-slate-100 overflow-hidden/);
  assert.match(source, /Editor: \(props\) => <EventCarouselRender \{\.\.\.props\} asEditor \/>,\s*Renderer: EventCarouselRender/);
  assert.match(source, /value=\{resolveEventCarouselImageFit\(c.imageFit\)\}\s*onChange=\{\(v\) => set\(\{ imageFit: v \}\)\}/);
  for (const label of ['Cover (crop to fill)', 'Contain (show whole image)', 'Fill (stretch)']) {
    assert.ok(source.includes(label));
  }
});