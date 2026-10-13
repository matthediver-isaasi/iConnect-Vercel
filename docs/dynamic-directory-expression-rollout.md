# Directory inclusion expressions

The editor saves version 1 All/Any groups with field/value conditions. Maximum
depth is five (including leaves), with at most 100 nodes. Null expressions use
the old field/value predicate; a non-null expression is authoritative. Visitor
search filters remain separate and only narrow the eligible population.

## Database and release status

`migrations/20261013_dynamic_directory_filter_expression.sql` was applied on
2026-10-13 to verified Supabase DEST (`lvmzliemqnieeoruhkik`) using
`scripts/apply-directory-expression.mjs`, with verified TLS and REST/SQL target
pins. The `filter_expression` column was verified as JSONB after application.
No directory rows or GFI settings were changed. SOURCE was untouched. No
additional migration is pending for this feature.

The runner defaults to offline SHA review; `--preflight` checks the target
schema without applying changes. Its applied SQL hash was
`f9ca872c226ea55723ba3ba42b4c0e0b2d71cf4518c7178680edbca9993e1328`.
It does not add a Supabase migration-history row.

Source merge and production rollout are separate from schema readiness. This
task does not deploy. The local preview still uses the legacy SOURCE and shows
“Tenant not found”; the signed-in management screen and deployed UI were not
visually verified. Mounted editor tests and isolated API fixtures are not
production-browser evidence.

## Verification

Run:

```
node scripts/run-isolated-tests.mjs --shell "node --test api/_lib/directoryExpression.test.mjs api/dynamic-directory/config.publication.test.mjs api/dynamic-directory/members.scoping.test.mjs api/public/dynamic-directory.test.mjs api/public/dynamic-directory.carousel.test.mjs api/public/dynamic-directory.tenant-resolution.test.mjs"
npx tsx --test client/src/components/directory/DirectoryExpressionEditor.test.jsx
```

Fixtures demonstrate Partner AND (application_status A OR B); A/B are synthetic
test values, not recommendations for GFI. Wait for its requested status values
before configuring its live Partner Directory.
