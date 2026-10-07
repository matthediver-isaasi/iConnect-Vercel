# BNMS Autumn Meeting 2026 — one-off certificate issuance

## Outcome

- DEST only: `lvmzliemqnieeoruhkik`; SOURCE untouched.
- Simple event: `66050b3c-aa70-4174-8552-0a2af85e5410`.
- 38 deduplicated referenced speakers, 36 eligible persisted member owners,
  36 issued private certificates, 2 unlinked skipped, 0 final issuance failures.
- All 36 PDF byte hashes and member-history entries verified. All recipient
  names and original 24–25 September meeting content verified in the PDFs.
  A representative PDF was rendered and visually inspected.
- Real history/certificate handlers against DEST, using injected identities:
  33 owner successes and 33 wrong-recipient denials; anonymous access denied.
- Three existing access restrictions remain: two members have CPD access
  excluded; one has no role. Their certificates exist, but current authorization
  correctly blocks retrieval. No roles or access policies were changed.
- No authenticated browser session was available; these are not browser tests.
- A repeat `--execute` issued zero certificates and preserved all recognition
  records and original artifacts.
- No migrations needed, applied, or outstanding for issuance. No deployment,
  global cutoff change, event date edit, marker reset, grant creation or
  notification sweep was performed.

## Evidence and limits

Private manifest, baseline digests, reports, PDF files and content extraction
are under ignored `private/bnms-speaker-certificates/` (not committed).
`initial-issuance-report.json` retains the first successful result.
The first two attempts rolled back before any recognition committed because
the Storage SDK wrapped the explicit NoSuchKey response. The runner normalizes
only that exact response; it does not treat arbitrary errors as absent objects.

Issuance-time before/after tenant digests matched for grants, member badges,
vouchers and available inbox state tables. Expanded replay evidence also covers
the points ledger, attendee certificate deliveries, transactional messages,
CPD award queues and local invoice-link tables. Those expanded tables were
not captured before the original issuance, so replay evidence must not be
represented as original-run before/after proof.

The live recognition table has only the snapshot-protection update trigger;
the pinned finalizer calls reconciliation, whose pre-cutoff branch performs
revocation checks and returns before awards or event marker updates. The runner
has no payment, points, email, notification or attendee-certificate write path.
No external accounting/mail-provider log audit was performed.

## Operational boundaries

`node scripts/bnms-speaker-certificates.mjs --preview` is read-only.
`--execute` requires the exact hardcoded reviewed manifest hash; `--verify`
requires all approved recipients already issued. The event, tenant, template,
configuration, persisted ownership, policy and live function definitions are
revalidated. This is not a configurable retrospective feature or public bypass.

Each missing recipient uses a deterministic UUID/artifact key. Rendering happens
before the transaction. Short SHARE table locks prevent ownership/configuration
phantoms while the event row and normal recognition advisory lock serialize
insertion/finalization. These table locks can briefly block unrelated edits;
lock timeout is 5 seconds and network requests time out after 15 seconds.
The unique recognition constraint remains in place. Unexpected existing rows
stop the operation rather than being overwritten or adopted.

The unchanged certificate pipeline performs create-only private storage uploads
and ordinary finalization through a same-transaction SQL adapter. A crash after
upload reuses the original bytes at the deterministic key. Issued rows are
verified and skipped without invoking finalization.

Checks:

```sh
node --test scripts/bnms-speaker-certificates.test.mjs \
  api/_lib/speakerRecognition.test.mjs api/_lib/speakerAwardHistory.test.mjs
node scripts/bnms-speaker-certificates.mjs --verify
node scripts/verify-bnms-speaker-access.mjs
uv run python scripts/verify-bnms-speaker-pdfs.py
```

PDF inspection requires PyMuPDF in the local Python environment. Private
evidence is required for the live checks; do not regenerate approval on drift.
