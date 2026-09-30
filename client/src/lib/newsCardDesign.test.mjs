import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_NEWS_CARD_DIVIDER_WEIGHT,
  resolveNewsCardDesign,
} from './newsCardDesign.js';

const branding = {
  brandingConfig: {
    cardAccentBar: { enabled: true, color: '#123456' },
  },
};

test('News card design inherits the existing global card accent and Primary button radius', () => {
  assert.deepEqual(resolveNewsCardDesign([], branding), {
    ctaRadius: null,
    divider: {
      enabled: true,
      color: '#123456',
      weight: DEFAULT_NEWS_CARD_DIVIDER_WEIGHT,
    },
  });
});

test('News card design applies valid explicit CTA and divider overrides', () => {
  const settings = [
    { setting_key: 'news_card_cta_radius', setting_value: '18' },
    { setting_key: 'news_card_image_divider_mode', setting_value: 'show' },
    { setting_key: 'news_card_image_divider_weight', setting_value: '6' },
    { setting_key: 'news_card_image_divider_color', setting_value: '#abcdef' },
  ];

  assert.deepEqual(resolveNewsCardDesign(settings, branding), {
    ctaRadius: 18,
    divider: { enabled: true, color: '#abcdef', weight: 6 },
  });
});

test('News card divider can explicitly hide and invalid values safely fall back', () => {
  const hidden = resolveNewsCardDesign([
    { setting_key: 'news_card_image_divider_mode', setting_value: 'hide' },
  ], branding);
  assert.equal(hidden.divider.enabled, false);

  const malformed = resolveNewsCardDesign([
    { setting_key: 'news_card_cta_radius', setting_value: '500' },
    { setting_key: 'news_card_image_divider_mode', setting_value: 'unexpected' },
    { setting_key: 'news_card_image_divider_weight', setting_value: '0' },
    { setting_key: 'news_card_image_divider_color', setting_value: 'not-a-colour' },
  ], branding);
  assert.equal(malformed.ctaRadius, null);
  assert.deepEqual(malformed.divider, {
    enabled: true,
    color: '#123456',
    weight: DEFAULT_NEWS_CARD_DIVIDER_WEIGHT,
  });
});

test('News-specific settings never alter the inherited divider contract for other card types', () => {
  const design = resolveNewsCardDesign([
    { setting_key: 'news_card_image_divider_mode', setting_value: 'show' },
    { setting_key: 'news_card_image_divider_color', setting_value: '#ff0000' },
  ], branding);

  assert.equal(design.divider.color, '#ff0000');
  assert.deepEqual(branding.brandingConfig.cardAccentBar, { enabled: true, color: '#123456' });
});

test('authenticated and public setting arrays resolve to the same News card design', () => {
  const rows = [
    { setting_key: 'news_card_cta_radius', setting_value: '12' },
    { setting_key: 'news_card_image_divider_mode', setting_value: 'show' },
    { setting_key: 'news_card_image_divider_weight', setting_value: '4' },
    { setting_key: 'news_card_image_divider_color', setting_value: '#654321' },
  ];

  assert.deepEqual(
    resolveNewsCardDesign(structuredClone(rows), branding),
    resolveNewsCardDesign(structuredClone(rows), branding),
  );
});

test('public settings endpoint exposes every News design key through its tenant-scoped whitelist', () => {
  const source = readFileSync(
    new URL('../../../api/public/system-settings.js', import.meta.url),
    'utf8',
  );

  for (const key of [
    'news_card_cta_radius',
    'news_card_image_divider_mode',
    'news_card_image_divider_weight',
    'news_card_image_divider_color',
  ]) {
    assert.match(source, new RegExp(`'${key}'`));
  }
  assert.match(source, /\.eq\('tenant_id', tenant\.id\)/);
  assert.match(source, /PUBLIC_SETTINGS_WHITELIST\.includes\(key\)/);
});

test('resource and Canvas card surfaces do not consume News card design settings', () => {
  const resourceCard = readFileSync(
    new URL('../components/resources/ResourceCard.jsx', import.meta.url),
    'utf8',
  );
  const canvasCards = readFileSync(
    new URL('../components/canvas/blocks/dynamicBlocks.jsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(resourceCard, /newsCardDesign|news_card_image_divider|news_card_cta_radius/);
  assert.doesNotMatch(canvasCards, /newsCardDesign|news_card_image_divider|news_card_cta_radius/);
});