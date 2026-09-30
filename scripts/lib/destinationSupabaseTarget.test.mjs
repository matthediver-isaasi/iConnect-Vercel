import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESTINATION_PROJECT_REF,
  isApprovedDestinationSupabaseTarget,
} from './destinationSupabaseTarget.mjs';

const supabaseUrl = `https://${DESTINATION_PROJECT_REF}.supabase.co`;

test('accepts canonical direct and pooler destination connections', () => {
  assert.equal(
    isApprovedDestinationSupabaseTarget(
      `postgresql://postgres:secret@db.${DESTINATION_PROJECT_REF}.supabase.co:5432/postgres`,
      supabaseUrl,
    ),
    true,
  );
  assert.equal(
    isApprovedDestinationSupabaseTarget(
      `postgresql://postgres.${DESTINATION_PROJECT_REF}:secret@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
      supabaseUrl,
    ),
    true,
  );
});

test('rejects arbitrary and coherently misconfigured targets', () => {
  assert.equal(
    isApprovedDestinationSupabaseTarget(
      `postgresql://postgres.${DESTINATION_PROJECT_REF}:secret@example.com:5432/postgres`,
      supabaseUrl,
    ),
    false,
  );
  assert.equal(
    isApprovedDestinationSupabaseTarget(
      'postgresql://postgres.otherproject:secret@aws-0-eu-west-2.pooler.supabase.com:6543/postgres',
      'https://otherproject.supabase.co',
    ),
    false,
  );
  assert.equal(
    isApprovedDestinationSupabaseTarget(
      `postgresql://postgres.${DESTINATION_PROJECT_REF}.attacker:secret@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
      supabaseUrl,
    ),
    false,
  );
});