import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./event-click.js', import.meta.url), 'utf8');

test('public event click endpoint validates opaque browser input and resolves tenant server-side', () => {
  assert.match(source, /getTenantContext/);
  assert.match(source, /resolveTenantFromRequest/);
  assert.match(source, /isUuid\(eventId\)/);
  assert.match(source, /isUuid\(visitorId\)/);
  assert.match(source, /eventType.*simple.*complex/s);
  assert.match(source, /deriveEventClickVisitorHash/);
  assert.match(source, /record_event_card_click/);
});

test('public event click endpoint uses visibility checks and a bounded rate limit', () => {
  assert.match(source, /isEventCardClickVisible/);
  assert.match(source, /getCallerGroupMembershipIds/);
  assert.match(source, /consumeEventClickRateLimit/);
  assert.match(source, /trustedEventClickClientKey/);
  assert.match(source, /status\(429\)/);
  assert.match(source, /status\(404\)\.json\(\{ error: 'Event not found' \}\)/);
});

test('public event click endpoint rejects cross-origin requests without credentialed CORS', () => {
  assert.match(source, /isSameOriginRequest/);
  assert.match(source, /CROSS_ORIGIN_EVENT_CLICK/);
  assert.doesNotMatch(source, /Access-Control-Allow-Credentials/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin/);
});