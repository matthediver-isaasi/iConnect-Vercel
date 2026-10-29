import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { purchaseIdentity, validatePurchaseIdentities } from '../../utils/publicTicketMembers.js';

const source = ts.createSourceFile('PaymentOptions.jsx',
  readFileSync(new URL('./PaymentOptions.jsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
const names = ['hasRegistrationAssociations', 'requiresPurchaserIdentity', 'associationSelfPurchaser',
  'selfBookingChoiceRequired', 'purchaserInfo', 'showPurchaserFields', 'associationIdentityError', 'purchaseIdentityError'];
const expressions = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && (names.includes(node.name.getText(source)) || node.name.getText(source) === 'guardGuestIdentityEmails')) {
    expressions.set(node.name.getText(source), node.initializer.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
const attendee = { first_name: 'Alex', last_name: 'Guest', email: 'alex@example.invalid', organization: 'School' };
const buyer = { first_name: 'Other', last_name: 'Booker', email: 'other@example.invalid', organization: 'College' };
function resolve(choice, guest = attendee, overrides = {}) {
  const context = {
    ticketRequiresPurchaserIdentity: true, isGuestCheckout: true, isComplexEvent: false,
    memberInfo: null, attendees: [guest], event: {},
    guestBookingForSelf: choice, guestInfo: guest, separatePurchaserInfo: buyer,
    purchaseIdentity, validatePurchaseIdentities,
    identityItems: [{ ticketClass: { visibility_mode: 'members_and_public', create_member_records: true, new_member_role_id: 'contact' }, attendees: [guest] }],
    ...overrides,
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

test('association-only simple checkout uses full guest purchaser identity without an invisible self-choice requirement', () => {
  const guest = { ...attendee, registration_association: { kind: 'organization', id: 'org-1' } };
  const state = resolve(null, guest, { ticketRequiresPurchaserIdentity: false });
  assert.equal(state.hasRegistrationAssociations, true);
  assert.equal(state.requiresPurchaserIdentity, true);
  assert.equal(state.selfBookingChoiceRequired, false);
  assert.equal(state.showPurchaserFields, false);
  assert.deepEqual(state.purchaserInfo.registration_association, guest.registration_association);
  assert.equal(state.purchaseIdentityError, null);
});

test('association-only complex checkout collects an explicit purchaser independently from ticket provisioning', () => {
  const guest = { ...attendee, registration_association: { kind: 'group', id: 'group-1' } };
  const state = resolve(undefined, guest, {
    ticketRequiresPurchaserIdentity: false, isComplexEvent: true, guestInfo: undefined, separatePurchaserInfo: {},
  });
  assert.equal(state.requiresPurchaserIdentity, true);
  assert.equal(state.showPurchaserFields, true);
  assert.match(state.purchaseIdentityError, /purchaser/);
});

test('Other preserves original non-provisioning checkout behavior', () => {
  const state = resolve(null, attendee, { ticketRequiresPurchaserIdentity: false });
  assert.equal(state.requiresPurchaserIdentity, false);
  assert.equal(state.showPurchaserFields, false);
  assert.equal(state.purchaseIdentityError, null);
});

test('known-email login guard runs independently of ticket provisioning and checks the explicit purchaser', async () => {
  const calls = [];
  let prompted = false;
  const context = {
    memberInfo: null, isGuestCheckout: true, hasRegistrationAssociations: true,
    purchaserInfo: buyer, guestInfo: undefined, attendees: [attendee],
    publicClient: { checkMemberEmail: async email => { calls.push(email); return { isMember: email === buyer.email }; } },
    toast: { error() {} }, onGuestLoginRequired: () => { prompted = true; },
  };
  const guard = new Function(...Object.keys(context), `return (${expressions.get('guardGuestIdentityEmails')});`)(...Object.values(context));
  assert.equal(await guard(), false);
  assert.equal(prompted, true);
  assert.deepEqual(calls, [buyer.email]);
});

test('all guest identities are checked, including attendee associations on non-provisioning tickets', async () => {
  const calls = [];
  const context = {
    memberInfo: null, isGuestCheckout: true, hasRegistrationAssociations: true,
    purchaserInfo: buyer, guestInfo: undefined, attendees: [attendee],
    publicClient: { checkMemberEmail: async email => { calls.push(email); return { isMember: false }; } },
    toast: { error() {} }, onGuestLoginRequired: null,
  };
  const guard = new Function(...Object.keys(context), `return (${expressions.get('guardGuestIdentityEmails')});`)(...Object.values(context));
  assert.equal(await guard(), true);
  assert.deepEqual(calls, [buyer.email, attendee.email]);
});
