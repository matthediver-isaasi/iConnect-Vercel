import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

// Exercise the page's actual click handler with a real QueryObserver: changing
// an object reference alone does not cause an unchanged query key to refetch.
const source = readFileSync(new URL('./EventRegistrationReport.jsx', import.meta.url), 'utf8');
const handlerSource = source.slice(
  source.indexOf('  const handleGenerateReport = () => {'),
  source.indexOf('  const handleClearFilters = () => {'),
);
const emptyFilters = {
  eventId: null, eventName: '', internalReference: '', dateFrom: '',
  dateTo: '', eventDateFrom: '', eventDateTo: '',
};

function generate(state, overrides = {}) {
  const values = {
    selectedEvent: null, filterEventName: '', filterInternalRef: '',
    filterDateFrom: '', filterDateTo: '', filterEventDateFrom: '', filterEventDateTo: '',
    appliedFilters: state.appliedFilters,
    setAppliedFilters: value => { state.appliedFilters = value; },
    refetchReport: () => { state.refetchPromise = state.refetch(); },
    setCurrentPage: value => { state.page = value; },
    setSearchQuery: value => { state.search = value; },
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