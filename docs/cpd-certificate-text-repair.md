# Certificate authored-text persistence — 28 October 2026

## Live evidence and target

- Vercel project `prj_iPFlb9rOOVNVtbobMRR1vyV934lf` lists
  `www.bnms.org.uk` and `bnms.org.uk` on production deployment
  `dpl_XjeGmFSoDbHqxXipVM28g5k1o5Bd` (READY, commit
  `2814c210618ad86256822c2bec6089af828ec9c2`).
- The public site's index bundle (`index-Dp5kK2mT.js`) references DEST
  `lvmzliemqnieeoruhkik.supabase.co`. Its certificate designer chunk
  `CPDCertificateTemplates-BJFn_BWd.js` does **not** contain the pre-existing
  authored-text implementation (`text_template`); this custom-domain build
  is older than the workspace implementation. This does not establish which
  hostname/build the original reporter used.
- Destination SQL was accessed with the existing destination-only connection,
  project identity pins and verified TLS using Supabase's public root CA.
  SOURCE was not queried or changed. Supabase MCP discovery omitted DEST and
  the direct MCP query was denied; the separately configured DEST SQL
  connection worked.
- Template `03af5d79-33bd-4137-b351-c8c193e65703` was found on DEST:
  tenant `ff2df806-b321-4254-b651-3af11fccf1db`, draft, version 3.
  Its `text.6ca3f824-21ec-46c7-ab08-67e0acb283ff` block had an empty sample
  and null default. The authored-text column was absent.
  The save function was the original projection, missing all three
  authored-text additions. Thus this was a missing migration, not merely
  a browser serialization defect.

## Applied database repair

Using `node scripts/repair-cpd-certificate-text.mjs --apply`:

| Migration | SHA256 |
| --- | --- |
| `20261027_cpd_certificate_authored_text.sql` | `5be9213bb9c1fa845d710ab49eda2a1ac2ebbb2aa61e9c6439904d96475e6dcc` |
| `20261028_cpd_certificate_checked_save.sql` | `4d76de738b90bd5f2c73040a5e4ba2bbf2c1f0a9aa79e4d5071b1a220ce97973` |

After application, the column, INSERT projection, SELECT projection,
recordset declaration and checked-save RPC were all present.
The original save function definition hash changed from
`b15c365517a3bafc7f0dcee1dba7691ee40399bcfd955fc4b5facd0fb8bce583`
to `c71bf54d777849c13a5c9127aa38a55635af8afa33fdcfe8237814761a838754`.
No tenant template rows were rewritten; no certificates were issued or sent.

The new API entry point fails before writing if its RPC is absent. The
checked RPC verifies text persistence within the save transaction; differences
raise an exception, rolling back both version and child replacement. It
delegates existing tenant/version/lifecycle enforcement to the original RPC.
The browser also rejects incomplete success responses and keeps its draft.

## Recovery boundary

No original wording was present in the affected row's sample/default fields,
and a repository search for the template/block IDs found no retained payload.
No certificate-template revision history is implemented in the inspected
save path. Provider backups and the reporter's still-open browser were not
available as recovery evidence; their contents are not assumed.

The example sentence is **not** proof of the original wording. The affected
template remains unchanged pending verified wording from the user. The editor
now identifies a lost authored block explicitly, offers an empty text editor,
and never inserts guessed text. A subsequent recovery must reload the current
version and use the normal guarded save; do not overwrite version 3 blindly.

## Verification

- Disposable PostgreSQL: real migrations, add/save/read/edit/copy, stale
  function rollback, missing-column rejection, optimistic conflict, legacy
  standalone field and service-only grants.
- API fixtures: missing RPC/column/stale projection return actionable failure;
  successful edit, GET and whole-template duplicate retain text.
- Browser: 9 isolated Playwright tests, including save/reopen/block duplicate,
  schema failure and silent-success draft retention, lost-text recovery,
  portrait/landscape, mobile, active preview and legacy points styling.
- PDF.js extraction: exact example sentence with 8, 6.5 and 0 points at
  wide/narrow widths. Legacy standalone points still include their suffix.
- Commands:
  `node --test api/_lib/cpdCertificateCheckedSave.test.mjs api/_lib/cpdCertificateInlineText.test.mjs api/_lib/cpdCertificateInlineText.postgres.test.mjs`
  and `npx playwright test --config playwright.cpd-text.config.mjs`.
  Existing access/PDF regressions also passed.
- Ordinary app screenshot reached the unsigned loading/auth path, not the
  authenticated designer. Signed-in live BNMS UI and a live test-PDF request
  were **not** verified. Browser/PDF tests used isolated fixtures, not tenant
  writes or live issuance.

## Remaining release actions

The database migrations are applied; no SOURCE migration is needed.
Matching editor/API code must reach the serving application after merge.
No application deployment was performed in this task. Verify the actual
reported hostname's signed-in save/reopen/test-PDF flow after that release.
Restore the affected sentence only after verified wording is supplied.
