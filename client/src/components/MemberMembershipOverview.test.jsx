import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MemberMembershipOverview, { overviewTermExpiry } from './MemberMembershipOverview';
globalThis.React = React;
const paid = { membership_source: 'personal', payment_status: 'paid', status: 'expired', term_end_date: '2026-09-30' };
test('uses persisted current dates, not simulated quotes or organisation terms', () => {
  assert.equal(overviewTermExpiry({ currentCommitments: [{ source: 'personal', lifecycle: 'current', endDate: '2027-03-31' }], history: [paid] }), '2027-03-31');
  assert.equal(overviewTermExpiry({ legacyCurrentMembership: { endDate: '2026-09-30' } }), '2026-09-30');
  assert.equal(overviewTermExpiry({ history: [paid, { ...paid, membership_source: 'organisation', term_end_date: '2028-01-01' }, { ...paid, payment_status: 'pending', term_end_date: '2027-09-30' }] }), '2026-09-30');
  assert.equal(overviewTermExpiry({ currentYearCost: { endDate: '2027-09-30' } }), null);
  assert.equal(overviewTermExpiry({ history: [{ ...paid, term_start_date: '2099-01-01' }] }), null);
});
function render(data) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['member-membership', 'member'], data);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemberMembershipOverview memberId="member" /></QueryClientProvider>);
  client.clear();
  return html;
}
test('card shows term expiry separately from shared grace deadline and warnings', () => {
  const html = render({ history: [paid], graceWarning: { expired: false, days: 10, endsOn: '2026-12-29', remainingDays: 80, reason: 'Not renewed' } });
  for (const text of ['30/09/2026', '29/12/2026', '80 grace days remaining', 'Individual membership is in its grace period']) assert.ok(html.includes(text));
  assert.match(render({ history: [paid], graceWarning: { expired: true, endsOn: '2026-12-29' } }), /Grace period expired/);
  assert.match(render({ graceWarningUnavailable: true }), /could not be checked/);
  assert.match(render({}), /No confirmed term expiry/);
});
