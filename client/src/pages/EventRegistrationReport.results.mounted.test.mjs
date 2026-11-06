import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Mount the actual result-state, handlers, filtering, selection checkboxes and
// bulk toolbar from the page. No auth, network or payment services are involved.
// The outer report chrome and unrelated row cells are deliberately omitted.
const source = readFileSync(new URL('./EventRegistrationReport.jsx', import.meta.url), 'utf8');
function section(start, end) {
  assert.ok(source.includes(start) && source.includes(end));
  return source.slice(source.indexOf(start), source.indexOf(end));
}
const states = section('  const [searchQuery', '  const [showColumnChooser')
  .replace(/  const cpdEventSuggestions = .*;\n/, '');
const criteria = section('  const [filterEventName', '  const { data: eventsForTypeAhead');
const setters = [...new Set((states + criteria).match(/\bset[A-Z]\w+/g))];
const component = `
import React, {useState, useMemo, useEffect} from 'react';
import {Checkbox} from './client/src/components/ui/checkbox';
import {Button} from './client/src/components/ui/button';
import {cpdRegistrationIdentity, cpdRegistrationKey} from './client/src/lib/cpdPointsReplay';
import {filterRegistrationAttendance} from './client/src/lib/eventRegistrationAttendance.mjs';
import {registrationGroupMatches} from './shared/eventRegistrationSearch.mjs';
import {registrationOrganisationLabel} from './client/src/lib/eventRegistrationOrganisation.mjs';
const eventInvoiceNumber = () => '';
export default function Results({bookingGroups, isLoading = false, isFetching = false, reportError = null, canReprocessCpd = true}) {
${criteria}
${states}
const [guestMemberTarget, setGuestMemberTarget] = useState(null);
const [appliedFilters, setAppliedFilters] = useState(null);
const refetchReport = () => { globalThis.fixtureRefetches++; };
const organizations = {};
const ITEMS_PER_PAGE = 25;
const reportData = {bookingGroups};
${section('  const selectedCpdRegistrations', '  const buildQueryUrl')}
${section('  const resetReportResults', '  const hasActiveFilters')}
${section('  const filteredGroups =', '  const totalAttendees =')}
${section('  const totalPages =', '  const handleExportCSV')}
${section('  const selectionRegistration =', '  if (!accessChecked)')}
globalThis.fixtureControls = {${setters.join(',')}, setAppliedFilters,
  handleGenerateReport, handleClearFilters,
  snapshot: {appliedFilters, cpdSelection, bulkAction, cpdDialog, statusFilter, consentFilter, attendanceFilter}};
return <div>{bulkToolbar}
  <button onClick={handleGenerateReport}>Generate</button>
  <button onClick={handleClearFilters}>Clear report</button>
   {paginatedGroups.map((group, groupIndex) => <div key={groupIndex}>
     {group.attendees.map((attendee, attendeeIndex) => <div key={attendeeIndex}>{renderSelection(attendee, group)}{attendee.attendee_first_name}</div>)}
  </div>)}
</div>;
}`;

test('mounted results reproduce hidden rows, then reset on generation without breaking cross-page selection', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.test' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver', 'Event', 'MouseEvent', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = (await import('react')).default;
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const bundle = await build({
    stdin: { contents: component, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  });
  const mod = new Module(`${process.cwd()}/report-results-fixture.cjs`);
  mod.filename = `${process.cwd()}/report-results-fixture.cjs`;
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(bundle.outputFiles[0].text, mod.filename);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const rows = Array.from({ length: 26 }, (_, i) => ({
    eventId: `event-${i}`, groupPayment: {}, attendees: [{
      id: `booking-${i}`, attendee_first_name: `Person${i}`, status: 'confirmed',
      third_party_consent: false, attendance_status: 'absent',
    }],
  }));
  const render = async (data, props = {}) => act(async () => root.render(React.createElement(mod.exports.default, { bookingGroups: data, ...props })));
  const click = async element => act(async () => element.click());
  const controls = () => globalThis.fixtureControls;
  const checkbox = () => container.querySelector('[role=checkbox]');
  const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
  globalThis.fixtureRefetches = 0;
  try {
    await render(rows);
    await click(button('Generate'));
    await click(checkbox());
    assert.match(container.textContent, /1 selected registrations/);
    await act(async () => controls().setCurrentPage(2));
    await click(checkbox());
    assert.match(container.textContent, /2 selected registrations/);
    await render([...rows]); // background data refresh is not a new generation
    assert.match(container.textContent, /2 selected registrations/);
    await act(async () => {
      controls().setStatusFilter('cancelled');
      controls().setConsentFilter('consented');
      controls().setAttendanceFilter('attended');
      controls().setSearchQuery('old unmatched search');
    });
    assert.equal(checkbox(), null, 'returned rows can be hidden by stale result filters');
    assert.match(container.textContent, /2 selected registrations/);
    await click(button('Request cancellation'));
    assert.equal(controls().snapshot.bulkAction.registrations.length, 2);
    await click(button('Generate'));
    assert.equal(globalThis.fixtureRefetches, 1, 'same criteria still refetch');
    assert.match(container.textContent, /0 selected registrations/);
    assert.equal(controls().snapshot.bulkAction, null);
    assert.equal(controls().snapshot.cpdDialog, null);
    assert.equal(container.querySelectorAll('[role=checkbox]').length, 25);
    assert.ok([...container.querySelectorAll('[role=checkbox]')].every(el => el.getAttribute('aria-checked') === 'false'));
    for (const text of ['Request cancellation', 'Reprocess CPD points', 'Send survey invitation', 'Preview or email CPD certificate']) {
      assert.equal(button(text).disabled, true);
    }
    // Each stale restriction independently hides these returned registrations.
    for (const [setter, value] of [['setStatusFilter', 'cancelled'], ['setConsentFilter', 'consented'], ['setAttendanceFilter', 'attended'], ['setSearchQuery', 'unmatched']]) {
      await act(async () => controls()[setter](value));
      assert.equal(checkbox(), null);
      await click(button('Generate'));
      assert.ok(checkbox());
    }
    await click(checkbox());
    await click(button('Reprocess CPD points'));
    assert.ok(controls().snapshot.cpdDialog);
    await act(async () => {
      controls().setFilterName('Person');
      controls().setFilterEmail('person@example.test');
    });
    await click(button('Generate'));
    assert.equal(controls().snapshot.appliedFilters.name, 'Person');
    assert.equal(controls().snapshot.appliedFilters.email, 'person@example.test');
    assert.deepEqual(controls().snapshot.cpdSelection, {});
    await click(button('Clear report'));
    assert.equal(button('Select all').disabled, true, 'cleared report cannot select retained data');

    // Two sources sharing a booking and event ID must remain distinct. Include
    // multiple attendees per group and a duplicate identity in the report.
    const mixedRows = rows.map((group, i) => ({
      ...group, eventTitle: `Meeting ${i}`,
      bookingSource: i === 25 ? 'complex_event_booking' : 'booking',
      eventId: i === 25 ? 'event-0' : group.eventId,
      attendees: [{
        ...group.attendees[0], id: i === 25 ? 'booking-0' : `booking-${i}`,
        attendee_email: `person${i}@example.test`,
        third_party_consent: i % 2 === 0,
        attendance_status: i % 2 === 0 ? 'attended' : 'absent',
      }],
    }));
    mixedRows[0].attendees.push({
      id: 'cancelled', attendee_first_name: 'Companion', status: 'cancelled',
      third_party_consent: true, attendance_status: 'attended',
    });
    mixedRows[1].attendees.push({...mixedRows[1].attendees[0]});
    await render(mixedRows);
    await click(button('Generate'));
    assert.match(container.textContent, /27 matching registrations/);
    await click(button('Select all'));
    await click(button('Select all')); // disabled repeat is harmless
    assert.equal(Object.keys(controls().snapshot.cpdSelection).length, 27);
    assert.ok(controls().snapshot.cpdSelection['standard:event-0:booking-0']);
    assert.ok(controls().snapshot.cpdSelection['complex:event-0:booking-0']);
    await click(button('Request cancellation'));
    const selectedPayload = controls().snapshot.bulkAction.registrations;
    assert.equal(selectedPayload.length, 27);
    assert.deepEqual(selectedPayload.find(row => row.booking_source === 'complex'), {
      booking_id: 'booking-0', booking_source: 'complex', event_id: 'event-0',
      attendee_name: 'Person25', attendee_email: 'person25@example.test',
      event_title: 'Meeting 25', status: 'confirmed',
    });
    await act(async () => controls().setCurrentPage(2));
    assert.equal(checkbox().getAttribute('aria-checked'), 'true');
    await click(checkbox());
    assert.equal(Object.keys(controls().snapshot.cpdSelection).length, 26);
    await act(async () => controls().setSortBy('name_desc'));
    assert.equal(Object.keys(controls().snapshot.cpdSelection).length, 26);
    await click(button('Select all'));
    for (const [setter, value, count] of [
      ['setStatusFilter', 'cancelled', 1],
      ['setConsentFilter', 'consented', 14],
      ['setAttendanceFilter', 'attended', 14],
      // Search intentionally matches the whole group, including Companion.
      ['setSearchQuery', 'Person0', 2],
    ]) {
      await act(async () => controls()[setter](value));
      assert.match(container.textContent, new RegExp(`${count} matching registrations`));
      await click(button('Clear all'));
      await click(button('Clear all'));
      assert.equal(Object.keys(controls().snapshot.cpdSelection).length, 27 - count);
      assert.match(container.textContent, new RegExp(`${27 - count} outside current filters`));
      await act(async () => controls()[setter](setter === 'setSearchQuery' ? '' : 'all'));
      assert.equal(Object.keys(controls().snapshot.cpdSelection).length, 27 - count, 'filter changes never select newly matching rows');
      await click(button('Select all'));
    }
    await act(async () => controls().setSearchQuery('no such result'));
    assert.equal(button('Select all').disabled, true);
    assert.equal(button('Clear all').disabled, true);
    assert.equal(Object.keys(controls().snapshot.cpdSelection).length, 27);
    await act(async () => controls().setSearchQuery(''));
    await click(button('Clear all'));
    for (const props of [{isLoading: true}, {isFetching: true}, {reportError: new Error('failed')}]) {
      await render(mixedRows, props);
      assert.equal(button('Select all').disabled, true);
      assert.equal(button('Clear all').disabled, true);
      await click(button('Select all'));
      await click(checkbox());
      assert.deepEqual(controls().snapshot.cpdSelection, {});
    }
    await render(mixedRows, {canReprocessCpd: false});
    assert.equal(button('Select all'), undefined, 'permission gate remains unchanged');
    await render(mixedRows);
    await click(button('Select all'));
    await click(button('Generate'));
    assert.deepEqual(controls().snapshot.cpdSelection, {});
    await render(rows);
    assert.equal(controls().snapshot.cpdDialog, null);
    await click(checkbox());
    await act(async () => {
      controls().setSelectedEvent({ id: 'new-event', title: 'New meeting' });
      controls().setFilterEventName('New meeting');
      controls().setStatusFilter('cancelled');
    });
    await click(button('Generate'));
    await render([{ ...rows[0], eventId: 'new-event', attendees: [{
      ...rows[0].attendees[0], id: 'new-booking', attendee_first_name: 'NewPerson',
    }] }]);
    assert.equal(controls().snapshot.appliedFilters.eventId, 'new-event');
    assert.match(container.textContent, /NewPerson/);
    assert.match(container.textContent, /0 selected registrations/);
    assert.equal(checkbox().getAttribute('aria-checked'), 'false');
    assert.equal(button('Request cancellation').disabled, true);
    await click(checkbox());
    await click(button('Clear report'));
    assert.equal(controls().snapshot.appliedFilters, null);
    assert.deepEqual(controls().snapshot.cpdSelection, {});
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    delete globalThis.fixtureControls;
    delete globalThis.fixtureRefetches;
  }
});
