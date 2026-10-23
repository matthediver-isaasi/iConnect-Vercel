import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registrationMemberHighlight } from './eventRegistrationMemberHighlight.mjs';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

test('highlight depends only on the resolved member link', () => {
  for (const is_guest_booking of [true, false]) {
    assert.match(registrationMemberHighlight({ member_id: null, organization_id: 'org', is_guest_booking }), /bg-amber/);
    assert.equal(registrationMemberHighlight({ member_id: 'member', organization_id: null, is_guest_booking }), '');
  }
});

test('creating a member removes the highlight without rewriting historical guest status', () => {
  const attendee = { id: 'booking', member_id: null, is_guest_booking: true };
  assert.notEqual(registrationMemberHighlight(attendee), '');
  const updated = { ...attendee, member_id: 'created-member' };
  assert.equal(registrationMemberHighlight(updated), '');
  assert.equal(updated.is_guest_booking, true);
});

test('both report row layouts use the cue and member creation patches its dependency immediately', () => {
  const page = readFileSync(new URL('../pages/EventRegistrationReport.jsx', import.meta.url), 'utf8');
  assert.equal((page.match(/registrationMemberHighlight\(attendee\)/g) || []).length, 2);
  assert.match(page, /\{ \.\.\.attendee, member_id: data\.member\.id \}/);
  assert.match(page, /Pale amber rows have no linked member record/);
});

test('production Tailwind scanning emits both highlight styles from the mjs helper', async () => {
  const result = await postcss([tailwindcss('./tailwind.config.ts')])
    .process('@tailwind utilities;', { from: undefined });
  assert.ok(result.css.includes('.bg-amber-50\\/60'), 'light-mode highlight CSS missing');
  assert.ok(result.css.includes('.dark\\:bg-amber-950\\/20'), 'dark-mode highlight CSS missing');
});
