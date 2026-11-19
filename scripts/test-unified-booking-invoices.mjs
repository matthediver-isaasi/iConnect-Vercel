import { spawnSync } from 'node:child_process';

// Every suite is run behind the network/credential isolation harness.
// PostgreSQL suites use fresh disposable Unix-socket databases, never a URL.
const unit = [
  'api/_lib/unifiedBookingContract.test.mjs','api/_lib/unifiedBookingReport.test.mjs',
  'api/_lib/unifiedBookingPaymentAuthority.test.mjs',
  'api/_lib/bookingCreditAttempt.test.mjs','api/_lib/eventInvoiceProducer.test.mjs',
  'api/_lib/eventInvoiceAddressPolicy.test.mjs','api/event-invoice-address.test.mjs',
  'api/_lib/eventInvoiceRecovery.test.mjs','api/_lib/eventInvoiceRecoveryXero.legacy.test.mjs',
  'api/_lib/eventInvoiceFutureTax.test.mjs','api/_lib/accountingEventSource.test.mjs',
  'api/_lib/publicInvoicePo.test.mjs','api/_lib/publicInvoicePoBilling.test.mjs',
  'api/_lib/publicPoInvoiceEmail.test.mjs','api/_lib/publicTicketMemberPurchase.test.mjs',
  'api/_lib/publicTicketMemberCreation.test.mjs','api/_lib/publicTicketMemberReleaseGate.test.mjs',
  'api/_lib/publicTicketSimpleQuote.test.mjs','api/_lib/eventRegistrationMember.test.mjs',
  'api/public/complex-event-payment-intent.credits.test.mjs','api/public/complex-event-private-discount.test.mjs',
  'api/public/public-invoice-po.handlers.test.mjs','api/eventPaymentPolicy.handlers.test.mjs',
  'api/reports/public-invoice-po.test.mjs','api/reports/event-registration-columns.test.mjs',
  'client/src/components/booking/PublicInvoicePoAddress.mounted.test.mjs',
  'client/src/components/booking/EventInvoiceAddressStep.mounted.test.jsx',
  'client/src/components/events/PublicInvoicePoBilling.mounted.test.mjs',
  'client/src/components/events/PublicInvoicePoRegistrations.mounted.test.mjs',
  'client/src/components/events/PublicTicketMemberFields.test.jsx',
];
const postgres = [
  'supabase/migrations/bookingCreditAttempts.test.mjs',
  'supabase/migrations/publicInvoicePoMigration.test.mjs','supabase/migrations/publicPoBookerCorrection.test.mjs',
  'supabase/migrations/eventInvoiceAddressPolicy.test.mjs','api/_lib/accountingEventSource.postgres.test.mjs',
  'api/_lib/eventInvoiceRecovery.postgres.test.mjs','api/_lib/eventRegistrationMember.postgres.test.mjs',
  'api/_lib/publicTicketMemberCreation.postgres.test.mjs',
];
for (const [name, files, flags] of [['unit, handlers and mounted UI',unit,[]],['disposable PostgreSQL',postgres,['--allow-local-postgres']]]) {
  console.log(`\nUnified booking invoices: ${name}`);
  const result=spawnSync(process.execPath,['scripts/run-isolated-tests.mjs',...flags,process.execPath,'--import','tsx','--test','--test-concurrency=1',...files],{stdio:'inherit'});
  if(result.status!==0) process.exit(result.status||1);
}
