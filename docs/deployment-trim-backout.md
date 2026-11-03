# Deployment trimming and backout

## Baseline

Starting revision: `a2a7f632db9f5dea7df3be24f2eeaa4d60180236`

Safety branch: `backup/deployment-before-trim-20261103`

The first change only adds root `/reports/`, `/screenshots/` and `/.agents/`
to `.vercelignore`. Files remain in the workspace and Git history. No database,
provider settings, API routes, cron configuration or dependencies are changed.
In particular, `api/reports/` and frontend report components remain included.

## Verify before production

Publish the changed source to the existing preview branch first. Compare the
Vercel build log against the previous deployment: frontend compilation,
post-frontend function processing, output deployment and total time.
Do not assume exclusions resolve the function-packaging bottleneck.

## Backout

Prefer reverting the isolated deployment-exclusion commit on the current branch
and redeploying that branch. This preserves unrelated changes made since then.
If the checkpoint contains unrelated work, remove only the three new root
exclusion rules from `.vercelignore`, commit that targeted change and redeploy.

The safety branch preserves the original revision for comparison. Do not reset
the current branch to it or force-push: that would discard subsequent fixes.
Restoring source alone does not change an already-running deployment; a new
deployment of the reverted source is needed.

Function consolidation, if undertaken, must be a separate reversible change.
It needs URL/authentication, webhook, cron and duration-limit regression tests,
plus preview verification before production.
