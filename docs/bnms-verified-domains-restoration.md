# BNMS Verified Domains restoration

## Production evidence — 12 November 2026

- Verified destination: `lvmzliemqnieeoruhkik`; tenant
  `ff2df806-b321-4254-b651-3af11fccf1db`, slug `bnms`, name `BNMS`.
- Before: no BNMS field matching a domain name or label, including inactive
  or differently scoped definitions. Two other tenants had active
  `verified_domains` organisation fields of type `list`.
- BNMS had a saved organisation layout and no organisation field-visibility
  rules. The layout merger automatically adds unassigned active custom fields
  to **Custom Fields**, so no layout write was required.
- Applied one optional active list field, ID
  `daf0ddcb-6007-4a21-aec3-38e577b4ff4c`, internal name `verified_domains`,
  label **Verified Domains**. Admin columns/filters are enabled; member-facing
  organisation and directory display are not enabled.
- Applied snapshot SHA256:
  `1d5a104eb060849360d702545f39637e6476c536fb179f0af555af6384a11f35`.
- Fresh read-only verification found the one active field and zero saved
  organisation values. No other tenant, existing field, layout, domain value,
  guest setting, form, application, or outbound-email configuration was changed.

## Maintenance

In BNMS, open **CRM → Organisations**, open an organisation, then on
**Overview** choose **Edit**. Find **Custom Fields → Verified Domains**.
Enter each approved bare email domain (for example `example.org`, not a URL or
email address), click **Add**, then **Save**.
Maintain the definition at **Custom Fields → Organisation Fields**.
Keep its internal name exactly `verified_domains`, its scope Organisation,
and its status active.

The field is intentionally empty until administrators supply authoritative
domains. Adding it does not derive domains from organisation websites.
An empty list retains the existing registration rejection unless the existing
guest-access exception applies. Matching is exact and case-insensitive;
subdomains are not implicitly approved.

## Reproduction and boundaries

`node scripts/restore-bnms-verified-domains.mjs` is a destination-pinned,
read-only preflight. `--apply --review-sha256=<fresh hash>` applies the narrow
repair under a serializable transaction and table lock; an already-active
definition is a no-op. Ambiguous definitions or visibility rules stop it.
It never writes organisation preference values.

`node scripts/run-isolated-tests.mjs node --test scripts/bnms-verified-domains.test.mjs`
exercises the actual public handler, backend lookup/guest-context functions,
frontend domain validator, and layout merger against isolated fixtures.
These checks are not live applications or authenticated production UI tests.
No production sign-in, submission, account creation or email was attempted.
No application deployment is needed for this configuration repair.
