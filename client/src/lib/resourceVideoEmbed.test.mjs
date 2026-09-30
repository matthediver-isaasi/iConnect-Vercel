// Tests for the safe video-embed extraction used by resource views.
// Run: npx tsx --test client/src/lib/resourceVideoEmbed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoEmbedSrc, sanitizeVideoEmbedUrl } from './resourceVideoEmbed.mjs';

const YT_IFRAME = '<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/GK_vRtHJZu4" title="Why" frameborder="0" allowfullscreen></iframe>';

test('extracts the src from standard YouTube iframe embed code', () => {
  assert.equal(extractVideoEmbedSrc(YT_IFRAME), 'https://www.youtube-nocookie.com/embed/GK_vRtHJZu4');
  const plainYt = '<iframe src="https://www.youtube.com/embed/EtW2rrLHs08"></iframe>';
  assert.equal(extractVideoEmbedSrc(plainYt), 'https://www.youtube.com/embed/EtW2rrLHs08');
});

test('extracts Vimeo player embeds', () => {
  assert.equal(
    extractVideoEmbedSrc('<iframe src="https://player.vimeo.com/video/76979871"></iframe>'),
    'https://player.vimeo.com/video/76979871'
  );
});

test('rejects untrusted hosts, protocols and paths', () => {
  assert.equal(extractVideoEmbedSrc('<iframe src="https://evil.example.com/embed/x"></iframe>'), null);
  assert.equal(extractVideoEmbedSrc('<iframe src="http://www.youtube.com/embed/GK_vRtHJZu4"></iframe>'), null);
  assert.equal(extractVideoEmbedSrc('<iframe src="javascript:alert(1)"></iframe>'), null);
  assert.equal(extractVideoEmbedSrc('<iframe src="https://www.youtube.com/watch?v=GK_vRtHJZu4"></iframe>'), null);
  assert.equal(sanitizeVideoEmbedUrl('https://player.vimeo.com/video/abc'), null);
  assert.equal(extractVideoEmbedSrc('<script>alert(1)</script>'), null);
  assert.equal(extractVideoEmbedSrc(''), null);
  assert.equal(extractVideoEmbedSrc(null), null);
});

test('converts plain watch/share URLs to embed URLs', () => {
  assert.equal(extractVideoEmbedSrc('https://www.youtube.com/watch?v=GK_vRtHJZu4'), 'https://www.youtube-nocookie.com/embed/GK_vRtHJZu4');
  assert.equal(extractVideoEmbedSrc('https://youtu.be/GK_vRtHJZu4'), 'https://www.youtube-nocookie.com/embed/GK_vRtHJZu4');
  assert.equal(extractVideoEmbedSrc('https://www.youtube-nocookie.com/embed/GK_vRtHJZu4'), 'https://www.youtube-nocookie.com/embed/GK_vRtHJZu4');
  assert.equal(extractVideoEmbedSrc('https://example.com/some-page'), null);
});
