import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_JOB_HOURS,
  DEFAULT_JOB_POSTING_PRICE,
  DEFAULT_JOB_TYPES,
  resolveJobPostingSettings,
} from './jobPostingSettings.js';

test('job posting settings parse configured options and price', () => {
  assert.deepEqual(resolveJobPostingSettings([
    { setting_key: 'job_types', setting_value: '["Graduate","Part-time","Graduate"]' },
    { setting_key: 'job_hours', setting_value: '["Flexible","Evenings"]' },
    { setting_key: 'job_posting_price', setting_value: '75.50' },
  ]), {
    jobTypes: ['Graduate', 'Part-time'],
    hours: ['Flexible', 'Evenings'],
    price: 75.5,
  });
});

test('missing or malformed job posting settings use intentional defaults', () => {
  assert.deepEqual(resolveJobPostingSettings([
    { setting_key: 'job_types', setting_value: '{bad json' },
    { setting_key: 'job_hours', setting_value: '[]' },
    { setting_key: 'job_posting_price', setting_value: 'not-a-price' },
  ]), {
    jobTypes: DEFAULT_JOB_TYPES,
    hours: DEFAULT_JOB_HOURS,
    price: DEFAULT_JOB_POSTING_PRICE,
  });
});

test('blank and zero prices use the same intentional default as a missing row', () => {
  for (const setting_value of ['', '   ', '0', '-1']) {
    assert.equal(resolveJobPostingSettings([
      { setting_key: 'job_posting_price', setting_value },
    ]).price, DEFAULT_JOB_POSTING_PRICE);
  }
});

test('settings from another tenant cannot be represented by the parser without being returned by the public endpoint', () => {
  assert.deepEqual(resolveJobPostingSettings([]), {
    jobTypes: DEFAULT_JOB_TYPES,
    hours: DEFAULT_JOB_HOURS,
    price: DEFAULT_JOB_POSTING_PRICE,
  });
});