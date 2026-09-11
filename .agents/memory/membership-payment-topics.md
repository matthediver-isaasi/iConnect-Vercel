# Membership payment topics

- [Stripe membership reconcile safety net](stripe-membership-reconcile.md) — webhook + idempotent recorder back up the client confirm; PI lookups must tolerate test/live mode flips; post-charge rejections must say "charge succeeded, will be reconciled".
- [Membership-paid workflow paths](membership-paid-workflow-paths.md) — any path settling a membership invoice as paid must insert the row paid AND fire the shared fireWorkflowForPaidRow helper (on payment success, exactly once).
- [Stripe monthly card plans](stripe-monthly-card-plans.md) — card plans twin GC DD plans: shared dd_* config, metadata.card snapshot, exactly-once settle, replay-through-one-processor reconcile, both-ways year guards.
- [GoCardless DD membership plans](gocardless-dd-membership-plans.md) — DD offer derives from the sim result (band amount never falls back to config); terms snapshot at consent drives webhooks/activation, not tier config.
- [GoCardless arrears & DD console](gocardless-arrears-phase4.md) — grace is a non-rolling snapshot; retry guard must throw fail-closed; arrears policy applies once; money-moving admin actions need server-side finance RBAC.
- [Manual membership activation atomicity](manual-membership-activation-atomicity.md) — admin approval must lock the plan/agreement and commit membership activation with its audit record.