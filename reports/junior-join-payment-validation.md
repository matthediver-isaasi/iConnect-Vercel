# Junior join payment validation — 2026-09-21

## Confirmed cause

Read the saved BNMS “Full member junior join v2” configuration and related
records through the production DEST Supabase client, without writes.
The trust field is a dynamic `organisation_group_dropdown` with `options: []`
and an exclusion rule. Server conditional filtering did not classify this
field as dynamic. It intersected the selected trust with the empty static
option universe (plus Not listed), rejecting the valid Ashford and St Peter's
trust before department validation.

The live guest browser request contained Department `[]`, not a no-relationship
sentinel. St Peter's Hospital belongs to the selected trust. Its department
picker returned one active option: Radiology based Nuclear Medicine.
An independent initialization edge case was also reproduced: the same optional
multi-select represented as `""` failed mode validation. Empty string now
counts as empty before the mode check; nonempty scalar record IDs still fail.

## Changes and safeguards

- Recognize group dropdowns as dynamic option sources when static options are
  empty. Existing exclusion and tenant membership validation still apply.
- Accept blank relationship answers consistently without accepting any new
  record ID, sentinel, wrong-parent edge, archived record or foreign tenant.
- Quote-key regressions confirm site, department and other-sites visibility
  corrections change the key without changing membership mappings. No quote
  cache code change was necessary.

## Verification boundaries

- 175 focused isolated tests passed across the new BNMS fixture and existing
  conditional filter, relationship, payment, submission and quote suites.
- Reproduced the live error as an unauthenticated guest at
  `https://www.bnms.org.uk/FormView?slug=full-member-junior-join-v2`.
- Passed the exact browser-captured quote request into the patched local
  handler using read-only DEST data: HTTP 200, GBP 128.
- Ran the deployed guest page and real pickers with **only the quote endpoint
  intercepted by the local patched handler**. The payment step displayed
  £128 and the full-payment/monthly-card/Direct-Debit options. This is a hybrid
  browser check, **not evidence that the fix is deployed**.
- The browser script blocks payment creation and final submission. No real
  payment, pending checkout, membership, or form submission was created.
- The pretty `/full-member-junior-join-v2` route showed “Page unavailable”;
  the explicit FormView route worked. This separate routing issue was not changed.
- Local workflow starts on port 5000, but its existing legacy SOURCE/default
  tenant configuration produces “Tenant not found”; it was not repointed.

Reproduce safely with:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(which chromium)" \
  node scripts/verify-junior-join-guest.mjs --local-quote
```

Omit `--local-quote` to check deployed behavior after rollout. The script uses
synthetic guest details and never clicks a payment method or submits the form.

## Database and rollout

No migration or data repair is required. None was applied to DEST, SOURCE, or
any other database. SOURCE was not changed. Deploy the code before expecting
the live endpoint to accept the corrected flow.