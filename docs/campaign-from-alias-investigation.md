# Task 516 — Campaign "on behalf of" From-line investigation

## TL;DR

The "messy" Gmail header is **not** a deliverability or DMARC failure — it is Gmail's
standard cosmetic indicator that the message has a `Sender:` header on a
different domain than the visible `From:` header. It is triggered for **every
tenant whose configured Mailgun sending domain is a subdomain (e.g.
`mail.<tenant>.org`) but whose campaign From address is on the bare root
(`<tenant>.org`)**. The classic example is Graduate Futures Institute, but the
same misalignment already exists for Global Schools Forum and will exist for
any future tenant that BYOs a custom domain at `mail.*` but wants to send "from
the bare root".

DMARC alignment actually *passes* (DKIM relaxed-aligns because both hosts
share the organisational domain `graduatefutures.org`), so the only fix needed
is to remove the `Sender:` header — by either (a) making the From address live
on the verified sending subdomain, or (b) verifying the bare root in Mailgun
and switching the envelope sender to it.

---

## 1. Send-path code trace

For a campaign send the path is:

`api/email-campaigns/send.js`
→ `campaignService.sendCampaign` → `sendCampaignBatch` → `sendCampaignToRecipient`
→ `emailService.sendEmail`
→ `mailgun.messages.create(<sending_domain>, messageData)`

Two values flow through that matter:

1. **`from` (visible `From:` header)** — assembled in
   `campaignService.js:1853` as
   ``` js
   from: campaign.from_name
     ? `${campaign.from_name} <${campaign.from_email}>`
     : campaign.from_email
   ```
   It comes verbatim from the `email_campaign.from_name` / `email_campaign.from_email`
   columns. The same expression is used in `api/email-campaigns/test-send.js:172`.

2. **`<sending_domain>` (Mailgun routing/auth domain — i.e. envelope sender,
   DKIM `d=`, webhook source)** — chosen inside `emailService.sendEmail`
   (`api/_lib/emailService.js:228-241`). It pulls
   `tenantConfig.domain` from `tenant.settings.email_domain.domain` (only when
   that block has `status === 'verified'`); otherwise it falls back to
   `mail.iconn.app`. The caller's `from` argument is **passed through unchanged**
   even if it's on a totally different domain.

3. **No validation anywhere** ensures the campaign's stored `from_email` is on
   that verified sending domain. The campaign-edit screen
   (`client/src/pages/EmailCampaignEdit.jsx:657-665`) is a free-text input with
   no domain check, and the `email_campaign` upsert has no server-side guard.

So if the tenant edits the From email to `hello@graduatefutures.org`, that
goes out as the `From:` header while Mailgun still uses
`mail.graduatefutures.org` as the envelope/DKIM domain.

## 2. Stored campaign + tenant settings

Data pulled live from the dev Supabase at investigation time:

### Tenant `gfi` — `tenant.settings.email_domain`

```json
{
  "domain":      "mail.graduatefutures.org",
  "is_custom":   true,
  "status":      "verified",
  "from_email":  "noreply@mail.graduatefutures.org",
  "from_name":   "Graduate Futures Institute",
  "verified_at": "2026-03-26T13:26:36.323Z"
}
```

### Most recent gfi campaigns (`email_campaign`)

| name | from | reply_to | status |
| ---- | ---- | -------- | ------ |
| Heads of Service - 24.4.26 | `Graduate Futures Institute <hello@graduatefutures.org>` | hello@graduatefutures.org | sent |
| Annual Conference flexible tickets | `… <hello@graduatefutures.org>` | hello@graduatefutures.org | sent |
| Heads of Service - 10.4.26 | `… <hello@graduatefutures.org>` | hello@graduatefutures.org | sent |
| Academic Employability Awards 2026 | `… <hello@graduatefutures.org>` | hello@graduatefutures.org | sent |

→ Every campaign has been overridden to the **bare root** address
`hello@graduatefutures.org`, even though the tenant's verified Mailgun domain
is the subdomain `mail.graduatefutures.org`.

So the actual Mailgun call for these is effectively:

```js
mailgun.messages.create('mail.graduatefutures.org', {
  from: 'Graduate Futures Institute <hello@graduatefutures.org>',
  ...
})
```

## 3. What actually leaves Mailgun

The Mailgun account confirms `mail.graduatefutures.org` is the only verified
domain for that tenant (`bare graduatefutures.org` is **not** verified in
Mailgun). The Mailgun events API on this environment doesn't have read scope
for that domain, so I couldn't fetch a raw stored message; however Mailgun's
behaviour with the call above is fully deterministic and matches the header
shown in the user's screenshot:

| Header                    | Value                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| `From:`                   | `Graduate Futures Institute <hello@graduatefutures.org>`             |
| `Sender:` (added by MG)   | `hello=graduatefutures.org@mail.graduatefutures.org`                 |
| `Return-Path:` (envelope) | `hello=graduatefutures.org@mail.graduatefutures.org` (VERP-encoded)  |
| `DKIM-Signature: d=`      | `mail.graduatefutures.org` (signed with `mta._domainkey` / `s1._domainkey`) |
| Reply-To                  | `hello@graduatefutures.org`                                          |

The `localpart=domain@sending-subdomain` form in `Sender:` / `Return-Path:`
is Mailgun's signature variable-envelope-return-path encoding — and is exactly
the string that appears in the user's Gmail screenshot
(`hello=graduatefutures.org@mail.graduatefutures.org`).

### DNS confirms the picture

Live `dig`-equivalent lookups:

```
graduatefutures.org              TXT  "v=spf1 include:spf.protection.outlook.com include:spf.mailanyone.net include:mailgun.org -all"
_dmarc.graduatefutures.org       TXT  "v=DMARC1; p=none;"
mail.graduatefutures.org         TXT  "v=spf1 include:spf.protection.outlook.com include:spf.mailanyone.net include:mailgun.org ~all"
_dmarc.mail.graduatefutures.org  TXT  "v=DMARC1; p=none; pct=100; ..."
mta._domainkey.mail.graduatefutures.org  TXT  k=rsa; p=...   (Mailgun key – present)
s1._domainkey.mail.graduatefutures.org   TXT  k=rsa; p=...   (Mailgun key – present)
mta._domainkey.graduatefutures.org       NXDOMAIN
s1._domainkey.graduatefutures.org        NXDOMAIN
graduatefutures.org              MX   graduatefutures-org.mail.protection.outlook.com (50) + MailAnyone fallbacks
mail.graduatefutures.org         MX   mxa/mxb.eu.mailgun.org
```

Key consequences:

* **SPF on the bare root already authorises Mailgun** (`include:mailgun.org`),
  so an envelope sender on `graduatefutures.org` would pass SPF — but Mailgun
  isn't using the bare root as MAIL FROM today.
* **No DKIM key exists on the bare root** (`*._domainkey.graduatefutures.org`
  is NXDOMAIN), so DKIM signing is currently only possible with
  `d=mail.graduatefutures.org`.
* **The bare root is the tenant's primary mail-receiving domain**
  (Outlook / MailAnyone), so we cannot just point its MX at Mailgun — the
  subdomain isolation was the right call.

### DMARC alignment

Even with the current setup:

* **DKIM relaxed alignment**: `From: graduatefutures.org` ↔ `d=mail.graduatefutures.org`
  → both reduce to the org domain `graduatefutures.org` → **PASS**.
* **SPF relaxed alignment**: MAIL FROM `mail.graduatefutures.org` ↔
  `From: graduatefutures.org` → org domains match → **PASS**.
* DMARC verdict: **PASS** (`p=none` anyway, so no enforcement action even if it
  failed).

So this is **not a deliverability bug** — campaigns reach the inbox. The
"messy" line is purely Gmail's UI rendering of the `Sender:` header, which it
shows whenever Sender ≠ From at the FQDN level, regardless of DMARC alignment.

## 4. Is this tenant-specific?

No. The same misalignment is already present for at least one other tenant:

| tenant | verified Mailgun domain                  | latest campaign From                                   | aligned? |
| ------ | ---------------------------------------- | ------------------------------------------------------ | -------- |
| gfi    | `mail.graduatefutures.org`               | `hello@graduatefutures.org`                            | **NO**   |
| gsf    | `community.globalschoolsforum.org`       | `community@globalschoolsforum.org`                     | **NO**   |
| mts    | `mts.iconn.app`                          | (no campaigns yet)                                     | n/a      |
| teeone | `teeone.iconn.app`                       | (no campaigns yet)                                     | n/a      |
| bnms   | `bnms.iconn.app`                         | (no campaigns yet)                                     | n/a      |

The pattern: any tenant who **brings their own corporate domain and verifies
a `mail.<root>` (or `community.<root>`, etc.) subdomain in Mailgun** can — and
typically does — type their pretty bare-root address (`hello@<root>`) into the
campaign From field, which produces the Gmail "on behalf of" UI on every
send. Tenants on the auto-provisioned `*.iconn.app` subdomain don't hit it
because their visible From address sits on the same domain Mailgun is sending
from. So this is a **system-wide pattern that surfaces for every BYO-domain
tenant**, not a one-off configuration mistake on Graduate Futures.

## 5. Fix options

### Option A — Force the campaign From onto the verified sending subdomain

* **Behaviour**: at send time (and/or at save time on the campaign editor),
  rewrite/reject any `from_email` whose host is not the verified
  `tenant.settings.email_domain.domain`. e.g. transparently rewrite
  `hello@graduatefutures.org` → `hello@mail.graduatefutures.org`, or just
  block save with a clear validation error and a dropdown of allowed
  hostnames. Reply-To stays on the bare root so replies still land in the
  tenant's normal inbox.
* **Pros**: zero DNS work, zero Mailgun work, zero tenant onboarding change.
  Solves the cosmetic problem on **all** tenants in one code change. Sender ==
  From, so Gmail drops the "on behalf of" notice immediately.
* **Cons**: the visible From address changes from `hello@graduatefutures.org`
  to `hello@mail.graduatefutures.org`. Some tenants will dislike the cosmetic
  `mail.` in the From line. If we silently rewrite, recipients who hit "Reply"
  might still land on the bare root (we can preserve that via `Reply-To`), but
  any address-book entries / contact lookups will key on
  `hello@mail.graduatefutures.org`. If we hard-block instead of rewriting, the
  tenant must re-author their campaigns and accept the new address.

### Option B — Verify the bare root in Mailgun and switch sending to it

* **Behaviour**: add `graduatefutures.org` (and equivalents for other tenants)
  as a second verified domain in Mailgun, configure DKIM keys + SPF (already
  there) + DMARC at the root, and change the per-tenant
  `email_domain.domain` to the bare root so envelope/DKIM/`From` all align.
* **Pros**: keeps the pretty bare-root From address. Sender header disappears
  entirely (Mailgun only adds it when the From host doesn't match the sending
  domain). Best aesthetic outcome for the tenant.
* **Cons**:
  - Requires the tenant to publish DKIM TXT records (and tighten SPF/DMARC) at
    the **bare root** zone, which is the same zone that already hosts their
    primary MX (Outlook / MailAnyone) and SPF record. Coordination risk —
    a fat-fingered SPF replacement could break their corporate mail.
  - The bare root's MX still has to stay pointed at Outlook/MailAnyone, so we
    can only verify it for **sending** in Mailgun (Mailgun verification of a
    domain that doesn't have MX pointed at it works, but it's a slightly more
    advanced flow than the current `mail.*` template).
  - Tenant onboarding becomes more complex: instead of "create a `mail.`
    subdomain and CNAME/TXT it to us", every BYO-domain tenant now has to add
    DKIM and adjust SPF on the apex of their existing corporate domain.
  - Doesn't help legacy/auto-provisioned `*.iconn.app` tenants if they later
    want a custom From (no-op for them — they're already aligned).

### Option C — Add DKIM signing on the parent domain only

* **Behaviour**: ask Mailgun to also sign with a key whose `d=` is the bare
  root (`d=graduatefutures.org`), while still routing through the
  `mail.graduatefutures.org` subdomain.
* **Pros**: would give DKIM **strict** alignment with the bare-root From.
* **Cons**: this **does not fix the user-visible problem.** DMARC already
  passes today via relaxed alignment, and Gmail's "on behalf of" notice is
  driven by the `Sender:` header / Return-Path host, not by DKIM `d=`. Adding
  a second DKIM key would not remove the `Sender:` header — Mailgun adds it
  whenever the message's envelope domain differs from the From header host,
  full stop. So this option is, strictly speaking, a no-op for the symptom in
  the screenshot. Not recommended.

## 6. Recommendation

**Adopt Option A as a system-wide guard, with Option B as an opt-in upgrade
path for tenants who really want their bare root in the From line.**

Concretely, in a follow-up implementation task we would:

1. Add a small helper (e.g. `validateCampaignFromAddress(tenantId, email)`)
   that resolves the tenant's verified `email_domain.domain` and rejects /
   normalises any `from_email` whose host isn't that domain (or one of
   Mailgun's other verified domains for that tenant). Use it in:
   - the campaign edit screen as inline validation,
   - the `email_campaign` upsert API, and
   - `sendCampaignToRecipient` / `test-send` as a hard server-side guard.
2. Default the `from_email` field for new campaigns to
   `tenant.settings.email_domain.from_email` (currently
   `noreply@<verified-domain>`) instead of leaving it blank, and surface the
   verified domain in the helper-text under the input.
3. Keep `reply_to` unrestricted (the bare-root reply target is what tenants
   actually care about for replies).
4. Document Option B in the tenant onboarding docs as the way to send
   "from the bare root" — but only enable it per-tenant once they've added
   the required DKIM TXT records on the apex zone.

This restores the clean Gmail header for every existing BYO-domain tenant
(gfi, gsf, and any future ones) without any DNS/Mailgun changes, and gives
us a clear, opt-in path for tenants who insist on the bare-root From later.

## Out-of-scope reminder

Per the task brief, no code, DNS, Mailgun, or campaign-row changes were made
during this investigation. A separate implementation task should be created
once a direction is approved.
