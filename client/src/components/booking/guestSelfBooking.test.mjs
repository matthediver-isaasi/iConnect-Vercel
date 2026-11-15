import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { purchaseIdentity, validatePurchaseIdentities } from '../../utils/publicTicketMembers.js';
import { normalizePublicInvoicePoAddress } from '../../../../shared/publicInvoicePoAddress.js';

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
    purchaseIdentity, validatePurchaseIdentities, normalizePublicInvoicePoAddress,
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
  assert.deepEqual(state.purchaserInfo, { ...attendee, ...normalizePublicInvoicePoAddress(buyer) });
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
test('self and association purchaser merging retains the separate invoice address', () => {
  const address = {
    invoicing_address_line1: '21 Beacon Road', invoicing_city: 'Leeds',
    invoicing_postal_code: 'LS1 7AB', invoicing_country: 'United Kingdom',
  };
  for (const overrides of [
    {},
    { ticketRequiresPurchaserIdentity: false,
      guestInfo: { ...attendee, registration_association: { kind: 'organization', id: 'org-1' } } },
  ]) {
    const state = resolve(true, attendee, { separatePurchaserInfo: { ...buyer, ...address }, ...overrides });
    for (const [key, value] of Object.entries(address)) assert.equal(state.purchaserInfo[key], value);
    assert.equal(state.purchaserInfo.email, attendee.email);
    assert.equal(state.purchaserInfo.organization, attendee.organization);
    assert.equal(state.showPurchaserFields, false);
  }
});
test('guest identity refresh preserves separately collected invoice fields', () => {
  let syncGuest;
  function findSync(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
      && node.arguments[0]?.getText(source).includes('setPurchaserInfo(')) {
      syncGuest = node.arguments[0].getText(source);
    }
    ts.forEachChild(node, findSync);
  }
  findSync(source);
  assert.ok(syncGuest);
  let state = { ...buyer, invoicing_address_line1: '21 Beacon Road', invoicing_city: 'Leeds' };
  new Function('guestInfo', 'ticketRequiresPurchaserIdentity', 'setPurchaserInfo',
    `return (${syncGuest})();`)({ ...attendee, first_name: 'Edited' }, false, update => { state = update(state); });
  assert.equal(state.first_name, 'Edited');
  assert.equal(state.invoicing_address_line1, '21 Beacon Road');
  assert.equal(state.invoicing_city, 'Leeds');
});

test('invoice address controls are mounted only for the public Invoice / PO selection', () => {
  const conditions = [];
  function findAddress(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'PublicInvoicePoAddressFields') {
      assert.ok(ts.isBinaryExpression(node.parent));
      conditions.push(node.parent.left.getText(source));
    }
    ts.forEachChild(node, findAddress);
  }
  findAddress(source);
  assert.deepEqual(conditions, ['isPublicInvoicePo']);
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
