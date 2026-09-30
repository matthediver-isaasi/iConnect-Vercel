import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Teams terminal errors remain manually recoverable while scheduler skips them', async () => {
  const service = await readFile(new URL('./teamsAttendanceService.js', import.meta.url), 'utf8');
  const scheduler = await readFile(new URL('../teams/attendance-auto-sync.js', import.meta.url), 'utf8');
  assert.match(service, /terminal_error: pending \? null[\s\S]*enabled: true/);
  assert.match(scheduler, /\.is\('terminal_error', null\)/);
});

test('policy reconciliation scopes child changes and does not trigger on policy snapshots', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/20260830_teams_attendance.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_target_type:='complex_event_session'/);
  assert.match(sql, /v_target_type:='agenda_item'/);
  assert.match(sql, /target_type=v_target_type AND target_id=v_target_id/);
  assert.match(sql, /DROP TRIGGER IF EXISTS reconcile_policy_row_teams_policy/);
  assert.doesNotMatch(sql, /CREATE TRIGGER reconcile_policy_row_teams_policy/);
});