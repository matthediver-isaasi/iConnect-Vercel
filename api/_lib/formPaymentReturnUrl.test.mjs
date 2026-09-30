import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormPaymentReturnUrl, sanitizeFormPaymentReturnPath } from './formPaymentReturnUrl.js';
import { readFileSync } from 'node:fs';

const base = 'https://members.example.invalid';

test('payment return paths cannot escape the trusted tenant origin', () => {
  const invalid = [
    '//attacker.example/x', '/\\attacker.example/x', '\\\\attacker.example/x',
    '/\t/attacker.example', '/\n/attacker.example', '/%5cattacker.example',
    '/%0d%0a/attacker.example', 'https://attacker.example/x', 'javascript:alert(1)',
    ' /join', '/join\u0000', `/${'x'.repeat(8192)}`, null, {},
  ];
  for (const path of invalid) {
    assert.equal(sanitizeFormPaymentReturnPath(path, base), '/', String(path));
    const url = new URL(buildFormPaymentReturnUrl(base, path, [['form_payment_submission', 'submission-1']]));
    assert.equal(url.origin, base);
    assert.equal(url.pathname, '/');
    assert.equal(url.searchParams.get('form_payment_submission'), 'submission-1');
  }
});

test('all return outcomes preserve custom-domain and microsite query context', () => {
  const path = '/conference/join?category=member&embed_instance=block-1#application';
  for (const provider of ['stripe_monthly_card', 'gocardless_monthly_dd', 'gocardless']) {
    for (const cancelled of [false, true]) {
      const entries = [['form_payment_submission', 'submission-1'], ['form_payment_provider', provider]];
      if (cancelled) entries.push(['form_payment_cancelled', '1']);
      const url = new URL(buildFormPaymentReturnUrl(base, path, entries));
      assert.equal(url.origin, base);
      assert.equal(url.pathname, '/conference/join');
      assert.equal(url.searchParams.get('category'), 'member');
      assert.equal(url.searchParams.get('embed_instance'), 'block-1');
      assert.equal(url.searchParams.get('form_payment_cancelled'), cancelled ? '1' : null);
      assert.equal(url.hash, '');
    }
  }
});

test('payment URLs override duplicate outcome keys and require a usable trusted base', () => {
  const url = new URL(buildFormPaymentReturnUrl(base, '/join?form_payment_submission=old&form_payment_submission=older', [
    ['form_payment_submission', 'current'],
  ]));
  assert.deepEqual(url.searchParams.getAll('form_payment_submission'), ['current']);
  assert.throws(() => buildFormPaymentReturnUrl('javascript:alert(1)', '/join', []));
});

test('every hosted form provider builds returns through the same origin-checked helper', () => {
  const source = readFileSync(new URL('../public/form-payment.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ buildFormPaymentReturnUrl \}/);
  assert.equal((source.match(/buildFormPaymentReturnUrl\(/g) || []).length, 4);
  assert.doesNotMatch(source, /function sanitizeReturnPath|new URL\((?:safeReturnPath|returnPath),/);
});