import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { purchaseIdentity, validatePurchaseIdentities } from '../../utils/publicTicketMembers.js';

const source = ts.createSourceFile('PaymentOptions.jsx',
  readFileSync(new URL('./PaymentOptions.jsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
const names = ['selfBookingChoiceRequired', 'purchaserInfo', 'showPurchaserFields', 'purchaseIdentityError'];
const expressions = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) {
    expressions.set(node.name.getText(source), node.initializer.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
const attendee = { first_name: 'Alex', last_name: 'Guest', email: 'alex@example.invalid', organization: 'School' };
const buyer = { first_name: 'Other', last_name: 'Booker', email: 'other@example.invalid', organization: 'College' };
function resolve(choice, guest = attendee) {
  const context = {
    requiresPurchaserIdentity: true, isGuestCheckout: true, isComplexEvent: false,
    guestBookingForSelf: choice, guestInfo: guest, separatePurchaserInfo: buyer,
    purchaseIdentity, validatePurchaseIdentities,
    identityItems: [{ ticketClass: { visibility_mode: 'members_and_public', create_member_records: true, new_member_role_id: 'contact' }, attendees: [guest] }],
  };
  for (const name of names) {
    context[name] = new Function(...Object.keys(context), `return (${expressions.get(name)});`)(...Object.values(context));
  }
  return context;
}
test('explicit self booking uses the current attendee details once and hides purchaser fields', () => {
  const state = resolve(true);
  assert.deepEqual(state.purchaserInfo, attendee);
  assert.equal(state.showPurchaserFields, false);
  assert.equal(state.purchaseIdentityError, null);
  assert.equal(resolve(true, { ...attendee, email: 'edited@example.invalid' }).purchaserInfo.email, 'edited@example.invalid');
});
test('booking for someone else preserves independent purchaser details', () => {
  const state = resolve(false);
  assert.deepEqual(state.purchaserInfo, buyer);
  assert.equal(state.showPurchaserFields, true);
  assert.equal(state.purchaseIdentityError, null);
  assert.deepEqual(resolve(false).purchaserInfo, buyer);
});
test('unanswered choice blocks checkout without assuming purchaser identity', () => {
  const state = resolve(null);
  assert.equal(state.showPurchaserFields, false);
  assert.match(state.purchaseIdentityError, /choose whether/);
});
