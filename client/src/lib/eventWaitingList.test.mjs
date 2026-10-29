import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waitingListAttendee, resolveWaitingListAttempt, withdrawWaitingListEntries } from './eventWaitingList.mjs';
import { resolveEventCtaLabel } from './eventCtaLabel.js';

test('waiting attendee payload retains preferences and omits all client pricing/payment fields', () => {
  const attendee = waitingListAttendee({
    first_name: ' Mira ', last_name: ' Shah ', email: ' MIRA@example.org ',
    member_id: 'member-7', job_title: ' Adviser ', session_ids: ['session-3'],
    option_ids: ['option-8'], dietary_selections: ['Vegetarian'],
    allergy_selections: [{ name: 'Peanuts', severity: 'severe' }],
    accessibility_selections: ['Step-free access'], total_paid: 99, price: 100, discount_code: 'CODE',
  }, 'ticket-4');
  assert.deepEqual(attendee, {
    first_name: 'Mira', last_name: 'Shah', email: 'mira@example.org',
    member_id: 'member-7', job_title: 'Adviser', ticket_class_id: 'ticket-4',
    session_ids: ['session-3'], option_ids: ['option-8'],
    dietary_selections: ['Vegetarian'], allergy_selections: [{ name: 'Peanuts', severity: 'severe' }],
    accessibility_selections: ['Step-free access'],
  });
});

test('ambiguous failure retries reuse a key, changed attendee selection creates a new key', () => {
  let calls = 0;
  const createId = () => `uuid-${++calls}`;
  const first = resolveWaitingListAttempt(null, { attendees: ['one'] }, createId);
  assert.equal(resolveWaitingListAttempt(first, { attendees: ['one'] }, createId), first);
  assert.notEqual(resolveWaitingListAttempt(first, { attendees: ['two'] }, createId).key, first.key);
  assert.equal(calls, 2);
});

test('attendee withdrawal preserves colleagues; explicit registration withdrawal preserves unrelated entries', () => {
  const entries = [{ id: 'a', registration_id: 'r1' }, { id: 'b', registration_id: 'r1' }, { id: 'c', registration_id: 'r2' }];
  assert.deepEqual(withdrawWaitingListEntries(entries, { entry: entries[0], scope: 'attendee' }).map(e => e.id), ['b', 'c']);
  assert.deepEqual(withdrawWaitingListEntries(entries, { entry: entries[0], scope: 'registration' }).map(e => e.id), ['c']);
});

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('waiting mode branches before payment hooks mount, and uses only the waiting endpoint', () => {
  const payment = source('../components/booking/PaymentOptions.jsx');
  const checkout = source('../components/booking/WaitingListCheckout.jsx');
  assert.match(payment, /waiting_list_enabled === true[\s\S]*?<WaitingListCheckout[\s\S]*?<NormalPaymentOptions/);
  assert.match(checkout, /\/api\/member\/event-waiting-list/);
  assert.doesNotMatch(checkout, /createPaymentIntent|submitBooking|loadStripe|VoucherSelector|functions\.invoke/);
  assert.match(checkout, /idempotency_key: attempt\.current\.key/);
});

test('route and navigation reuse My Tickets permissions without a new permission', () => {
  assert.match(source('../pages/index.jsx'), /path="\/waitingList" element={<WaitingList/);
  assert.match(source('../pages/Layout.jsx'), /'waitingList': 'page_user_MyTickets'/);
  assert.match(source('../pages/Layout.jsx'), /title: "My Waiting Lists",[\s\S]*?featureId: "page_MyTickets"/);
  assert.match(source('../pages/WaitingList.jsx'), /isFeatureExcluded\('page_MyTickets'\)/);
});

test('all event editors persist an independent boolean, including reused complex editing', () => {
  for (const page of ['CreateEvent', 'EditEvent', 'CreateComplexEvent']) {
    const text = source(`../pages/${page}.jsx`);
    assert.match(text, /waiting_list_enabled:/);
    assert.match(text, /<WaitingListTimingField/);
  }
  assert.match(source('../pages/CreateComplexEvent.jsx'), /waiting_list_enabled: existingEvent\.waiting_list_enabled === true/);
});

test('capacity bypass is scoped to waiting mode and ticket availability checks remain for normal bookings', () => {
  const simple = source('../pages/EventDetails.jsx');
  const complex = source('../pages/ComplexEventDetail.jsx');
  assert.match(simple, /getTicketSoldOut = \(ticket\) => {\s*if \(waitingListEnabled\) return false;/);
  assert.match(complex, /isTicketSoldOut = useCallback\(\(tc\) => {\s*if \(waitingListEnabled\) return false;/);
  assert.match(simple, /!waitingListEnabled && !hasUnlimitedCapacity/);
  assert.match(complex, /!waitingListEnabled && event\?\.available_seats/);
  assert.match(simple, /if \(getTicketSoldOut\(ticket\)\)/);
  assert.match(complex, /!ticket \|\| isReleaseBlocked\(ticket\) \|\| isTicketSoldOut\(ticket\)/);
});

test('waiting list ignores ticket release schedules without weakening normal booking gates', () => {
  assert.match(source('../pages/EventDetails.jsx'), /if \(!waitingListEnabled && !isTicketReleased\(ticket, releaseNowMs\)\) return false/);
  assert.match(source('../pages/ComplexEventDetail.jsx'), /isReleaseBlocked = useCallback\(\(ticket\) => {\s*if \(waitingListEnabled\) return false/);
});

test('campaign editor supports direct waiting-list audience for save and previews with the shared event picker', () => {
  const campaign = source('../pages/EmailCampaignEdit.jsx');
  assert.match(campaign, /value="event_waiting_list">Event waiting list/);
  assert.match(campaign, /<EventAudiencePicker\s+waitingListOnly=\{directAudienceType === 'event_waiting_list'\}\s+value=\{selectedEventIds\}/);
  assert.match(campaign, /saveData\.target_audiences = campaignTargetAudiences/);
  assert.match(campaign, /targetAudiences: campaignTargetAudiences/);
  assert.doesNotMatch(source('../pages/CommunicationsManagement.jsx'), /value="event_waiting_list"/);
});

test('waiting-list cards advertise interest even when normal capacity is exhausted', () => {
  assert.equal(resolveEventCtaLabel({ waitingListEnabled: true, isSoldOut: true, perEventLabel: 'Buy now' }), 'Join waiting list');
  assert.equal(resolveEventCtaLabel({ waitingListEnabled: true, isRegistrationClosed: true }), 'Registration Closed');
});
