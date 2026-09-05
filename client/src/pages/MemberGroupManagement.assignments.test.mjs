import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

test('member group cards load every assignment through the paginated entity path', () => {
  const source = readFileSync(path.join(here, 'MemberGroupManagement.jsx'), 'utf8');
  const queryStart = source.indexOf("queryKey: ['member-group-assignments']");
  const queryEnd = source.indexOf('});', queryStart);

  assert.notEqual(queryStart, -1, 'member-group assignment query must exist');
  assert.notEqual(queryEnd, -1, 'member-group assignment query must be complete');

  const assignmentQuery = source.slice(queryStart, queryEnd);
  assert.match(
    assignmentQuery,
    /MemberGroupAssignment\.listAll\(\)/,
    'assignments after the first 1,000 records must be loaded for card counts and previews',
  );
  assert.doesNotMatch(
    assignmentQuery,
    /MemberGroupAssignment\.list\(\)/,
    'the capped single-page assignment request must not be restored',
  );
});

test('automatic groups expose a manual sync action on their cards only when enabled', () => {
  const source = readFileSync(path.join(here, 'MemberGroupManagement.jsx'), 'utf8');
  const cardStart = source.indexOf('const renderGroupCard = (group) =>');
  const cardEnd = source.indexOf('// Sections for "group by classification"', cardStart);
  const cardSource = source.slice(cardStart, cardEnd);

  assert.match(cardSource, /\{group\.automatic_membership_enabled && \(/);
  assert.match(cardSource, /button-sync-automatic-members-/);
  assert.match(cardSource, /syncAutomaticGroupFromCard\(group\)/);
  assert.match(cardSource, /automaticSyncRunning \? 'Syncing…'/);
});