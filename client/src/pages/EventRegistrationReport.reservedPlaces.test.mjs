import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('./EventRegistrationReport.jsx', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('function ReservedPlaces('), source.indexOf('function PaymentMethodBadge('));
const compiled = await transform(section, { loader: 'jsx', format: 'cjs' });
const wrapper = ({ children }) => React.createElement('div', null, children);
const ReservedPlaces = new Function('React', 'Card', 'CardHeader', 'CardTitle', 'CardContent',
  `${compiled.code}; return ReservedPlaces;`)(React, wrapper, wrapper, wrapper, wrapper);
const render = reservations => renderToStaticMarkup(React.createElement(ReservedPlaces, { reservations }));

test('reserved places render separately with all commercial details and totals explanation', () => {
  const reservations = [{
    allocationId: 'allocation-12', eventId: 'event-8', eventName: 'Policy forum',
    ticketName: 'Partner ticket', proposalNumber: 'PROP-182',
    organizationName: 'Cedar Institute', status: 'Reserved', places: 7,
  }, {
    allocationId: 'allocation-13', eventId: 'event-9', eventName: 'Skills workshop',
    ticketName: 'Workshop pass', proposalNumber: 'PROP-193',
    organizationName: 'Harbour Group', status: 'Reserved', places: 3,
  }];
  const before = JSON.stringify(reservations);
  const html = render(reservations);
  for (const label of ['Reserved places', 'Event', 'Ticket', 'Proposal number', 'Booking organisation', 'Places',
    'Policy forum', 'Partner ticket', 'PROP-182', 'Cedar Institute',
    'Skills workshop', 'Workshop pass', 'PROP-193', 'Harbour Group']) {
    assert.ok(html.includes(label), `missing ${label}`);
  }
  assert.match(html, />7<\/td>/);
  assert.match(html, />3<\/td>/);
  assert.match(html, /purchased unnamed places, not attendees/);
  assert.match(html, /not included in attendee or payment totals/);
  assert.equal((html.match(/<tbody>/g) || []).length, 1);
  assert.equal(JSON.stringify(reservations), before);
  assert.doesNotMatch(html, /<button|<input/);
});

test('absent or empty commercial reservations produce no section', () => {
  for (const value of [undefined, null, [], {}]) assert.equal(render(value), '');
});

test('commercial section stays inside existing authorized successful report branch', () => {
  const placement = source.indexOf('<ReservedPlaces reservations={reportData?.commercialReservations} />');
  assert.ok(placement > source.indexOf('  if (!accessChecked)'));
  assert.ok(placement > source.indexOf('{reportGenerated && !isFetching && !reportError && ('));
  assert.ok(placement < source.indexOf('                Registrations', placement));
  assert.equal((source.match(/reportData\?\.commercialReservations/g) || []).length, 1,
    'reservations are only passed to the display, never attendee totals or filters');
});
