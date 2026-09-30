---
title: "iConnect Platform — Events Functionality Catalogue"
subtitle: "Verified capability catalogue for stakeholder review"
date: "7 September 2026"
version: "1.0"
classification: "Commercial in Confidence"
---

<div class="cover">
<div class="cover-kicker">iCONNECT PLATFORM</div>
<h1>Events Functionality<br>Catalogue</h1>
<p class="cover-subtitle">Verified capability catalogue for stakeholder review</p>
<p>7 September 2026 · Version 1.0</p>
<p class="confidence">COMMERCIAL IN CONFIDENCE</p>
</div>

\newpage

# Contents

1. [Purpose, scope and method](#1-purpose-scope-and-method)  
2. [Reading this catalogue](#2-reading-this-catalogue)  
3. [Simple and complex events at a glance](#3-simple-and-complex-events-at-a-glance)  
4. [Administration and event configuration](#4-administration-and-event-configuration)  
5. [Discovery, event pages and access](#5-discovery-event-pages-and-access)  
6. [Schedules, sessions and event content](#6-schedules-sessions-and-event-content)  
7. [Ticket classes, eligibility and registration](#7-ticket-classes-eligibility-and-registration)  
8. [Capacity, pricing and payment](#8-capacity-pricing-and-payment)  
9. [Booking management, cancellation and transfer](#9-booking-management-cancellation-and-transfer)  
10. [Communications, virtual delivery and attendance](#10-communications-virtual-delivery-and-attendance)  
11. [Surveys, check-in, reporting and workflows](#11-surveys-check-in-reporting-and-workflows)  
12. [Permissions, integrations and safeguards](#12-permissions-integrations-and-safeguards)  
13. [Important current boundaries](#13-important-current-boundaries)  
14. [Glossary](#14-glossary)  

\newpage

# 1. Purpose, scope and method {#1-purpose-scope-and-method}

This catalogue describes **currently implemented** event capability in iConnect, in business language. It is intended to support product, commercial and operational review; it is not a configuration guide or technical specification.

The catalogue covers the full event lifecycle: administration, discovery, programme content, registration, commerce, delivery, follow-up and governance. It distinguishes the two event models:

* **Simple event** — one event record, suitable for a conventional meeting, webinar, course or group-limited event. A training variant can carry a multi-day agenda.
* **Complex event** — a multi-session event with tracks, ticket-to-track access and session-level online delivery.

## Verification approach

Statements are based on the verified implementation inventories prepared for this review: simple events; complex events; event commerce; and event operations. Inventory evidence was traced to active user interfaces, service behaviour and supporting data changes. Proposed work, task descriptions and specifications without independently verified implementation are deliberately excluded. “Available” therefore means present in the current product, not a commitment that every tenant has configured it or that every event displays it.

# 2. Reading this catalogue {#2-reading-this-catalogue}

## Availability legend

| Availability | Meaning | Reader implication |
|---|---|---|
| **Shared** | Available in both event models. | The detailed behaviour can differ by model. |
| **Simple** | Available for simple events. | Includes training and group-limited variants where stated. |
| **Complex** | Available for complex events. | Normally relates to sessions, tracks or multi-ticket checkout. |
| **Conditional** | Available when a named setting, data assignment, access rule or integration is in place. | It should be confirmed for the tenant and event concerned. |

## Terms used in tables

The **Availability** column combines labels where useful (for example, **Shared · Conditional**). The **Description / dependency** column states what a reader can expect and, where material, the enabling condition or boundary. “Member” means an authenticated person in the tenant; “guest” means a person without that member context. “Tenant” means the client organisation’s isolated platform environment.

# 3. Simple and complex events at a glance {#3-simple-and-complex-events-at-a-glance}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Simple** | Conventional event model | One event with date, place or online mode, ticket classes, speakers, tags, call to action and documents. It also supports a training agenda and a group-limited variant. |
| **Complex** | Programme event model | One event can contain days, tracks and separately managed sessions, with ticket classes that can grant access to selected tracks. |
| **Shared** | Public event experience | Each model has public listing and detail experiences, subject to publication and visibility rules. |
| **Shared · Conditional** | Paid or free registration | Both models support registration and commercial controls. Available payment options depend on tenant configuration, user context and the selected ticket. |
| **Simple · Conditional** | Training event | A simple-event training flag derives the overall span from its agenda. Training cannot use Immediate timing. |
| **Complex · Conditional** | Session delivery | Each session can carry its own online delivery, provider and access configuration. |
| **Shared** | Lifecycle controls | Confirmations, reminders, attendance reporting, cancellation requests, transfers and safe event deletion are supported, with model-specific handling where necessary. |

# 4. Administration and event configuration {#4-administration-and-event-configuration}

## Event creation, editing and timing

| Availability | Capability | Description / dependency |
|---|---|---|
| **Simple** | Event details and publishing | Administrators can create and edit titles, descriptions, dates, location or online mode, seats, visibility, status, speakers, tags, call to action, documents, attendance policy and ticketing details. |
| **Simple · Conditional** | Timing states | Scheduled, TBC and Immediate states are supported. TBC intentionally has no fixed schedule; Immediate is treated as current rather than past. |
| **Simple · Conditional** | Immediate event boundary | Immediate is only for non-training, non-complex, non-group events. It has no dates, registration close, timezone, Zoom identifiers or training agenda. |
| **Simple · Conditional** | Group-limited event | An event can be limited to a member group. This variant uses a group association and manual meeting link, and is free-ticket mode rather than ordinary paid ticketing. |
| **Complex** | Complex event builder | Administrators can manage event dates, registration window, tracks, sessions, ticket classes, speakers, sponsors, resources and online-delivery information in a dedicated builder. |
| **Complex** | Session administration | Sessions can be added and updated with title, description, timing, track, speakers and online provider details. Session deletion and event deletion use controlled cancellation rather than a direct purge. |
| **Shared · Conditional** | Tenant event settings | Tenant settings cover voucher expiry treatment and accounting/payment choices such as Xero status and account codes or Stripe clearing account. These settings enable behaviour; they do not guarantee that every event uses it. |
| **Shared · Conditional** | Ticket offers and programmes | Administrators can manage ticket offers and programmes, including discount-related configurations. Whether an offer is effective depends on its applicable rule and dates. |

# 5. Discovery, event pages and access {#5-discovery-event-pages-and-access}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Shared** | Public listing | Published and otherwise permitted events can be discovered in tenant-scoped public lists. Simple events include published, TBC and Immediate states; complex events have their own public list and detail route. |
| **Simple · Conditional** | Public event detail | Detail can be reached by identifier or friendly link and shows event, ticket and commercial information appropriate to the viewer. A direct link to a private group event does not itself grant booking permission. |
| **Complex** | Programme detail and agenda | The public complex-event page presents day- and track-aware schedules, sessions, tickets and sponsors where configured. |
| **Shared · Conditional** | Public ticket visibility | Publicly visible ticket classes are shown to guests. Member, role or group-restricted classes are revealed and accepted only when the viewer meets the applicable rule. |
| **Shared · Conditional** | Group visibility | Public lists exclude private group-only events. A group event must be explicitly public to appear there; membership is separately enforced at booking. |
| **Shared · Conditional** | Public content sections | Sponsors, documents and resources appear only when they have been assigned and public content is populated. |
| **Shared · Conditional** | Search and indexing boundary | Public discovery is implemented; automatic event sitemap generation, canonical metadata, JSON-LD and indexing policy are not evidenced by this review. |

# 6. Schedules, sessions and event content {#6-schedules-sessions-and-event-content}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Simple · Conditional** | Training agenda | A training simple event can hold agenda items and use them to determine its overall event span. Public summaries omit agenda for Immediate events. |
| **Complex** | Days, tracks and sessions | A complex event supports a programme organised by day, track and individual sessions, giving attendees a structured agenda rather than a single timetable. |
| **Complex · Conditional** | Ticket-to-track access | Tickets can permit all tracks or selected tracks. Schedule indicators and registration filtering reflect this only when ticket classes have track restrictions. |
| **Complex** | Speaker assignment | Sessions can be associated with managed speaker records, allowing the programme to present the relevant contributors. |
| **Shared · Conditional** | Sponsors | Managed sponsors can be assigned to simple or complex events and shown publicly when assignments and display content exist. |
| **Shared · Conditional** | Documents and resources | Event material can be associated with the event and displayed publicly where suitable records and public content are present. |
| **Simple · Conditional** | Speaker, tag and call-to-action content | The simple event editor supports speaker, tag, document and call-to-action content. Display depends on the populated event record and visibility. |

# 7. Ticket classes, eligibility and registration {#7-ticket-classes-eligibility-and-registration}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Shared** | Ticket classes | Events can offer ticket classes with visibility, availability and commercial attributes. The complex manager also supports classes linked to tracks. |
| **Complex** | Multi-ticket attendee checkout | A buyer can assemble multiple ticket items and add, update or remove attendee details before submitting a complex-event booking. |
| **Shared · Conditional** | Eligibility controls | Ticket availability can be restricted by member status, role or group. The service validates restricted classes rather than relying only on the screen. |
| **Complex · Conditional** | Group-linked self-registration | For a complex event linked to a group, an authenticated active group member can register only themselves; guest, colleague and buy-many routes are rejected. |
| **Simple · Conditional** | Group participant completion | Group event participants can complete registration through a tokenised flow, with locking at the configured cut-off. |
| **Shared** | Attendee information | Registration records carry attendee identity and booking information. Complex checkout captures name, email, organisation, phone, job title and optional dietary/accessibility selections. |
| **Complex** | Duplicate attendee protection | Checkout normalises email addresses and rejects duplicates within the request and against active or pending bookings. A member profile can fill a missing job title. |
| **Simple** | Administrative attendee import | Administrators can import attendee data in CSV form, with per-row errors and warnings, de-duplication and confirmation handling. It does not process payment and can complete partially. |
| **Simple · Conditional** | Import warning boundary | Import warns, rather than blocks, a guest placed in a members-only class; administrators should review warnings. |

# 8. Capacity, pricing and payment {#8-capacity-pricing-and-payment}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Shared** | Availability and sold-out status | Registration surfaces calculate availability from configured capacity and confirmed bookings, so sold-out status reflects commercial allocation rather than a display-only flag. |
| **Complex** | Strong capacity controls | Event seats use an atomic decrement and ticket-class capacity is checked from confirmed bookings with race protection and rollback. |
| **Simple** | Seat restoration | Booking cancellation restores simple-event seats. The regular path has a fallback update when its seat-adjustment operation is unavailable, making it less strongly atomic than the complex path. |
| **Complex** | Server-authoritative prices | The service determines ticket prices and totals, including free tickets and early-bird prices before their deadline; mixed checkout currencies are rejected. |
| **Shared · Conditional** | Discount codes | Discounts can be scoped by event, ticket, organisation, member, role or group, with expiry and maximum-use checks. The applicable rule determines eligibility. |
| **Shared · Conditional** | Payment methods | Card, account, account balance, training fund, voucher and invoice routes are supported for complex checkout; availability depends on login, organisation balances, permitted roles and tenant payment configuration. |
| **Shared · Conditional** | Card payment | Card payments use Stripe payment intent validation. A completed, correctly bound payment is required for paid card registrations. |
| **Shared · Conditional** | Voucher and training funding | Eligible organisation-owned vouchers and training funds can be applied when balance, expiry and role rules permit. Voucher payment requires full coverage; training fund can be a validated partial contribution. |
| **Shared · Conditional** | Account and invoice | Account/invoice registrations are pending and require an authenticated context; purchase-order information can be recorded. Downstream invoice issuance or reconciliation is provider/manual-process dependent for complex checkout. |
| **Simple · Conditional** | Regular-event accounting | The regular booking route can create accounting invoices where configured and records ticket, discount, voucher and training-fund allocations. |
| **Shared** | Tax boundary | No event-commerce VAT calculation or VAT-inclusive/exclusive line is evidenced in the inspected booking flows. Displayed ticket totals should be treated as final currency amounts in those flows. |
| **Shared** | Offer boundary | Early-bird and discount-code pricing are verified. The presence of a general offer label is not evidence that every advertised offer type is calculated at checkout. |

# 9. Booking management, cancellation and transfer {#9-booking-management-cancellation-and-transfer}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Shared** | Booking history and lookup | The platform has unified lookup handling for regular and complex booking sources. Complex member history is enriched with event, session and ticket-track context. |
| **Shared** | Cancellation request and approval | Members can create authorised requests and administrators can initiate, approve or reject them. Duplicate pending requests and mixed-source requests are prevented. |
| **Shared** | Idempotent cancellation engine | Approval uses one cancellation engine that can safely handle repeat attempts, move booking/allocation status and restore operational inventory. |
| **Shared · Conditional** | Reversals | Cancellation can restore seats, Zoom registration, training funds, vouchers, discount usage or a regular programme ticket; Stripe refunds and Xero credit notes depend on configured provider credentials and payment data. |
| **Shared · Conditional** | Manual-action handling | Missing or disabled payment/accounting providers, or failed Stripe/Xero reversals, are recorded for manual follow-up. Cancellation may still complete; some best-effort side effects can also require review. |
| **Shared · Conditional** | Discount restoration | An expired discount is not automatically restored. A replacement is made only when a reviewer supplies a new expiry date. |
| **Shared** | Transfer request | A booking can be transferred through a request and approval flow. Pending transfer and cancellation requests are mutually exclusive. |
| **Shared · Conditional** | Transfer rules | Public targets need valid identity details and must not already be members; member transfers can enforce same organisation and role. Approval changes attendee identity, not price or payment. |
| **Shared · Conditional** | Transfer follow-up boundary | Zoom, accounting and email work is non-blocking. Public transfers deliberately skip accounting invoice update, so operational follow-up can be needed. |
| **Shared** | Safe event deletion | Deletion first puts an event into a cancelling state, blocks new registrations, processes bookings and then removes the event. A preview identifies affected bookings and potential provider follow-up. |
| **Shared · Conditional** | Deletion recovery | Processing failures leave the event in cancelling for rerun or manual resolution. Financial items marked for manual action do not by themselves prevent deletion. |

# 10. Communications, virtual delivery and attendance {#10-communications-virtual-delivery-and-attendance}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Shared · Conditional** | Event email configuration | Event emails can be configured with timing, custom send point, subject, body, CC and enabled state. Saving schedules simple or complex reminders as appropriate. |
| **Shared · Conditional** | Automated reminders | A scheduled reminder process sends enabled event communications. Scheduling outcomes surface skipped items and failures for follow-up. |
| **Simple · Conditional** | Agenda in email | Training agenda content can be rendered into confirmations and reminders when the event email uses the agenda schedule content. |
| **Shared** | Confirmation resend | Administrators can resend attendee confirmations. |
| **Shared · Conditional** | Zoom event delivery | Zoom meetings/webinars can be managed, reassigned and synchronised. Active registrations can be moved when an associated meeting changes. |
| **Complex · Conditional** | Session-level virtual delivery | A complex session can specify online mode, provider, Zoom host/type and registration requirement, or a Teams meeting identifier. Zoom can be provisioned, changed and synchronised per session. |
| **Complex · Conditional** | Protected join links | Complex-event agenda Zoom join links are shown only to entitled viewers with a confirmed booking; they are not a general public disclosure route. |
| **Shared · Conditional** | Microsoft Teams and Outlook | Teams meeting and attendance functions require a connected Outlook organiser and Microsoft administrator consent. Outlook calendar connection, status and synchronisation are supported. |
| **Shared · Conditional** | External join links | Online events can hold external join links, including Teams, Zoom or Google Meet-style links. This is not evidence of native Google Calendar integration. |
| **Shared · Conditional** | Attendance synchronisation | Zoom and Teams/provider attendance can be synchronised and linked to participant outcomes. Successful provider binding and sync are required. |
| **Shared · Conditional** | Attendance outcome | Registration reporting can identify attended, below-threshold and absent outcomes, duration and session detail. Unmatched provider participants can remain unmatched. |

# 11. Surveys, check-in, reporting and workflows {#11-surveys-check-in-reporting-and-workflows}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Shared · Conditional** | Event survey assignment | A published survey version can be assigned to a simple or complex event with an access mode and open/close window. The assignment retains the event context. |
| **Shared · Conditional** | Survey access control | A token resolves the current published survey within its assignment window. Outside the window, context may be shown but the form cannot be completed; access policy can deny access. |
| **Shared · Conditional** | Entrance QR check-in | Physical events can include entrance QR codes in confirmation email: one per simple booking and one per registered in-person session for a complex booking. Staff scan them through the check-in service. Online events deliberately have no entrance QR. |
| **Shared** | Registration reporting | A registration report brings together booking and attendance information. Complex events can add session-level detail. |
| **Shared · Conditional** | Saved exports | Report/export infrastructure and saved-export use are available. Specific output formats are not asserted here because they depend on the report surface selected. |
| **Shared · Conditional** | Workflow platform | Administrators have a workflow engine and management surface available in the platform. This review does not establish a complete catalogue of event-specific triggers or actions. |

# 12. Permissions, integrations and safeguards {#12-permissions-integrations-and-safeguards}

| Availability | Capability | Description / dependency |
|---|---|---|
| **Shared** | Role-based access | Platform roles include event, calendar, cancellation and site-map capabilities. Administrative screens and service operations apply permission and tenant controls. |
| **Shared** | Tenant isolation | Public discovery and booking-related operations resolve the tenant and scope data to it, helping prevent one client organisation’s events being exposed to another. |
| **Shared** | Server-side booking protection | Services validate event state, ticket identity, visibility/access and payment-sensitive data instead of trusting browser-submitted totals. |
| **Shared · Conditional** | Registration state controls | Regular registration rejects a past registration deadline. Complex checkout blocks unpublished, draft, closed or cancelling events. |
| **Complex** | Complex deadline boundary | The inspected complex public booking and payment-intent paths do not show an equivalent registration-deadline check; event state controls still apply. |
| **Shared · Conditional** | Stripe | Stripe supports card payment flows and applicable cancellation refunds. The tenant must have working Stripe configuration. |
| **Shared · Conditional** | Xero | Xero settings and booking linkage support regular-event accounting and applicable credit-note outcomes. Provider availability and configuration determine completion. |
| **Shared · Conditional** | Zoom | Zoom supports delivery, registration movement and attendance sync when relevant identifiers, host settings and tenant credentials are configured. |
| **Shared · Conditional** | Microsoft Graph | Outlook calendars and Teams meeting/attendance functions rely on Microsoft connection, consent and accessible meetings. |

# 13. Important current boundaries {#13-important-current-boundaries}

The following are intentionally prominent because they affect planning and stakeholder expectations:

| Availability | Capability / boundary | Description / dependency |
|---|---|---|
| **Simple · Conditional** | Immediate and group limitations | Immediate cannot be training or group-limited and does not carry schedule or Zoom data. Group-limited simple events are free-ticket/manual-link mode. |
| **Shared · Conditional** | Configuration is not automatic | Sponsors, resources, public tickets, virtual delivery, provider links and restricted access appear only when configured, assigned and permitted. |
| **Shared** | Proposed work excluded | Cancellation terms/deadline policies, certain refund/notification changes and member-only experience changes appearing in task planning are not represented as shipped capability. |
| **Shared** | Operational follow-up can remain | Some provider-side refund, credit-note, Zoom, accounting or email outcomes are non-blocking and may require manual follow-up. |
| **Shared** | No commerce VAT engine evidenced | The reviewed event booking flows do not evidence VAT computation or a VAT line. |
| **Shared** | Not an appointment-booking catalogue | Separate agent meeting-booking/calendar functions are not event commerce and are not described as ticket-checkout capability here. |

# 14. Glossary {#14-glossary}

| Availability | Term | Description / dependency |
|---|---|---|
| **Shared** | **Attendee** | The person registered to attend; they may differ from the person who made or paid for the booking. |
| **Shared** | **Booking source** | The underlying simple/regular or complex booking route; lifecycle controls use this distinction to handle each correctly. |
| **Shared** | **Complex event** | A multi-session programme with days, tracks, sessions and potentially track-limited tickets. |
| **Shared** | **Conditional** | A capability that requires a setting, linked record, eligibility rule or connected external provider. |
| **Shared** | **Group-limited event** | An event associated with a defined member group; visibility and registration are subject to group rules. |
| **Shared** | **Immediate / TBC** | Timing states for simple events. Immediate has no schedule; TBC has no confirmed schedule at creation. |
| **Shared** | **Simple event** | A conventional single event record; it may also be a training or group-limited variant. |
| **Shared** | **Tenant** | The client organisation’s isolated iConnect environment, including its data, branding, permissions and integrations. |
| **Shared** | **Track** | A strand of a complex-event programme. Tickets can be configured to allow all tracks or selected tracks. |

---

*Document control: Events Functionality Catalogue · Version 1.0 · Published 7 September 2026 · Commercial in Confidence.*