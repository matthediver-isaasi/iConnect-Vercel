import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MEMBER_ONLY_GUEST_MESSAGE,
  MAX_MEMBER_ONLY_GUEST_MESSAGE_LENGTH,
  getValidatedReturnTo,
  normalizeMemberOnlyContent,
  normalizeMemberOnlyGuestMessage,
  toMemberOnlyPlainText,
} from './memberOnlyHtml.js';
import { resolvePublicHeaderLink } from './publicHeaderLogin.js';

test('normalizes Custom HTML member-only defaults and booleans', () => {
  const normalized = normalizeMemberOnlyContent({
    html: '<p>Private</p>',
    memberOnly: 1,
    guestMessage: '',
  });
  assert.equal(normalized.memberOnly, false);
  assert.equal(normalized.guestMessage, DEFAULT_MEMBER_ONLY_GUEST_MESSAGE);
  assert.equal(normalized.html, '<p>Private</p>');
});

test('bounds and strips markup from guest copy', () => {
  const raw = `<strong>Log in</strong>\n${'x'.repeat(MAX_MEMBER_ONLY_GUEST_MESSAGE_LENGTH + 50)}`;
  const plain = toMemberOnlyPlainText(raw);
  assert.equal(plain.startsWith('Log in'), true);
  assert.equal(plain.includes('<strong>'), false);
  assert.equal(plain.length, MAX_MEMBER_ONLY_GUEST_MESSAGE_LENGTH);
  assert.equal(normalizeMemberOnlyGuestMessage('<b></b>'), DEFAULT_MEMBER_ONLY_GUEST_MESSAGE);
  assert.equal(normalizeMemberOnlyGuestMessage('&#60;b&#62;Safe&#60;/b&#62;'), '<b>Safe</b>');
});

test('returnTo preserves internal path, query and hash but rejects redirects', () => {
  assert.equal(
    getValidatedReturnTo({ pathname: '/microsite/page', search: '?tab=one', hash: '#details' }),
    '/microsite/page?tab=one#details',
  );
  assert.equal(getValidatedReturnTo({ pathname: '//evil.example/' }), '/');
  assert.equal(getValidatedReturnTo({ pathname: '/\\evil.example/' }), '/');
  assert.equal(getValidatedReturnTo({ pathname: 'https://evil.example/' }), '/');
});

test('shared login style resolver keeps configured button branding', () => {
  const resolved = resolvePublicHeaderLink({
    asButton: true,
    label: 'Sign in',
    labelColor: '#fff',
    backgroundMode: 'gradient',
    gradientStops: [
      { color: '#111', position: 0 },
      { color: '#222', position: 100 },
    ],
    cornerRadius: 8,
  }, 'Login', '#123');
  assert.equal(resolved.label, 'Sign in');
  assert.equal(resolved.labelColor, '#fff');
  assert.equal(resolved.buttonStyle.background, 'linear-gradient(to right, #111 0%, #222 100%)');
  assert.equal(resolved.buttonStyle.borderRadius, '8px');
});
