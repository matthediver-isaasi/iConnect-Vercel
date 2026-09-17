import { spawnSync } from 'node:child_process';

// Explicit allow-list: older membership PostgreSQL tests may use a configured
// external database. This suite uses mocks plus its own disposable local cluster.
const files = [
  'shared/rollingMembershipTerm.test.mjs',
  'api/_lib/rollingCommitmentEntityBoundary.test.mjs',
  'api/_lib/rollingMembershipCommitment.test.mjs',
  'api/_lib/rollingMembershipCommitment.postgres.test.mjs',
  'api/_lib/rollingMembershipLifecycle.test.mjs',
  'api/_lib/rollingMonthlyRenewal.test.mjs',
  'api/_lib/rollingFeeCommitment.test.mjs',
  'api/_lib/rollingFeeQuote.postgres.test.mjs',
  'api/_lib/membershipPaymentReconciliation.rolling.test.mjs',
  'api/_lib/formMembershipPaymentQuote.test.mjs',
  'api/_lib/annualRenewalPolicy.test.mjs',
  'api/_lib/membershipVatSimulation.test.mjs',
  'api/_lib/stripeMonthlyCard.test.mjs',
  'api/_lib/stripeCardRenewals.test.mjs',
  'api/_lib/gocardlessDdRenewals.test.mjs',
  'api/_lib/gocardlessDirectDebit.test.mjs',
  'api/_lib/gocardlessWebhookProcessor.test.mjs',
  'api/_lib/membershipInstalmentInvoicing.test.mjs',
  'api/_lib/formMonthlyCardCheckout.test.mjs',
  'api/_lib/formMonthlyCardFinalize.test.mjs',
  'api/_lib/formMonthlyDirectDebitCheckout.test.mjs',
  'api/_lib/formMonthlyDirectDebitFinalize.test.mjs',
  'api/_lib/formMembershipFinalize.behavior.test.mjs',
  'api/_lib/membershipStripeReconcile.test.mjs',
  'api/_lib/membershipQuote.test.mjs',
  'api/_lib/membershipTiersActiveConfigs.test.mjs',
  'api/_lib/zeroDueMembership.test.mjs',
  'api/_lib/workflowCreateMembershipInvoice.test.mjs',
  'api/_lib/membershipFeeApproval.test.mjs',
  'api/membership/member-history.test.mjs',
  'api/membership/member-membership.commitment.test.mjs',
  'api/membership/member-membership.instalments.test.mjs',
  'api/membership/member-fees.commitment.test.mjs',
];
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;