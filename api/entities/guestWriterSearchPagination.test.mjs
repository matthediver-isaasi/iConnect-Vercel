import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  applyGuestWriterListQuery,
  buildGuestWriterSearchExpression,
  escapeCaseInsensitiveRegexLiteral,
  GUEST_WRITER_MAX_OFFSET,
  GUEST_WRITER_PAGE_MAX_LIMIT,
  GUEST_WRITER_SEARCH_MAX_LENGTH,
  parseGuestWriterListQuery,
} from '../_lib/guestWriterSearch.js';

const routeSource = fs.readFileSync(
  new URL('./[entity]/index.js', import.meta.url),
  'utf8',
);

function decodeFirstLogicRegex(expression) {
  const match = expression.match(/^full_name\.imatch\."((?:\\.|[^"])*)"/);
  assert.ok(match, `unexpected search expression: ${expression}`);
  return match[1].replace(/\\(.)/g, '$1');
}

class InMemoryGuestWriterQuery {
  constructor(rows) {
    this.rows = rows;
    this.operations = [];
    this.wantsCount = false;
  }

  select(_columns, options) {
    this.wantsCount = options?.count === 'exact';
    this.operations.push(['select']);
    return this;
  }

  eq(field, value) {
    this.operations.push(['eq', field, value]);
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }

  or(expression) {
    this.operations.push(['or', expression]);
    const regex = new RegExp(decodeFirstLogicRegex(expression), 'i');
    this.rows = this.rows.filter((row) => (
      ['full_name', 'email', 'organization', 'job_title']
        .some((field) => typeof row[field] === 'string' && regex.test(row[field]))
    ));
    return this;
  }

  order(field, { ascending }) {
    this.operations.push(['order', field, { ascending }]);
    // Store ordering and apply all keys together in execute(), just as SQL does.
    return this;
  }

  range(from, to) {
    this.operations.push(['range', from, to]);
    return this;
  }

  execute() {
    const count = this.rows.length;
    const orderFields = this.operations
      .filter(([method]) => method === 'order')
      .map(([, field, options]) => [field, options]);
    const ordered = [...this.rows].sort((left, right) => {
      for (const [field, { ascending }] of orderFields) {
        const comparison = String(left[field] ?? '').localeCompare(String(right[field] ?? ''));
        if (comparison) return ascending ? comparison : -comparison;
      }
      return 0;
    });
    const range = this.operations.find(([method]) => method === 'range');
    const data = range ? ordered.slice(range[1], range[2] + 1) : ordered.slice(0, 1000);
    return { data, count: this.wantsCount ? count : null, error: null };
  }
}

test('GuestWriter-only route wires search before deterministic range and preserves opt-in count', () => {
  assert.match(routeSource, /entityNorm === 'guestwriter'\s*\?\s*parseGuestWriterListQuery/);
  assert.match(routeSource, /const wantsCount = req\.query\.count === 'exact'/);
  assert.match(
    routeSource,
    /applyGuestWriterListQuery\(query,[\s\S]*?paginated: false[\s\S]*?applyGuestWriterListQuery\(query,[\s\S]*?search: ''/,
  );
  assert.match(routeSource, /return res\.json\(\{ data: data \|\| \[\], count: count \?\? 0 \}\)/);
});

test('bounded GuestWriter query parsing rejects malformed search and pagination values', () => {
  const valid = parseGuestWriterListQuery({ search: '  Ada  ', limit: '25', offset: '0' });
  assert.deepEqual(valid, {
    value: {
      search: 'Ada',
      paginated: true,
      limit: 25,
      offset: 0,
    },
  });

  for (const query of [
    { search: 'x'.repeat(GUEST_WRITER_SEARCH_MAX_LENGTH + 1) },
    { search: ['Ada', 'Grace'] },
    { limit: '0' },
    { limit: String(GUEST_WRITER_PAGE_MAX_LIMIT + 1) },
    { limit: '1.5' },
    { offset: '-1' },
    { offset: '2.5' },
    { offset: String(GUEST_WRITER_MAX_OFFSET + 1) },
  ]) {
    assert.ok(parseGuestWriterListQuery(query).error, JSON.stringify(query));
  }
});

test('search expression treats punctuation, LIKE wildcards, and stars literally', () => {
  const literal = 'A*B, C_(R)+ [x]? 100% "yes" \\';
  const expression = buildGuestWriterSearchExpression(literal);
  const decodedPattern = decodeFirstLogicRegex(expression);
  const matcher = new RegExp(decodedPattern, 'i');

  assert.equal(matcher.test(`prefix ${literal.toLowerCase()} suffix`), true);
  assert.equal(matcher.test('prefix AxxB, CxRRR x 1000 yes suffix'), false);
  assert.match(expression, /full_name\.imatch/);
  assert.match(expression, /email\.imatch/);
  assert.match(expression, /organization\.imatch/);
  assert.match(expression, /job_title\.imatch/);
  assert.equal(
    new RegExp(`.*${escapeCaseInsensitiveRegexLiteral('*')}.*`, 'i').test('no star here'),
    false,
  );
});

test('server search filters the full tenant set before exact count and range', () => {
  const tenantMatches = Array.from({ length: 1105 }, (_, index) => ({
    id: `match-${String(index).padStart(4, '0')}`,
    tenant_id: 'tenant-a',
    full_name: index % 2 ? 'Duplicate Name' : 'Another Duplicate',
    email: index === 1104 ? 'CASE.NEEDLE@example.test' : null,
    organization: index % 3 === 0 ? 'Needle Foundation' : null,
    job_title: index % 3 === 0 ? null : 'Needle Researcher',
  }));
  const rows = [
    ...tenantMatches,
    {
      id: 'other-tenant',
      tenant_id: 'tenant-b',
      full_name: 'Needle Outside Tenant',
      email: null,
      organization: null,
      job_title: null,
    },
    {
      id: 'tenant-non-match',
      tenant_id: 'tenant-a',
      full_name: 'Unrelated',
      email: null,
      organization: null,
      job_title: null,
    },
  ];
  const parsed = parseGuestWriterListQuery({
    search: 'nEeDlE',
    limit: '100',
    offset: '1000',
  });
  assert.equal(parsed.error, undefined);

  let query = new InMemoryGuestWriterQuery(rows)
    .select('*', { count: 'exact' })
    .eq('tenant_id', 'tenant-a');
  query = applyGuestWriterListQuery(query, parsed.value);
  const result = query.execute();

  assert.equal(result.count, 1105);
  assert.equal(result.data.length, 100);
  assert.ok(result.data.every((row) => row.tenant_id === 'tenant-a'));
  assert.deepEqual(
    query.operations.map(([method]) => method),
    ['select', 'eq', 'or', 'order', 'order', 'range'],
  );
});

test('duplicate names have id tie-break ordering and unpaginated requests stay untouched', () => {
  const rows = [
    { id: 'writer-c', full_name: 'Same Name' },
    { id: 'writer-a', full_name: 'Same Name' },
    { id: 'writer-b', full_name: 'Same Name' },
  ];
  const paginated = parseGuestWriterListQuery({ limit: '2', offset: '1' }).value;
  const query = applyGuestWriterListQuery(new InMemoryGuestWriterQuery(rows), paginated);
  assert.deepEqual(query.execute().data.map(({ id }) => id), ['writer-b', 'writer-c']);

  const legacy = new InMemoryGuestWriterQuery(rows);
  applyGuestWriterListQuery(legacy, parseGuestWriterListQuery({}).value);
  assert.deepEqual(legacy.operations, []);
});