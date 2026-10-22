# Self-service publication imports

## Staff workflow

In **Brief Management**, staff with **Manage briefs** permission can download
the Excel template and choose **Import publications**. Assignment permission is
also required for rows containing a writer or editor.

1. Download a fresh template for the current tenant. Its Instructions sheet lists
   that tenant's stages and categories. It contains no historical records or
   personal-data examples.
2. Fill the Publications sheet using the existing 18 headings. Title is required.
   Other fields are optional, except an external writer requires an existing
   external-writer email. Blank status uses the first configured stage.
3. Upload `.xlsx` (not `.xls` or CSV), at most **1 MB and 100 publication rows**.
   Combined parsed row text is limited to 512 KB, including headers, to keep
   the reviewed plan within serverless request/response limits. A workbook with
   multiple data sheets requires an explicit worksheet choice.
4. Preview every row. Expand rows to inspect assignments and all mapped fields.
   Correct errors in Excel and upload again. No data is written during preview.
5. Explicitly confirm creation. The result reports created, skipped and failed
   rows. The normal brief list refreshes after completion.

Internal writer/editor matching uses existing full names in the current tenant.
External writers match existing email addresses; optional first/last names only
verify that match. Missing or ambiguous matches must be corrected, never guessed.
No people, categories, stages, attachments, public resources or NDA records are
created.

Dates must be real Excel dates or strict ISO dates/timestamps with a timezone;
dates without a time are midnight UTC. Flags accept Yes/No, True/False or 1/0,
with blank meaning false. **Case Study** and **Member Copyright agreement**
are requirements only, never evidence that an agreement was signed or completed.
Contributor values and historical aliases are documented in the workbook.
Formulas anywhere in the workbook are rejected. Expanded ZIP contents are
limited to 10 MB before spreadsheet parsing.

## Duplicate and recovery rules

An existing normalized-title match skips only when every mapped value is
identical. Changed or ambiguous matches block confirmation. Existing briefs
are never overwritten. No global title-uniqueness constraint is added to manual
brief creation.

Preview plans are signed, actor/tenant-bound and expire after 30 minutes.
Confirmation rechecks current permissions, settings and identities.
The complete bounded batch runs in one database transaction: any failure
rolls back all new rows, activity entries and the receipt. There is no partial
success to silently ignore. A committed receipt is returned on same-plan retry,
including after expiry; current authorization is still required.

If the connection is interrupted, use **Retry same import** while the page is
open. Do not assume an unsuccessful HTTP request means no commit occurred.
Closing/reopening the dialog keeps the plan in memory; refreshing the page
discards it. After a refresh, upload and preview the same unchanged workbook:
committed identical rows will be skipped, not duplicated. If a separate import
or manual edit changed the reviewed state, make a fresh preview.

No assignment emails, notifications or generic creation workflows are invoked.
Creation attribution is recorded in brief activity. The transaction rejects
unexpected non-internal triggers on the brief/activity tables rather than
assuming those triggers have no side effects.

## Implementation and rollout

- API: `/api/article-briefs/publication-import`, GET template and POST
  preview/apply. The exact handler works through the development adapter and
  Vercel filesystem routes; the existing 60-second API limit applies.
- Parser: `api/_lib/publicationWorkbook.js`.
- Service: `api/_lib/publicationImportService.js`.
- SQL: `supabase/migrations/20261125_publication_import.sql`.
- UI: `client/src/components/PublicationImportControls.jsx`.

The service-only snapshot uses complete, explicitly bounded tenant lookup sets.
Tenants exceeding 10,000 rows in any supported lookup fail with an explicit
limit error, never an incomplete identity resolution. Confirmation briefly locks
brief writes and relevant authority tables to prevent validation/write races.
This is deliberately bounded interactive import, not a background bulk loader.

The SQL migration is **required and outstanding on DEST**. It has only been
applied to disposable local PostgreSQL test fixtures. **No shared database,
SOURCE or production database was changed. No deployment was performed.**

After separate owner approval, review the offline hash:

```sh
node scripts/apply-publication-import-migration.mjs
```

Then apply that exact reviewed hash with `--apply --review-sha256=<hash>`.
The runner verifies the existing DEST target and TLS, runs transactionally and
checks service-only RPC/receipt privileges. Never substitute workspace
`DATABASE_URL`/SOURCE. Apply the migration before releasing matching code.
The signing key uses the configured service key unless a dedicated
`PUBLICATION_IMPORT_SIGNING_KEY` is supplied; rotating it invalidates outstanding
preview tokens, not stored receipts.

## Local verification

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/publicationImportService.test.mjs
node scripts/run-isolated-tests.mjs node --test api/_lib/publicationWorkbook.test.mjs api/_lib/publicationImportTransport.test.mjs client/src/components/publicationImportModel.test.mjs scripts/apply-publication-import-migration.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test server/vercel-api-adapter.test.ts
npx playwright test --config=tests/publication-import.config.mjs
```

These checks use synthetic identities/workbooks and disposable PostgreSQL.
They are not production verification, a real staff session, or a re-run of
historical GFI imports. Browser fixtures similarly do not establish live tenant
schema, role or data correctness.
