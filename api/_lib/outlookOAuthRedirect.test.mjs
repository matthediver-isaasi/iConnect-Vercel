import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOutlookOAuthRedirectUri,
  isValidOutlookOAuthRedirectUri,
} from './outlookOAuthRedirect.js';

test('keeps the canonical production callback independent of request headers', () => {
  assert.equal(
    getOutlookOAuthRedirectUri({
      isProduction: true,
      host: 'hostile.example',
      forwardedProto: 'http',
    }),
    'https://iconn.app/api/auth/outlook/callback',
  );
});

test('constructs validated local and Replit development callbacks', () => {
  assert.equal(
    getOutlookOAuthRedirectUri({ isProduction: false, host: '127.0.0.1:5000' }),
    'http://127.0.0.1:5000/api/auth/outlook/callback',
  );
  assert.equal(
    getOutlookOAuthRedirectUri({
      isProduction: false,
      host: 'project.replit.dev',
    }),
    'https://project.replit.dev/api/auth/outlook/callback',
  );
});

test('rejects unapproved hosts, paths, query strings and production alternatives', () => {
  assert.throws(() => getOutlookOAuthRedirectUri({
    isProduction: false,
    host: 'evil.example',
  }));
  assert.equal(isValidOutlookOAuthRedirectUri(
    'https://evil.example/api/auth/outlook/callback',
    { isProduction: false },
  ), false);
  assert.equal(isValidOutlookOAuthRedirectUri(
    'http://localhost:5000/api/auth/outlook/callback?next=evil',
    { isProduction: false },
  ), false);
  assert.equal(isValidOutlookOAuthRedirectUri(
    'https://tenant.iconn.app/api/auth/outlook/callback',
    { isProduction: true },
  ), false);
});