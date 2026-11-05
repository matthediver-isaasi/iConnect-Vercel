import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

// Exercise the page's actual click handler with a real QueryObserver: changing
// an object reference alone does not cause an unchanged query key to refetch.
const source = readFileSync(new URL('./EventRegistrationReport.jsx', import.meta.url), 'utf8');
const handlerSource = source.slice(
  source.indexOf('  const resetReportResults = () => {'),
  source.indexOf('  const handleClearFilters = () => {'),
);
const emptyFilters = {
  eventId: null, eventKind: 'simple', eventName: '', internalReference: '', dateFrom: '',
  dateTo: '', eventDateFrom: '', eventDateTo: '', name: '', email: '',
};

function generate(state, overrides = {}) {
  const values = {
    selectedEvent: null, filterEventName: '', filterInternalRef: '',
    filterName: '', filterEmail: '',
    filterDateFrom: '', filterDateTo: '', filterEventDateFrom: '', filterEventDateTo: '',
    appliedFilters: state.appliedFilters,
    setAppliedFilters: value => { state.appliedFilters = value; },
    refetchReport: () => { state.refetchPromise = state.refetch(); },
    setCurrentPage: value => { state.page = value; },
    setSearchQuery: value => { state.search = value; },
    ...Object.fromEntries([
      'CpdSelection', 'BulkAction', 'CpdDialog', 'CertificateTarget', 'GuestMemberTarget',
      'CancelTarget', 'ShowCancelDialog', 'CancelReason', 'TransferTarget',
      'ShowTransferDialog', 'TransferIsPublic', 'StatusFilter', 'ConsentFilter', 'AttendanceFilter',
    ].map(key => [`set${key}`, value => { state[key] = value; }])),
    ...overrides,
  };
  new Function(...Object.keys(values), `${handlerSource}; handleGenerateReport();`)(...Object.values(values));
}

test('Generate Report fetches a newly confirmed public invoice booking with unchanged filters', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let rows = [];
  let requests = 0;
  const observer = new QueryObserver(client, {
    queryKey: ['event-registration-report', emptyFilters],
    queryFn: async () => { requests++; return rows.slice(); },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assert.deepEqual(observer.getCurrentResult().data, []);
    const before = requests;
    rows = [{ bookingReference: 'OOE-regression', status: 'confirmed', payment_method: 'public_invoice_po' }];
    const state = { appliedFilters: { ...emptyFilters }, refetch: () => observer.refetch() };
    generate(state);
    assert.ok(state.refetchPromise, 'same-filter generation must explicitly refresh');
    await state.refetchPromise;
    assert.equal(requests, before + 1);
    assert.equal(observer.getCurrentResult().data[0].payment_method, 'public_invoice_po');
    assert.equal(state.page, 1);
    assert.equal(state.search, '');
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('every explicit generation discards prior selections, targets and restrictive table filters', () => {
  for (const overrides of [
    {},
    { selectedEvent: { id: 'new-event', title: 'Meeting' }, filterEventName: 'Meeting' },
    { filterName: ' Jane ', filterEmail: ' jane@example.test ', filterInternalRef: ' REF ',
      filterDateFrom: '2026-01-01', filterDateTo: '2026-12-31',
      filterEventDateFrom: '2026-02-01', filterEventDateTo: '2026-11-30' },
  ]) {
    const state = {
      appliedFilters: { ...emptyFilters }, refetch() {},
      CpdSelection: { old: { booking_id: 'old' } }, BulkAction: { registrations: ['old'] },
      CpdDialog: { scope: ['old'] }, StatusFilter: 'cancelled', ConsentFilter: 'consented',
      AttendanceFilter: 'attended', search: 'old', page: 9,
    };
    generate(state, overrides);
    assert.deepEqual(state.CpdSelection, {});
    for (const key of ['BulkAction', 'CpdDialog', 'CertificateTarget', 'GuestMemberTarget', 'CancelTarget', 'TransferTarget']) {
      assert.equal(state[key], null);
    }
    for (const key of ['StatusFilter', 'ConsentFilter', 'AttendanceFilter']) assert.equal(state[key], 'all');
    assert.equal(state.page, 1);
    assert.equal(state.search, '');
    for (const [input, output] of [
      ['filterName', 'name'], ['filterEmail', 'email'], ['filterInternalRef', 'internalReference'],
      ['filterDateFrom', 'dateFrom'], ['filterDateTo', 'dateTo'],
      ['filterEventDateFrom', 'eventDateFrom'], ['filterEventDateTo', 'eventDateTo'],
    ]) assert.equal(state.appliedFilters[output], (overrides[input] || '').trim());
  }
});

test('Clear Filters discards the report and its selections and dialog targets', () => {
  const clearSource = source.slice(source.indexOf('  const handleClearFilters = () => {'), source.indexOf('  const hasActiveFilters ='));
  const resetSource = handlerSource.slice(0, handlerSource.indexOf('  const handleGenerateReport'));
  const state = {};
  const setters = [...new Set(`${resetSource}${clearSource}`.match(/\bset[A-Z]\w+/g))];
  new Function(...setters, `${resetSource}${clearSource}; handleClearFilters();`)(
    ...setters.map(key => value => { state[key] = value; }),
  );
  assert.deepEqual(state.setCpdSelection, {});
  assert.equal(state.setAppliedFilters, null);
  assert.equal(state.setBulkAction, null);
  assert.equal(state.setCpdDialog, null);
  assert.equal(state.setSelectedEvent, null);
  assert.equal(state.setFilterName, '');
  assert.equal(state.setFilterEmail, '');
});

test('first generation and changed filters select the new query without refetching old filters', () => {
  for (const appliedFilters of [null, { ...emptyFilters }]) {
    const state = { appliedFilters, refetch() { assert.fail('must not refetch the old report'); } };
    generate(state, {
      selectedEvent: { id: 'event-1', title: 'Meeting' },
      filterEventName: ' Meeting ',
      filterDateFrom: '2026-09-20',
    });
    assert.equal(state.appliedFilters.eventId, 'event-1');
    assert.equal(state.appliedFilters.dateFrom, '2026-09-20');
    assert.equal(state.page, 1);
    assert.equal(state.search, '');
  }
});

test('page wires refetchReport to the report query, not the event options query', () => {
  assert.match(source, /data: reportData[^;\n]*refetch: refetchReport/);
});

test('person filters apply without event selection and repeat generation explicitly refreshes', () => {
  const state = { appliedFilters: null, refetch() { state.refreshed = true; } };
  const filters = { filterName: ' Jane Guest ', filterEmail: ' jane+%_* ' };
  generate(state, filters);
  assert.equal(state.appliedFilters.eventId, null);
  assert.equal(state.appliedFilters.name, 'Jane Guest');
  assert.equal(state.appliedFilters.email, 'jane+%_*');
  generate(state, filters);
  assert.equal(state.refreshed, true);
  assert.equal(state.page, 1);
});