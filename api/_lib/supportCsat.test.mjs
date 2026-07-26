import test from 'node:test';
import assert from 'node:assert/strict';

import {
  signRatingToken,
  verifyRatingToken,
  buildRatingUrls,
  normalizeRatingScore,
  parseAutoCloseSettings,
  decideAutoCloseAction,
  AUTO_CLOSE_DEFAULTS,
} from './supportCsat.js';

const SECRET = 'test-secret';
const TICKET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = Date.parse('2026-07-26T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('rating token: sign + verify round-trip', () => {
  const exp = NOW + DAY;
  const sig = signRatingToken(TICKET, exp, SECRET);
  assert.ok(sig && /^[0-9a-f]{64}$/.test(sig));
  assert.equal(verifyRatingToken(TICKET, exp, sig, SECRET, NOW), true);
});

test('rating token: rejects wrong ticket, tampered sig, wrong secret, expiry', () => {
  const exp = NOW + DAY;
  const sig = signRatingToken(TICKET, exp, SECRET);
  assert.equal(verifyRatingToken('other-ticket', exp, sig, SECRET, NOW), false);
  assert.equal(verifyRatingToken(TICKET, exp, sig.slice(0, -1) + '0', SECRET, NOW), false);
  assert.equal(verifyRatingToken(TICKET, exp, sig, 'wrong', NOW), false);
  // expired
  assert.equal(verifyRatingToken(TICKET, exp, sig, SECRET, exp + 1), false);
  // exp mismatch with signature
  assert.equal(verifyRatingToken(TICKET, exp + 1, sig, SECRET, NOW), false);
});

test('rating token: missing secret returns null / false', () => {
  assert.equal(signRatingToken(TICKET, NOW + DAY, null), null);
  assert.equal(verifyRatingToken(TICKET, NOW + DAY, 'abc', null, NOW), false);
});

test('buildRatingUrls: builds 5 signed links sharing one token', () => {
  const urls = buildRatingUrls('https://example.org/', TICKET, { secret: SECRET, now: NOW, ttlMs: DAY });
  assert.ok(urls);
  assert.deepEqual(Object.keys(urls), ['1', '2', '3', '4', '5']);
  for (const [score, url] of Object.entries(urls)) {
    assert.ok(url.startsWith('https://example.org/api/support/rate?'));
    const u = new URL(url);
    assert.equal(u.searchParams.get('ticket'), TICKET);
    assert.equal(u.searchParams.get('score'), score);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig');
    assert.equal(verifyRatingToken(TICKET, exp, sig, SECRET, NOW), true);
  }
});

test('buildRatingUrls: null without base url or secret', () => {
  assert.equal(buildRatingUrls('', TICKET, { secret: SECRET }), null);
  assert.equal(buildRatingUrls('https://x.y', TICKET, { secret: null }), null);
});

test('normalizeRatingScore', () => {
  assert.equal(normalizeRatingScore('3'), 3);
  assert.equal(normalizeRatingScore(5), 5);
  assert.equal(normalizeRatingScore(0), null);
  assert.equal(normalizeRatingScore(6), null);
  assert.equal(normalizeRatingScore('2.5'), null);
  assert.equal(normalizeRatingScore('abc'), null);
  assert.equal(normalizeRatingScore(null), null);
});

test('parseAutoCloseSettings: defaults on missing/invalid', () => {
  assert.deepEqual(parseAutoCloseSettings(null), { ...AUTO_CLOSE_DEFAULTS });
  assert.deepEqual(parseAutoCloseSettings('not json'), { ...AUTO_CLOSE_DEFAULTS });
  assert.deepEqual(parseAutoCloseSettings('[1,2]'), { ...AUTO_CLOSE_DEFAULTS });
  assert.equal(AUTO_CLOSE_DEFAULTS.enabled, false);
});

test('parseAutoCloseSettings: parses, clamps, and keeps closeDays > warnDays', () => {
  assert.deepEqual(
    parseAutoCloseSettings(JSON.stringify({ enabled: true, warnDays: 3, closeDays: 5 })),
    { enabled: true, warnDays: 3, closeDays: 5 }
  );
  // enabled must be strictly true
  assert.equal(parseAutoCloseSettings(JSON.stringify({ enabled: 'yes' })).enabled, false);
  // invalid numbers fall back
  const fallback = parseAutoCloseSettings(JSON.stringify({ enabled: true, warnDays: -2, closeDays: 'x' }));
  assert.deepEqual(fallback, { enabled: true, warnDays: 7, closeDays: 10 });
  // closeDays <= warnDays is bumped
  const bumped = parseAutoCloseSettings(JSON.stringify({ enabled: true, warnDays: 10, closeDays: 5 }));
  assert.deepEqual(bumped, { enabled: true, warnDays: 10, closeDays: 11 });
});

const SETTINGS = { enabled: true, warnDays: 7, closeDays: 10 };
const resolvedTicket = (daysAgo, warned = false) => ({
  status: 'resolved',
  resolved_at: new Date(NOW - daysAgo * DAY).toISOString(),
  auto_close_warning_sent_at: warned ? new Date(NOW - DAY).toISOString() : null,
});

test('decideAutoCloseAction: disabled or non-resolved -> null', () => {
  assert.equal(decideAutoCloseAction(resolvedTicket(30), { ...SETTINGS, enabled: false }, NOW), null);
  assert.equal(decideAutoCloseAction({ ...resolvedTicket(30), status: 'open' }, SETTINGS, NOW), null);
  assert.equal(decideAutoCloseAction({ status: 'resolved', resolved_at: null }, SETTINGS, NOW), null);
  assert.equal(decideAutoCloseAction({ status: 'resolved', resolved_at: 'garbage' }, SETTINGS, NOW), null);
  assert.equal(decideAutoCloseAction(null, SETTINGS, NOW), null);
});

test('decideAutoCloseAction: warn at warn threshold, once', () => {
  assert.equal(decideAutoCloseAction(resolvedTicket(6.9), SETTINGS, NOW), null);
  assert.equal(decideAutoCloseAction(resolvedTicket(7), SETTINGS, NOW), 'warn');
  assert.equal(decideAutoCloseAction(resolvedTicket(9), SETTINGS, NOW), 'warn');
  // already warned but not yet past close threshold -> nothing
  assert.equal(decideAutoCloseAction(resolvedTicket(9, true), SETTINGS, NOW), null);
});

test('decideAutoCloseAction: close only after warning AND close threshold', () => {
  assert.equal(decideAutoCloseAction(resolvedTicket(10, true), SETTINGS, NOW), 'close');
  assert.equal(decideAutoCloseAction(resolvedTicket(30, true), SETTINGS, NOW), 'close');
  // past close threshold but never warned -> warn first (never skip the heads-up)
  assert.equal(decideAutoCloseAction(resolvedTicket(30, false), SETTINGS, NOW), 'warn');
});
