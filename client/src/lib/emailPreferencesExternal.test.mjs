import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  isCategoryPreferenceChecked,
  isGlobalPreferenceChecked,
  getEmailPreferenceControlState,
  getGlobalEmailPreferenceControlState,
} from './emailPreferenceControlState.js';

const source = await readFile(new URL('../pages/EmailPreferences.jsx', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../../../api/email-preferences/index.js', import.meta.url), 'utf8');

test('external global preference uses explicit opt-out actions', () => {
  assert.match(source, /action: "set_category_subscription"/);
  assert.match(source, /isSubscribed: !category\.isSubscribed/);
});

test('control states consistently describe subscribed, opted-out, and globally locked categories', () => {
  const subscribed = getEmailPreferenceControlState({
    optedOutAll: false,
    categoryIsSubscribed: true,
  });
  assert.equal(subscribed.checked, true);
  assert.equal(subscribed.disabled, false);
  assert.equal(subscribed.status, 'Subscribed');
  assert.match(subscribed.cardClassName, /green/);
  assert.match(subscribed.guidance, /Turn off to stop/);

  const optedOut = getEmailPreferenceControlState({
    optedOutAll: false,
    categoryIsSubscribed: false,
  });
  assert.equal(optedOut.checked, false);
  assert.equal(optedOut.disabled, false);
  assert.equal(optedOut.status, 'Opted out');
  assert.match(optedOut.cardClassName, /red/);
  assert.match(optedOut.guidance, /Turn on to subscribe again/);

  const locked = getEmailPreferenceControlState({
    optedOutAll: true,
    categoryIsSubscribed: true,
  });
  assert.equal(locked.checked, false);
  assert.equal(locked.disabled, true);
  assert.match(locked.guidance, /global opt-out/);
});

test('global control clearly communicates both switch positions', () => {
  const enabled = getGlobalEmailPreferenceControlState({ optedOutAll: false });
  assert.equal(enabled.checked, false);
  assert.match(enabled.cardClassName, /green/);
  assert.match(enabled.guidance, /Turn on to stop all/);

  const stopped = getGlobalEmailPreferenceControlState({ optedOutAll: true });
  assert.equal(stopped.checked, true);
  assert.match(stopped.cardClassName, /red/);
  assert.match(stopped.guidance, /categories you opted out of will stay stopped/);
});

test('page exposes accessible status text and labels for every preference control', () => {
  assert.match(source, /role="status"/);
  assert.match(source, /aria-label="Stop all marketing emails"/);
  assert.match(source, /aria-label=\{`\$\{category\.name\} emails`\}/);
  assert.match(source, /category controls are locked while all emails are stopped/);
});

test('API enforces the global lock for member and external category updates', () => {
  assert.match(apiSource, /set_email_preference_category_state/);
  assert.match(apiSource, /global email opt-out is active/);
  assert.match(apiSource, /Turn off the global email opt-out before changing individual categories/);
});

test('member global updates return categories from refreshed persisted preferences', () => {
  assert.match(apiSource, /const \{ data: refreshedPreferences, error: refreshedPreferencesError \}/);
  assert.match(apiSource, /isSubscribed: optOutAll \? false : preference\?\.is_subscribed === true/);
});

test('global preference propagation is one atomic server-only database call', () => {
  assert.match(apiSource, /supabase\.rpc\(\s*'set_email_preference_global_state'/);
  assert.match(apiSource, /if \(globalUpdateError\) throw globalUpdateError/);
});

test('campaign member writes use the current member email while external writes use the recipient email', () => {
  const identityUses = apiSource.match(/p_email: member\?\.email \|\| recipient\.email/g) || [];
  assert.equal(identityUses.length, 2);
});

test('external global control reflects persisted and newly completed opt-outs', () => {
  assert.equal(isGlobalPreferenceChecked({
    isMember: false,
    persistedOptedOutAll: false,
    externalOptOutCompleted: false,
  }), false);
  assert.equal(isGlobalPreferenceChecked({
    isMember: false,
    persistedOptedOutAll: true,
    externalOptOutCompleted: false,
  }), true);
  assert.equal(isGlobalPreferenceChecked({
    isMember: false,
    persistedOptedOutAll: false,
    externalOptOutCompleted: true,
  }), true);
});

test('external categories display subscribed, opted-out, and newly opted-out states correctly', () => {
  assert.equal(isCategoryPreferenceChecked({
    isMember: false,
    categoryIsSubscribed: true,
    optedOutAll: false,
    externalOptOutCompleted: false,
  }), true);
  assert.equal(isCategoryPreferenceChecked({
    isMember: false,
    categoryIsSubscribed: false,
    optedOutAll: false,
    externalOptOutCompleted: false,
  }), false);
  assert.equal(isCategoryPreferenceChecked({
    isMember: false,
    categoryIsSubscribed: true,
    optedOutAll: false,
    externalOptOutCompleted: true,
  }), false);
});

test('member category display behavior remains unchanged', () => {
  assert.equal(isCategoryPreferenceChecked({
    isMember: true,
    categoryIsSubscribed: true,
    optedOutAll: false,
    externalOptOutCompleted: false,
  }), true);
  assert.equal(isCategoryPreferenceChecked({
    isMember: true,
    categoryIsSubscribed: true,
    optedOutAll: true,
    externalOptOutCompleted: false,
  }), false);
});

test('loading preferences performs only a GET and external writes require interaction handlers', () => {
  const fetchPreferences = source.slice(
    source.indexOf('const fetchPreferences'),
    source.indexOf('const handleToggleAll')
  );
  assert.doesNotMatch(fetchPreferences, /method:\s*"POST"/);
  assert.doesNotMatch(fetchPreferences, /setExternalOptOuts/);
});