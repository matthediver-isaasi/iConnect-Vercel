# Central Tenant Cookie Consent

**Author:** Replit Agent  
**Last Updated:** November 2026  
**Module:** Privacy and tenant settings

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [SDK contract](#sdk-contract)
4. [Tracking and integration audit](#tracking-and-integration-audit)
5. [Release gates](#release-gates)
6. [Verification](#verification)
7. [Maintenance](#maintenance)

## Overview
CookieYes remains the consent engine. The official MIT React and scripts packages are pinned; no hosted account, paid scanner or replacement decision store is introduced. Configuration uses existing tenant settings and platform preferences. Audit records carry no member ID or retained IP address.

This work is not production rollout evidence. No migration or tenant activation is authorised by merging code. Optional analytics defaults off. A platform owner must select approved pilot IDs and enable rollout separately.

## Architecture
| File | Purpose |
|---|---|
| `shared/cookieConsent.js` | Four-category contract and setting validation |
| `scripts/patch-cookieyes.mjs` | Approved pinned core isolation extension |
| `client/src/components/CookieConsent.jsx` | SDK lifecycle |
| `client/src/lib/consentTracking.js` | Google defaults, page views and withdrawal |
| `api/public/cookie-consent.js` | Fresh host-bound config and record ingress |
| `api/_lib/cookieConsentSettings.js` | Privileged tenant/platform settings |
| `api/platform/cookie-consent-retention.js` | Owner-only bounded cleanup |
| `supabase/migrations/202611020001_cookie_consent.sql` | Audit, rate budget, protected config writes and retention |
| `client/src/components/admin/CookieConsentSettings.jsx` | Inheritance, rollout and isolated preview |
| `client/public/cookie-declaration.html` | Maintained declaration |

## SDK contract
Verified packages: React 0.13.3, scripts 0.3.0, core 0.12.0. Official installation and self-hosted documentation were reviewed. The four explicit categories replace the SDK defaults rather than treating performance/advertisement as extra permissions.

The owner approved minimal changes for storage isolation and disposal. The transport object's `storageScope` is captured per manager and queue. Policy fingerprints become part of that scope. The patch also tolerates denied browser cookie access so opaque-origin previews remain usable. Decisions, category state, payloads, queue limits and interface still belong to CookieYes.

Failed deliveries retain at most ten records for seven days. Reset disposes timers and online listeners; already-dispatched requests may still complete against their original endpoint. Server records are insert-only by tenant/record ID. This is not indefinite or guaranteed audit delivery. Stale policy records are rejected rather than re-labelled as current policy.

## Tracking and integration audit
- Existing TenantBranding GA4 injection and its navigation effect are disabled; App no longer mounts Vercel Analytics.
- Existing GA4 measurement IDs remain in tenant settings and are read-only in the new UI.
- Basic mode is selected explicitly; defaults are bootstrapped before SDK integration execution. Page views use explicit `send_to` and disabled initial automatic page views.
- Withdrawal sets the Google disable flag, removes known first-party analytics storage, and reloads after the decision can enter the SDK queue. Script removal alone is not considered teardown.
- Event-card clicks read the SDK's committed analytics state through the legacy hook adapter.
- Canvas provider videos, IEdit videos and resource video frames require Functional consent. Hosted MP4 content is not automatically classified as advertising.
- Session/authentication, form submission and requested Stripe/GoCardless payment paths are not gated by optional categories.
- Authored HTML, AI compositions, SSR-rendered embeds and additional external providers require explicit review: a maintained inventory is not an automatic scanner. The static-page sanitizer excludes scripts and iframes; AI inspector previews use a script-disabled sandbox; same-platform form embeds remain essential and are not blocked by Functional consent. Canvas SSR uses deferred video surfaces rather than preloading the provider.

## Release gates
1. Complete automated lifecycle, endpoint, disposable PostgreSQL and browser network verification before approval.
2. Review the exact migration and apply only to the verified destination project, never the workspace's legacy source database.
3. Keep `enabled=false` and the pilot list empty until a named tenant is explicitly approved. BNMS is a suggestion, not approval.
4. Verify the deployed bundle and migration on that tenant's real custom domain and subdomain; test a separate browser profile, rejection, granular preferences, withdrawal, refresh, SPA navigation and cross-tenant contexts.
5. Use Google Tag Assistant and real network inspection to confirm no cookieless pings before consent or after withdrawal. Disable GA Enhanced Measurement history page views in the property when explicit SPA events are used, then verify exactly one event per route.
6. Verify login, forms, renewal, Stripe, GoCardless and tickets without making live provider/payment writes unless separately authorised.
7. Only approve additional tenants after recording pilot evidence. Platform-wide enablement still uses the explicit tenant list.

Rollback: set platform `enabled=false` or remove the pilot ID. Never restore the former uncontrolled GA4 or Vercel loaders. Existing open pages recheck configuration on focus and at one-minute intervals; serverless config reads are uncached.

## Verification
`npm run test:cookie-consent` selects the consent suite through the real regression runner. It covers SDK namespacing, revision re-consent, bounded retries/disposal, host spoofing, record validation, adapter defaults, mounted settings and disposable PostgreSQL RLS, deduplication, settings guards, rate budget and retention.

`npm run test:cookie-consent:browser` runs isolated browser fixtures. In this Nix workspace, use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium)` when the downloaded Playwright browser lacks shared libraries. Preview is bundled as a self-contained document so the sandbox never needs cross-origin module loading.

The destination-pinned migration runner is `node scripts/apply-cookie-consent.mjs`. It is an offline dry-run unless supplied both `--apply` and the exact reviewed `--review-sha256=...` value. Do not run apply without explicit approval.

Passing fixtures are not deployed, authenticated or provider evidence. The fixture form demonstrates that the consent lifecycle does not gate ordinary submission, not that a live renewal or provider checkout was executed. Signed-in settings UI and real provider journeys remain part of the explicitly approved pilot checklist.

The November 2026 repository security scan reported pre-existing dependency risks (1 critical, 75 high, 87 moderate, 13 low), including a critical proxy-addr IP-spoofing advisory. No CookieYes dependency findings were returned. The privacy scanner reported 2 critical, 15 medium and 202 low findings across the repository; none matched the new consent modules. These repository-wide findings were not remediated by this feature and the project must not be described as security-certified.

The static scanner returned `incomplete:true` with no results; this is not a passing static scan. Critical privacy findings concern password output in `scripts/create-platform-owner.js` and auth-token local storage in `client/src/pages/FundraiserDashboardPage.jsx`, outside this implementation.

## Maintenance
Before adding any browser-storage or script integration:
1. Identify its actual purpose and whether it runs before a visitor requests it.
2. Declare identifier/provider, purpose, category, lifetime and tenant applicability.
3. Gate optional execution before rendering/loading, not using a post-load DOM observer.
4. Supply tested withdrawal behaviour and first-party storage cleanup.
5. Bump policy revision for changed purposes; preserve essential login/payment behaviour.
6. Test rejected and unavailable-configuration states, update the declaration and obtain release approval.

Upgrade CookieYes only after reviewing the isolation patch against the upstream contract and rerunning mounted/browser tests. Do not remove version pins to make a failed patch install succeed.
