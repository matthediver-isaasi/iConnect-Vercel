#!/usr/bin/env node
/**
 * Task 3885 Sales acceptance / non-regression runner.
 *
 * The suite deliberately uses dependency-injected database adapters and mocked
 * provider HTTP, so it is safe to run without a deployed database, accounting
 * provider, or mail service. PostgreSQL contract tests are included when local
 * PostgreSQL command-line tools are available and otherwise report as skipped.
 *
 * Coverage groups:
 *  1. Sales foundation: access, tenant isolation, settings, and numbering
 *  2. Catalogue: validation, tenant-scoped event references, and bundles
 *  3. Quotes: immutable arithmetic, lifecycle, concurrency, and migration guards
 *  4. Quote delivery: safe public links, public acceptance, and send outcomes
 *  5. Commercial allocation: confirm, capacity, reconciliation, and rollback
 *  6. Accounting: configuration, idempotency, provider payload verification
 *  7. Reporting: scoped, bounded commercial reporting and event availability
 *  8. Client contracts: navigation, money/configuration, and allocation handoff
 */
import { spawnSync } from 'node:child_process';

const groups = [
  {
    name: '1. foundation and tenancy',
    files: [
      'api/_lib/salesFoundation.test.mjs',
      'api/_lib/salesFoundation.postgres.test.mjs',
    ],
  },
  {
    name: '2. catalogue and event references',
    files: ['api/_lib/salesCatalogue.test.mjs'],
  },
  {
    name: '3. quote contract and lifecycle',
    files: ['api/_lib/salesQuote.test.mjs'],
  },
  {
    name: '4. delivery and public acceptance',
    files: [
      'api/_lib/salesQuoteDelivery.test.mjs',
      'api/public/sales-quote/publicSalesQuote.test.mjs',
      'api/storage/signed-upload-url.test.mjs',
    ],
  },
  {
    name: '5. commercial allocation and capacity',
    files: [
      'api/_lib/salesCommercialAllocation.test.mjs',
      'api/_lib/salesCommercialAllocation.postgres.test.mjs',
      'api/_lib/allocationInvitation.postgres.test.mjs',
      'api/public/event-allocation/context/context.test.mjs',
      'api/public/complex-event-payment-intent/allocationPaymentIntent.test.mjs',
      'api/sales/allocations/allocationInviteRoute.test.mjs',
      'api/sales/allocations/allocationMemberAuthorization.test.mjs',
    ],
  },
  {
    name: '6. accounting boundary',
    files: [
      'api/_lib/salesAccounting.test.mjs',
      'client/src/lib/salesAccountingConfiguration.test.mjs',
    ],
  },
  {
    name: '7. reports and commercial visibility',
    files: [
      'api/_lib/salesReports.test.mjs',
      'api/_lib/salesReconciliation.test.mjs',
    ],
  },
  {
    name: '8. client navigation and allocation handoff',
    files: [
      'client/src/lib/salesMoney.test.mjs',
      'client/src/lib/salesNavigation.test.mjs',
      'client/src/lib/eventAllocation.test.mjs',
    ],
  },
];

for (const group of groups) {
  console.log(`\nSales hardening: ${group.name}`);
  const result = spawnSync(process.execPath, ['--test', ...group.files], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('\nSales hardening acceptance suite passed.');