import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MICROSOFT_SCOPES,
  evaluateMicrosoftScopes,
  normalizeMicrosoftScopes
} from './microsoftGraph.js';

test('Microsoft authorization requests existing mail/calendar and Teams delegated scopes', () => {
  assert.ok(MICROSOFT_SCOPES.includes('https://graph.microsoft.com/Mail.Read'));
  assert.ok(MICROSOFT_SCOPES.includes('https://graph.microsoft.com/Mail.Send'));
  assert.ok(MICROSOFT_SCOPES.includes('https://graph.microsoft.com/Calendars.ReadWrite'));
  assert.ok(MICROSOFT_SCOPES.includes('https://graph.microsoft.com/OnlineMeetings.ReadWrite'));
  assert.ok(MICROSOFT_SCOPES.includes('https://graph.microsoft.com/OnlineMeetingArtifact.Read.All'));
});

test('scope evaluation accepts URL and short-name token scope formats case-insensitively', () => {
  const scopes = [
    'Mail.Read',
    'mail.send',
    'User.Read',
    'Calendars.ReadWrite',
    'https://graph.microsoft.com/OnlineMeetings.ReadWrite',
    'OnlineMeetingArtifact.Read.All'
  ].join(' ');
  const result = evaluateMicrosoftScopes(scopes);
  assert.equal(result.mailCalendarReady, true);
  assert.equal(result.teamsReady, true);
  assert.equal(result.healthState, 'healthy');
  assert.deepEqual(result.missingScopes, []);
  assert.ok(normalizeMicrosoftScopes(scopes).has('onlinemeetings.readwrite'));
});

test('legacy mail/calendar grants stay usable while Teams requests admin consent', () => {
  const result = evaluateMicrosoftScopes(
    'Mail.Read Mail.Send User.Read Calendars.ReadWrite openid profile offline_access'
  );
  assert.equal(result.mailCalendarReady, true);
  assert.equal(result.teamsReady, false);
  assert.equal(result.healthState, 'admin_consent_required');
  assert.deepEqual(result.missingTeamsScopes, [
    'https://graph.microsoft.com/OnlineMeetings.ReadWrite',
    'https://graph.microsoft.com/OnlineMeetingArtifact.Read.All'
  ]);
});

test('missing a base Graph permission requires reconnect', () => {
  const result = evaluateMicrosoftScopes(
    'Mail.Read User.Read Calendars.ReadWrite OnlineMeetings.ReadWrite OnlineMeetingArtifact.Read.All'
  );
  assert.equal(result.mailCalendarReady, false);
  assert.equal(result.teamsReady, true);
  assert.equal(result.healthState, 'reconnect_required');
  assert.ok(result.missingScopes.includes('https://graph.microsoft.com/Mail.Send'));
});