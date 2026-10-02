import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { preserveTicketVatMetadata } from './ticketVatMetadata.mjs';

const sources = Object.fromEntries([
  ['create', '../pages/CreateEvent.jsx'],
  ['edit', '../pages/EditEvent.jsx'],
  ['complex', '../pages/CreateComplexEvent.jsx'],
  ['manager', '../components/events/ComplexEventTicketManager.jsx'],
].map(([key, file]) => [key, readFileSync(new URL(file, import.meta.url), 'utf8')]));

// Execute the actual editor factory/load/save expressions without mounting the
// authenticated page or calling its data/provider mutations.
function expression(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing source start: ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `Missing source end: ${end}`);
  return source.slice(from, to);
}

const context = {
  preserveTicketVatMetadata,
  hydrateTicketRelease: () => ({}),
  serializeTicketRelease: () => ({}),
  generateId: () => 'fixture-ticket',
  toLocalDatetimeString: value => value,
  isGroupLimited: false,
  groupTicketTypeName: 'Fixture',
  eventId: 'fixture-event',
  trackIdMap: {},
  ti: 0,
};

function evaluate(code, values = {}) {
  // Normalize cross-realm objects exactly as JSON transport does.
  return JSON.parse(JSON.stringify(runInNewContext(code, { ...context, ...values })));
}

function saveSimple(key, tickets, isGroupLimited = false) {
  const code = expression(sources[key], 'const formattedTicketClasses =', '\n      // For backward compatibility');
  return evaluate(`${code}\nformattedTicketClasses`, { ticketClasses: tickets, isGroupLimited });
}

function loadSimple(ticket) {
  const code = expression(sources.edit, 'const loadedTickets = config.ticket_classes.map', '\n          setTicketClasses(loadedTickets)');
  return evaluate(`${code}\nloadedTickets[0]`, { config: { ticket_classes: [ticket] } });
}

function loadComplex(ticket) {
  const code = expression(sources.complex, 'const loaded = existingTicketClasses.map', '\n      setTicketClasses(loaded)');
  return evaluate(`${code}\nloaded[0]`, { existingTicketClasses: [ticket] });
}

function saveComplex(ticket) {
  const code = expression(sources.complex, 'const tcPayload =', '\n\n        if (ticket._dbId)');
  return evaluate(`${code}\ntcPayload`, { ticket });
}

const fixtures = [
  {},
  { vat_rate_key: null, vat_rate_label: null, vat_rate_percentage: null },
  { vat_rate_key: 'ZERORATED', vat_rate_label: 'Zero rated', vat_rate_percentage: 0 },
  { vat_rate_key: 'NONE', vat_rate_label: 'No VAT', vat_rate_percentage: 0 },
  { vat_rate_key: 'EXEMPT', vat_rate_label: 'Exempt', vat_rate_percentage: 0 },
  { vat_rate_key: 'OUTPUT2', vat_rate_label: 'Standard', vat_rate_percentage: 20 },
  { vat_rate_key: '', vat_rate_label: '', vat_rate_percentage: null },
];

test('all four new-ticket factories preserve a configured zero rate; no inclusive policy is added', () => {
  for (const [key, source] of Object.entries(sources)) {
    const factory = expression(source, 'const createEmptyTicketClass =', '\n});') + '\n});';
    const args = key === 'manager' ? 'rate' : 'false, rate';
    for (const effectiveRate of [0, null, 20]) {
      const ticket = evaluate(`${factory}\ncreateEmptyTicketClass(${args})`, {
        rate: { taxType: 'NONE', name: 'No VAT', effectiveRate },
      });
      assert.equal(ticket.vat_rate_percentage, effectiveRate, key);
      assert.equal(ticket.vat_rate_key, 'NONE', key);
      assert.equal(Object.hasOwn(ticket, 'invoice_line_amount_type'), false, key);
    }
  }
});

test('standard existing-ticket load and real save mapping preserve VAT metadata and invoice policy presence', () => {
  for (const fixture of fixtures) {
    for (const policy of [{}, { invoice_line_amount_type: null }, { invoice_line_amount_type: 'Inclusive' }, { invoice_line_amount_type: 'Exclusive' }]) {
      const original = { id: 'fixture-ticket', name: 'Existing', price: 15, ...fixture, ...policy };
      const loaded = loadSimple(original);
      for (const key of ['create', 'edit']) {
        for (const group of [false, true]) {
          const saved = saveSimple(key, [loaded], group)[0];
          assert.deepEqual(preserveTicketVatMetadata(saved, true), preserveTicketVatMetadata(original, true));
        }
      }
    }
  }
});

test('complex existing-ticket load and real entity payload preserve zero/null/absence without an unsupported policy column', () => {
  for (const fixture of fixtures) {
    const original = { id: 'fixture-ticket', name: 'Existing', price: 15, ...fixture };
    const saved = saveComplex(loadComplex(original));
    assert.deepEqual(preserveTicketVatMetadata(saved), preserveTicketVatMetadata(original));
    assert.equal(Object.hasOwn(saved, 'invoice_line_amount_type'), false);
  }
  const saved = saveComplex({ ...loadComplex({ price: 10 }), invoice_line_amount_type: 'Inclusive' });
  assert.equal(Object.hasOwn(saved, 'invoice_line_amount_type'), false);
});

test('existing editors never apply tenant VAT defaults while hydrating saved tickets', () => {
  assert.doesNotMatch(expression(sources.edit, 'const loadedTickets =', '\n          setTicketClasses(loadedTickets)'), /defaultVatRate/);
  assert.doesNotMatch(expression(sources.complex, 'const loaded = existingTicketClasses.map', '\n      setTicketClasses(loaded)'), /defaultVatRate/);
});