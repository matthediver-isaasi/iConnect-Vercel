import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { publicTicketMemberPolicy } from './publicTicketMemberPolicy.js';
import { ticketMemberPolicy, validatePurchaseIdentities } from '../client/src/utils/publicTicketMembers.js';
import { resolveCoveredEventPaymentMethod } from '../client/src/lib/eventPaymentSelection.mjs';

// Execute the actual projection expressions, rather than a hand-written copy:
// either API serialization or page normalization dropping fields must fail.
function projection(path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const matches = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)
      && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'id')
      && node.properties.some(property =>
      ts.isPropertyAssignment(property) && property.name.getText(source) === 'visibility_mode'
      && ['tc.visibility_mode', 'visibilityMode'].includes(property.initializer.getText(source)))) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, `${path} has one ticket projection`);
  return new Function('tc', 'visibilityMode', 'publicTicketMemberPolicy', 'ticketMemberPolicy',
    `return (${matches[0].getText(source)});`);
}

for (const visibility of ['public_only', 'members_and_public']) {
  test(`${visibility}: public API to selected ticket to free checkout retains contact policy`, () => {
    const saved = { id: 'ticket', price: 0, visibility_mode: visibility,
      create_member_records: true, new_member_role_id: 'contact-role' };
    for (const path of ['api/public/event.js', 'api/public/events.js']) {
      const publicTicket = projection(path)(saved, visibility, publicTicketMemberPolicy, ticketMemberPolicy);
      const selected = projection('client/src/pages/EventDetails.jsx')(
        publicTicket, visibility, publicTicketMemberPolicy, ticketMemberPolicy);
      assert.equal(selected.create_member_records, true);
      assert.equal(selected.new_member_role_id, 'contact-role');
      assert.match(validatePurchaseIdentities({}, [{ ticketClass: selected, attendees: [] }]), /purchaser/);
      assert.equal(resolveCoveredEventPaymentMethod({
        memberCreationEnabled: ticketMemberPolicy(selected).create_member_records,
      }), 'free');
    }
  });
}

test('private and disabled ticket policies never expose a provisioning role', () => {
  for (const ticket of [null, {}, { visibility_mode: 'members_only', create_member_records: true },
    { visibility_mode: 'members_and_public', create_member_records: false }]) {
    assert.deepEqual(publicTicketMemberPolicy(ticket), { create_member_records: false, new_member_role_id: null });
  }
});

test('complex event reads and projects both checkout policy fields', () => {
  const source = readFileSync('api/public/complex-event.js', 'utf8');
  assert.match(source, /\.select\('[^']*create_member_records, new_member_role_id'\)/);
  assert.match(source, /\.\.\.publicTicketMemberPolicy\(tc\)/);
});
