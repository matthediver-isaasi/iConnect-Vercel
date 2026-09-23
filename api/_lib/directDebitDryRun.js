import { evaluateDryRunJob, evaluateDryRunStages } from './directDebitDryRunRuntime.js';
import { runRetries } from './directDebitRetryPipeline.js';
import { runRenewalEnvelope } from './directDebitRenewalEnvelope.js';

// The remaining family imports are installed alongside their production
// extraction; there is no fallback predictor or live processor in this module.
export async function runDirectDebitDryRun(context) {
  const { runRenewals } = await import('./ddRenewalPipeline.js');
  const { runArrearsAccess, runArrearsMonthly } = await import('./gocardlessArrearsPipeline.js');
  const { runReconciliationStage, reconciliationStages } = await import('./directDebitReconciliationPipeline.js');
  const { runDynamicCollection, runDynamicCompletion, runDynamicNotification } = await import('./directDebitDynamicPipeline.js');
  const {
    runOwnerPause, runOwnerExpiry, runOwnerActivation,
    runOwnerPaymentLinkReminders, runOwnerRollingReminders, runOwnerReminders,
  } = await import('./directDebitOwnerPipeline.js');
  const { runOwnerAnnualRenewals } = await import('./annualOwnerRenewalPipeline.js');
  const families = [
    { id: 'renewals', label: 'Membership renewals and owner stages', runners: [
      { id: 'renewal-runner-envelope', run: runRenewalEnvelope },
      { id: 'owner-pause', run: runOwnerPause },
      { id: 'owner-expiry', run: runOwnerExpiry },
      { id: 'owner-activation', run: runOwnerActivation },
      { id: 'owner-annual-renewals', run: runOwnerAnnualRenewals },
      { id: 'direct-debit-renewals', run: runRenewals },
      { id: 'owner-payment-link-reminders', run: runOwnerPaymentLinkReminders },
      { id: 'owner-rolling-reminders', run: runOwnerRollingReminders },
      { id: 'owner-fixed-reminders', run: runOwnerReminders },
    ] },
    { id: 'arrears', label: 'Arrears and post-grace collections', runners: [
      { id: 'arrears-access', run: runArrearsAccess },
      { id: 'arrears-monthly', run: runArrearsMonthly },
    ] },
    { id: 'retries', label: 'Automatic payment retries', run: runRetries },
    { id: 'reconciliation', label: 'GoCardless reconciliation', runners: [
      { id: 'dynamic-completion', run: runDynamicCompletion },
      { id: 'dynamic-notification', run: runDynamicNotification },
      { id: 'dynamic-collection', run: runDynamicCollection },
      ...reconciliationStages.map(stage => ({
        id: stage.id, run: context => runReconciliationStage(context, stage),
      })),
    ] },
  ];
  const jobs = [];
  // Each family evaluates independently at the same captured time. This
  // display order is not a proposed ordering of independently scheduled crons.
  for (const family of families) jobs.push(await (family.runners ? evaluateDryRunStages : evaluateDryRunJob)(family, context));
  return {
    evaluatedAt: context.now.toISOString(),
    plan: { id: context.plan.id, ownerLabel: context.ownerLabel },
    jobs,
    limitations: [
      'Read-only evaluation: no collections, claims, database changes, invoices, emails, workflows, scheduled-job logs, or heartbeats are executed.',
      'Jobs are independently scheduled. Display order does not imply execution order or assume changes from another job.',
      'Each stage uses current evidence without assuming earlier proposed operations succeeded. Real changes by an earlier stage can change later eligibility.',
      'Per-plan eligibility does not guarantee inclusion in the next globally limited batch; leases, batch limits, time budgets and other tenants affect selection.',
      'Renewal billing stages also require tenant discovery and a registered, unfinished durable billing opportunity at the appropriate stage/cursor. Preview reports the configured UTC hour but cannot read the protected pending/done state without claiming the live worker, so actual global renewal eligibility is unknown.',
      'A recorded operation is an attempt, not a successful claim or provider acceptance. Evaluation stops where later decisions require its unperformed result.',
      'Database and provider evidence can change concurrently; provider evidence is timestamped and failures remain unknown outcomes.',
    ],
  };
}