import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateExternalHttpUrl,
  validatePortalMenuRecord,
} from '../../shared/portalMenuLinks.js';

test('shared HTTP URL parsing rejects malformed authorities and ports', () => {
  for (const url of [
    'http://example.com:abc',
    'http://example.com:99999',
    'https://',
    'https://exa mple.com',
    'javascript:alert(1)',
  ]) {
    const result = validateExternalHttpUrl(url);
    assert.equal(result.isValid, false, `${url} should be rejected`);
    assert.ok(result.error);
  }
});

test('shared portal-menu validation normalizes valid links and current-tab defaults', () => {
  assert.deepEqual(validatePortalMenuRecord({
    link_type: 'external',
    url: ' https://example.com/resources ',
  }), {
    isValid: true,
    error: '',
    linkType: 'external',
    openInNewTab: false,
    url: 'https://example.com/resources',
  });

  const internal = validatePortalMenuRecord({ url: 'Events', open_in_new_tab: true });
  assert.equal(internal.isValid, true);
  assert.equal(internal.linkType, 'internal');
  assert.equal(internal.openInNewTab, false);
});

test('generic create and update endpoints enforce shared portal-menu validation', () => {
  const createSource = readFileSync('api/entities/[entity]/index.js', 'utf8');
  const updateSource = readFileSync('api/entities/[entity]/[id].js', 'utf8');

  for (const source of [createSource, updateSource]) {
    assert.match(source, /validatePortalMenuRecord/);
    assert.match(source, /entityNorm(?:alized)? === 'portalmenu'/);
    assert.match(source, /status\(400\).*portalMenuValidation\.error/s);
  }
});