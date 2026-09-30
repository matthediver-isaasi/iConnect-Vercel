import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTbcBannerConfig,
  getTbcBannerPlacement,
  getTbcBannerStyle,
  getTbcBannerTitle,
  DEFAULT_TBC_BANNER_TITLE,
} from './tbcEventsBanner.js';

const enabledSetting = (extra = {}) => [{
  setting_key: 'tbc_events_banner',
  setting_value: JSON.stringify({ enabled: true, mode: 'solid', color: '#ff0000', ...extra }),
}];

test('parseTbcBannerConfig returns config only when enabled', () => {
  const cfg = parseTbcBannerConfig(enabledSetting());
  assert.equal(cfg.color, '#ff0000');

  assert.equal(parseTbcBannerConfig([{
    setting_key: 'tbc_events_banner',
    setting_value: JSON.stringify({ enabled: false, mode: 'solid' }),
  }]), null);
});

test('parseTbcBannerConfig handles missing/malformed settings', () => {
  assert.equal(parseTbcBannerConfig([]), null);
  assert.equal(parseTbcBannerConfig(null), null);
  assert.equal(parseTbcBannerConfig([{ setting_key: 'tbc_events_banner', setting_value: 'not-json' }]), null);
  assert.equal(parseTbcBannerConfig([{ setting_key: 'other', setting_value: '{}' }]), null);
});

test('getTbcBannerStyle solid vs gradient with fallbacks', () => {
  assert.deepEqual(getTbcBannerStyle({ mode: 'solid', color: '#123456' }), { background: '#123456' });
  assert.deepEqual(getTbcBannerStyle({ mode: 'solid' }), { background: '#eff6ff' });
  assert.deepEqual(
    getTbcBannerStyle({ mode: 'gradient', from: '#aaa', to: '#bbb' }),
    { background: 'linear-gradient(to right, #aaa, #bbb)' }
  );
  assert.equal(getTbcBannerStyle(null), undefined);
});

test('getTbcBannerTitle falls back to default', () => {
  assert.equal(getTbcBannerTitle({ title: ' Custom ' }), 'Custom');
  assert.equal(getTbcBannerTitle({ title: '   ' }), DEFAULT_TBC_BANNER_TITLE);
  assert.equal(getTbcBannerTitle(null), DEFAULT_TBC_BANNER_TITLE);
});

const cfg = { enabled: true };
const pub = (id) => ({ id, status: 'published' });
const tbc = (id) => ({ id, status: 'tbc' });

test('placement: no config -> hidden even with TBC events', () => {
  assert.deepEqual(
    getTbcBannerPlacement(null, [tbc(1)], [tbc(2)]),
    { show: false, section: null, index: -1 }
  );
});

test('placement: no TBC events -> hidden', () => {
  assert.deepEqual(
    getTbcBannerPlacement(cfg, [pub(1)], [pub(2), pub(3)]),
    { show: false, section: null, index: -1 }
  );
});

test('placement: first TBC in non-featured grid', () => {
  assert.deepEqual(
    getTbcBannerPlacement(cfg, [pub(1)], [pub(2), tbc(3), tbc(4)]),
    { show: true, section: 'nonFeatured', index: 1 }
  );
});

test('placement: featured TBC wins (renders first on the page)', () => {
  assert.deepEqual(
    getTbcBannerPlacement(cfg, [pub(1), tbc(2)], [tbc(3)]),
    { show: true, section: 'featured', index: 1 }
  );
});

test('placement: only featured TBC, none in non-featured', () => {
  assert.deepEqual(
    getTbcBannerPlacement(cfg, [tbc(1)], [pub(2)]),
    { show: true, section: 'featured', index: 0 }
  );
});
