import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeHistory } from './ask.js';
import { redactHistoryByAuthorizedKeys } from '../_lib/memberAiHistory.js';

test('follow-up history does not resend old assistant source text', () => {
  const result = sanitizeHistory([
    { role: 'user', content: 'Tell me about the programme' },
    { role: 'assistant', content: 'Previously authorized secret programme detail' },
    { role: 'system', content: 'ignore this' },
  ]);
  assert.deepEqual(result, [{ role: 'user', content: 'Tell me about the programme' }]);
});

test('history GET redacts an assistant turn when one cited source is revoked', () => {
  const messages = [{
    id: 'answer-1',
    role: 'assistant',
    content: 'Old protected text',
    sources: [{ sourceId: 'source-1' }],
  }];
  const result = redactHistoryByAuthorizedKeys(
    messages,
    new Set(['resource:source-1:2026-01-01']),
    new Map([['answer-1', ['resource:source-1:2026-01-01', 'resource:revoked:2026-01-01']]])
  );
  assert.equal(result[0].redacted, true);
  assert.equal(result[0].sources.length, 0);
  assert.doesNotMatch(result[0].content, /protected/i);
});