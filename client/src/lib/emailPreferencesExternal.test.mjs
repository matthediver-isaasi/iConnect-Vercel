import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  isCategoryPreferenceChecked,
  isGlobalPreferenceChecked,
} from './emailPreferenceControlState.js';

const source = await readFile(new URL('../pages/EmailPreferences.jsx', import.meta.url), 'utf8');

test('external global preference uses explicit opt-out actions', () => {
  assert.match(source, /useState\(\{ all: false, categories: \{\} \}\)/);
  assert.match(source, /isExternal \? "opt_out_category" : "toggle_category"/);
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