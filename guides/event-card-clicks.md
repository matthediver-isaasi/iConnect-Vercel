# Event Card Click Tracking

**Author:** Engineering  
**Last Updated:** October 2026  
**Module:** Events / engagement analytics

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Core Logic](#3-core-logic)
4. [Configuration / Settings](#4-configuration--settings)
5. [Code Paths / Entry Points](#5-code-paths--entry-points)
6. [Safeguards and Error Handling](#6-safeguards-and-error-handling)
7. [Frontend UI](#7-frontend-ui)
8. [Database Tables](#8-database-tables)
9. [Data Flow Diagrams](#9-data-flow-diagrams)
10. [External Integrations](#10-external-integrations)
11. [Configuration Reference](#11-configuration-reference)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Overview

Event-card click tracking records a CTA activation from the Events listing.
It measures a browser, not a person: a tenant-scoped UUID is kept in
`localStorage`, and the database stores only a server-derived HMAC of that
UUID. A unique key counts one browser at most once per event and tenant; the
stored data contains no member, email, cookie, or raw network identifier.

The feature has two explicit gates. `Events.jsx` is the only page that enables
the tracking hook, and accepted cookie consent is required before storage is
read or written or a request is sent. If storage is unavailable, tracking opts
out instead of using a temporary identifier. Requests are fire-and-forget so
analytics cannot block CTA navigation.

Counts are aggregate-only and are read through an authenticated admin API.
Postgres tables and functions are restricted to `service_role`. The release
migration creates empty tables for future clicks; it performs no backfill.

---

## 2. Architecture

### Key Files

| File | Purpose |
|------|---------|
| `client/src/pages/Events.jsx` | Sole page-level opt-in, CTA wiring, count query, and count access gate. |
| `client/src/components/events/EventCard.jsx` | CTA instrumentation and aggregate metric. |
| `client/src/hooks/useEventClickTracking.js` | Consent/enabled gate, click sender, and count query hook. |
| `client/src/lib/eventClickTracking.js` | Tenant-scoped browser UUID, endpoint, and keepalive request. |
| `client/src/lib/eventClickCounts.js` | Bounded typed count request and response normalization. |
| `client/src/lib/eventClickCountDisplay.js` | Loading, unavailable, and numeric metric states. |
| `api/public/event-click.js` | Public ingestion validation, tenant/visibility checks, and record RPC call. |
| `api/admin/events/click-counts.js` | Authenticated aggregate count API and attendee-visibility filtering. |
| `api/_lib/eventClickAccess.js` | Event status and member-group visibility policy. |
| `api/_lib/eventClickTracking.js` | HMAC derivation and process-local rate limiter. |
| `supabase/migrations/20261026_event_card_click_tracking.sql` | Tables, indexes, RPCs, RLS, and grants. |
| `scripts/apply-event-card-click-tracking.mjs` | Destination-only schema application and verification; no backfill. |

### Design Principles

1. **Browser scope, not person scope:** dedupe represents browser storage, not
   a member or human.
2. **Events-only opt-in:** `EventCard` defaults tracking to `false`; only
   `Events.jsx` supplies the enabled handlers.
3. **Consent before persistence:** accepted consent precedes all storage access,
   and consent changes reactively reach every hook instance.
4. **Opaque storage:** the raw UUID is transient request input and is HMAC'd
   with the tenant ID before persistence.
5. **Database dedupe:** the unique key and `ON CONFLICT DO NOTHING` are
   authoritative, including concurrent requests.
6. **Aggregate reads:** count callers never receive visitor rows or hashes.
7. **Transient rate limiting:** network address is an in-memory limiter key,
   not fingerprinting and not distributed between processes.
8. **Release-only history:** new tables start empty; historical traffic is not
   reconstructed.

---

## 3. Core Logic

### 3.1 Browser Lifetime and Storage Scope

`getOrCreateEventClickVisitorId` uses the key
`iconn:event-click-visitor:<tenantScope>` in `window.localStorage`.
`tenantScope` is the normalized tenant slug, or `host:<hostname>` when no
slug is available.

- The same tenant scope, browser, and origin reuse the UUID until site data or
  local storage is cleared/replaced.
- A different browser profile, device, or origin normally has a different
  UUID. Tenant scopes also have separate keys.
- Different people sharing one browser may share a key; one person using
  multiple browsers may have several keys.
- There is no people-level join, fingerprint, identity expiry, or session
  storage fallback. The database has no TTL; rows follow event/tenant
  lifecycle, including foreign-key cascades.

This is therefore a browser-lifetime dedupe measure, not a people count.

### 3.2 Consent and Events-Only Opt-In

The hook stops before storage access unless the page is enabled, consent has
been accepted, and the event has an ID:

```js
if (!enabled || !hasConsented || !event?.id) return false;
```

`Events.jsx` enables the hook for every viewer, including tenant
administrators. It passes the handlers to its inline CTAs and `EventCard`;
other EventCard consumers retain the default disabled value. The consent hook
is reactive across hook instances, so accepting consent updates each
subscriber and its click handler without a page reload. Administrative action
buttons are not tracked, but an administrator activating an event CTA is
tracked like any other CTA activation.

### 3.3 Capturing and Deduplicating Clicks

Only a CTA activation is tracked. Direct detail-page visits, image clicks,
editing, and administrative action buttons do not create rows. An
administrator's activation of an event CTA does create a row. Button-only
`EventCard` CTAs use `onClick` only and have no auxiliary-click tracking path.
The router-backed links rendered directly by `Events.jsx`, including complex
event detail links, retain `onAuxClick` support for middle-click activation;
their existing navigation behavior is unchanged.
The browser posts:

```json
{
  "eventId": "event UUID",
  "eventType": "simple",
  "visitorId": "browser UUID"
}
```

The request is `POST /api/public/event-click` with `credentials: include` and
`keepalive: true`. It is not awaited by the CTA. A successful response
invalidates the scoped count query; failures are swallowed so navigation is
unchanged.

The database insert uses `ON CONFLICT (tenant_id, event_id,
visitor_key_hash) DO NOTHING`. A duplicate returns `recorded: false` and does
not increase the total.

### 3.4 Tenant and Event Visibility

The server resolves the tenant from tenant context/request resolution rather
than trusting a tenant ID in the body. The event must belong to that tenant
and pass `isEventCardClickVisible`:

- Simple: `published`, `tbc`, or `immediate`; drafts are rejected.
- Complex: `published` or `tbc`, with event state absent, `active`, or
  `closed`; drafts and other states are rejected.
- Public events and public group events accept guests.
- Private group events require an authenticated group member or tenant
  administrator.

Unknown and inaccessible events both return `404 Event not found`, preventing
an event or group-membership oracle.

### 3.5 HMAC and Signing-Key Rotation

The effective key is `EVENT_CLICK_HASH_SECRET`, falling back to
`SUPABASE_SERVICE_KEY`. The stored value is:

```text
HMAC-SHA256(effectiveKey, "<normalized tenant UUID>:<normalized visitor UUID>")
```

It is a 64-character hex digest decoded to 32-byte `BYTEA`. Raw UUIDs,
members, email addresses, and network addresses are not stored.

**Important:** rotating the effective HMAC/signing key changes deduplication
identities. The same browser then derives a new hash, so its next click may
insert a second row for an event. Rotation is a metric-identity boundary.

### 3.6 Aggregate Counts

The frontend count fetch batches separate simple and complex UUID arrays into
requests of at most 500 combined IDs. Each request is capped at 500 IDs and
returns:

```json
{
  "counts": {
    "simple": { "simple-event-uuid": 12 },
    "complex": { "complex-event-uuid": 3 }
  }
}
```

Allowed events are zero-filled. The endpoint reuses attendee visibility:
tenant administration, `events.browse-events.view-attendees`, membership, and
group administration are evaluated before the count RPC. It never returns
visitor hashes.

### 3.7 Release Scope

The migration and apply script create/verify schema only. They do not read
existing traffic, derive historical hashes, or insert historical rows. Counts
begin with clicks recorded after deployment.

---

## 4. Configuration / Settings

### Tracking gate

Tracking is enabled by `Events.jsx` for all viewers, including tenant
administrators, and only after accepted consent. `EventCard` defaults to
disabled for other consumers. Administrative action buttons are outside the
CTA handlers, while administrator CTA activations count normally. There is no
browser expiry setting or session-storage fallback.

### HMAC secret

`EVENT_CLICK_HASH_SECRET` is preferred, with `SUPABASE_SERVICE_KEY` as the
fallback. If neither is available, the API returns `503 Event click tracking
is unavailable`; it never stores a raw value.

### Rate limit

The API permits 60 requests per tenant/network key in a 60-second sliding
window. The key uses Vercel's trusted edge header when present, otherwise the
socket peer address; forgeable `x-forwarded-for` is ignored. Buckets are
in-memory and bounded at 5,000.

**This is not distributed rate limiting.** Separate processes/instances do
not share buckets. The address is transient limiter input, not a fingerprint
or stored click identity.

### Count requests

The frontend batches simple and complex IDs into requests of no more than 500
combined IDs. Each batch is sent together, and the client query is enabled
only for attendee-authorized callers and non-empty event lists.

---

## 5. Code Paths / Entry Points

### 5.1 Events page

**File:** `client/src/pages/Events.jsx`  
**Trigger:** The Events listing renders.

1. Build visible simple and complex event ID lists.
2. Enable tracking for all viewers, including tenant administrators; admin
   action buttons remain outside the tracking handlers.
3. Pass handlers and count props to cards and inline featured-card CTAs.
4. If attendee access is available, request aggregate counts.
5. On a successful write, invalidate `event-click-counts` for the tenant scope.

**Note:** This is the only page-level write opt-in.

### 5.2 EventCard CTA

**File:** `client/src/components/events/EventCard.jsx`  
**Functions:** `trackEventClick`, `handleBuyTicketsClick`,
`handleRegisterClick`  
**Trigger:** A visitor activates a tracked CTA.

The wrapper checks the enabled flag, tracks Buy Tickets before navigation, and
tracks simple/complex registration before an override or detail URL. These are
button-only CTAs, so they have no `onAuxClick` tracking path. Sold-out, past,
and group-locked disabled controls do not activate tracking. A
registration-closed, non-sold-out CTA retains its existing navigable handler.
Complex router links rendered by `Events.jsx` separately retain their existing
middle-click navigation and auxiliary tracking.

### 5.3 Public ingestion

**File:** `api/public/event-click.js`  
**Trigger:** `POST /api/public/event-click`.

1. Handle CORS preflight and reject non-POST methods.
2. Validate UUID event/visitor IDs and `simple`/`complex` type.
3. Resolve tenant; reject mismatch or missing tenant.
4. Consume the tenant/network process-local limiter.
5. Load the tenant event and apply status/group visibility.
6. Derive the HMAC and call `record_event_card_click`.
7. Return `{ recorded: true }` or `{ recorded: false }`.

### 5.4 Admin count read

**File:** `api/admin/events/click-counts.js`  
**Trigger:** An attendee-authorized Events page requests counts.

1. Require POST, configured Supabase, authenticated tenant context, and stable
   tenant selection.
2. Validate each batch's arrays and UUIDs and enforce the 500-ID limit.
3. Load rows in the tenant and apply attendee/group access filtering.
4. Call `get_event_card_click_counts` for allowed IDs and zero-fill the result;
   the frontend merges the typed results from its batches.

### 5.5 Schema release

**File:** `scripts/apply-event-card-click-tracking.mjs`  
**Trigger:** A release operator supplies `DEST_DATABASE_URL` and
`DEST_SUPABASE_URL`.

The script verifies the approved destination, applies the migration in a
transaction, checks tables/RPCs/RLS/grants/search paths, and commits only
after verification. It is not a backfill tool.

---

## 6. Safeguards and Error Handling

### Storage opt-out

Missing, throwing, or silently non-persistent storage returns `null`:

```js
storage.setItem(storageKey, generated);
if (storage.getItem(storageKey) !== generated) return null;
```

No ephemeral ID is sent. This preserves the browser-lifetime contract.

### Validation and authorization

The public route validates UUIDs/type, resolves tenant server-side, checks
tenant ownership and event visibility, and returns the same 404 for unknown
and inaccessible events. The count route requires authentication, validates
both typed ID arrays, applies attendee/group access, and never selects visitor
rows for the client.

### Rate limiting

After 60 requests in the 60-second window, ingestion returns `429` and
`Retry-After`. This is a process-local network-address guard only; database
validation and uniqueness remain authoritative. It is not distributed.

### Opaque storage and database controls

The API cannot derive a hash without valid tenant/visitor UUIDs and an
effective secret. The RPC accepts only a 64-character hex hash. Both tables
use forced RLS, revoke table access from `PUBLIC`, `anon`, and `authenticated`,
and grant access only to `service_role`. Both security-definer RPCs set
`search_path = public, pg_temp` and are executable only by `service_role`.

### Failure states

| Path/result | Status or display | Behavior |
|-------------|-------------------|----------|
| Invalid public body | `400 INVALID_EVENT_CLICK` | Analytics stops; CTA navigation is unaffected. |
| Unknown/inaccessible event | `404` | Does not disclose event/group existence. |
| Tenant changed | `409` | No row is recorded. |
| Rate exceeded | `429` + `Retry-After` | Caller can retry after the window. |
| Missing DB/secret/RPC failure | `503` | No raw identity fallback. |
| Unexpected ingestion failure | `500` | Fire-and-forget error is swallowed. |
| Count request malformed/over limit | `400` | No count query. |
| Count caller unauthenticated | `401` | No count query. |
| No countable access | `403` | No visitor data is exposed. |
| Count failure | `500`/`503` | Metric displays `—`, not zero. |

---

## 7. Frontend UI

### Layout and behavior

`EventClickCountMetric` is shown only when count access is enabled and the
existing attendee action is visible. It displays:

- `…` and a spinner while loading;
- `—` for an error or invalid value;
- a numeric value, including `0`, when ready.

ARIA labels are `Event click count loading`, `Event click count unavailable`,
or `Event clicks: <count>`. There is no visitor drill-down.

### CTA and endpoint table

| CTA/path | Endpoint | Method | Purpose |
|----------|----------|--------|---------|
| Buy Tickets, registration, or inline detail CTA | `/api/public/event-click` | `POST` | Record a browser-deduplicated activation. |
| Authorized Events-page count query | `/api/admin/events/click-counts` | `POST` | Return typed aggregate totals. |

### Cache invalidation

Successful ingestion invalidates queries beginning with
`['event-click-counts', tenantScope]`. Count keys include tenant scope,
normalized simple IDs, and normalized complex IDs; their `staleTime` is `0`.

---

## 8. Database Tables

### `public.event_card_click`

Simple-event click rows.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Generated primary key. |
| `tenant_id` | `UUID` | Tenant reference; cascades on tenant deletion. |
| `event_id` | `UUID` | `public.event` reference; cascades on event deletion. |
| `visitor_key_hash` | `BYTEA` | Exactly 32 bytes; opaque tenant-bound HMAC, not a personal identifier. |
| `clicked_at` | `TIMESTAMPTZ` | Defaults to `now()`. |

Unique key: `(tenant_id, event_id, visitor_key_hash)`. Index:
`(tenant_id, event_id)`.

### `public.complex_event_card_click`

Complex-event click rows with the same columns and constraints, except
`event_id` references `public.complex_event`.

### RPC contracts

```sql
record_event_card_click(
  p_tenant_id UUID,
  p_event_id UUID,
  p_event_type TEXT,
  p_visitor_key_hash TEXT
) RETURNS BOOLEAN
```

Validates the hash, checks tenant-owned eligible event state, inserts into the
type-specific table, and returns whether insertion occurred.

```sql
get_event_card_click_counts(
  p_tenant_id UUID,
  p_simple_event_ids UUID[],
  p_complex_event_ids UUID[]
) RETURNS TABLE(event_type TEXT, event_id UUID, click_count BIGINT)
```

Returns grouped totals only. Neither RPC exposes visitor hashes to callers.

---

## 9. Data Flow Diagrams

### Accepted click

```text
Events CTA
  → Events opt-in and accepted consent?
    → Read/create tenant-scoped localStorage UUID
      → Verify storage write
        → POST keepalive to public endpoint
          → Resolve tenant and visibility
            → HMAC tenant + browser UUID
              → Record RPC inserts or deduplicates
                → Invalidate count query
```

### Consent or storage unavailable

```text
CTA
  → Gate fails or consent not accepted
    → Stop; no storage access/request

CTA
  → Storage unavailable or write verification fails
    → Return null visitor ID
      → Do not send an ephemeral identifier
        → Navigation continues
```

### Count read and release

```text
Authorized Events page
  → Batch typed IDs into groups of at most 500
    → POST each batch
      → Authenticate and filter visible/countable events
        → Count RPC
          → Merge typed results, zero-fill, and render aggregate totals

Approved release destination
  → Apply/verify migration transaction
    → Commit empty future-click tables
      → No historical backfill
```

---

## 10. External Integrations

There is no third-party analytics service. The feature uses the application's
public/admin routes and Supabase/Postgres RPCs. `credentials: include` supports
tenant/session resolution; it does not make a session, member, or network
address the stored click identity.

---

## 11. Configuration Reference

| Setting | Location | Default | Description |
|---------|----------|---------|-------------|
| Tracking opt-in | `client/src/pages/Events.jsx` | All viewers on Events | Only page-level write opt-in; admin action buttons remain excluded. |
| Card tracking | `EventCard` props | `false` | Other card consumers remain off. |
| Consent | `useEventClickTracking` | Required | Only accepted consent permits storage/send. |
| Storage prefix | `eventClickTracking.js` | `iconn:event-click-visitor:` | Tenant-scoped localStorage key prefix. |
| HMAC secret | `eventClickTracking.js` | `EVENT_CLICK_HASH_SECRET`, then `SUPABASE_SERVICE_KEY` | Effective signing/dedupe key. |
| Rate window/limit | API tracking helper | 60 seconds / 60 requests | Process-local tenant/network guard. |
| Rate buckets | API tracking helper | 5,000 | Process memory bound. |
| Count ID limit | Admin count API | 500 combined | Simple plus complex IDs per request. |
| Release target | Apply script | `DEST_DATABASE_URL` and `DEST_SUPABASE_URL` required | Approved destination-only schema deployment. |

---

## 12. Troubleshooting

### Problem: No row is recorded

**Symptom:** A CTA works but the count does not change.  
**Cause:** The caller is outside `Events.jsx`, consent is not accepted, the
control is disabled, or local storage is unavailable.  
**Fix:** Verify the page gate, consent, and storage persistence. Do not use a
per-request fallback ID.

### Problem: A repeated browser click remains one count

**Symptom:** The same event does not increase on every activation.  
**Cause:** This is the uniqueness contract for one tenant/event/browser key.  
**Fix:** No fix is required. Clearing site data or using another
browser/device/origin changes the browser identity. Do not interpret the
metric as a people count.

### Problem: The metric displays `—`

**Symptom:** EventCard shows “Event click count unavailable”.  
**Cause:** The count request failed or the caller lacks attendee/group access.  
**Fix:** Check response status, `events.browse-events.view-attendees`, group
access, and RPC grants. Do not turn an error into zero.

### Problem: Ingestion returns `404` or `429`

**Symptom:** The public endpoint rejects a click.  
**Cause:** `404` means wrong tenant, unsupported/draft event state, or
inaccessible private group event. `429` means the current process/network
bucket exceeded 60 requests in 60 seconds.  
**Fix:** Correct tenant/visibility for `404`; honor `Retry-After` for `429`.
The limiter is process-local and not distributed.

### Problem: Counts change after key rotation

**Symptom:** A browser appears to count again for an already-clicked event.  
**Cause:** A new HMAC key creates a new `visitor_key_hash`.  
**Fix:** Treat rotation as a dedupe-identity boundary; do not store raw UUIDs
to preserve continuity.

### Problem: Schema release verification fails

**Symptom:** The apply script rolls back.  
**Cause:** Missing destination variables, an unapproved target, or a table/RPC,
RLS, grant, or search-path mismatch.  
**Fix:** Correct destination configuration and rerun verification. The script
is release-only and will not backfill historical clicks.