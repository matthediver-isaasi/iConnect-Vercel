---
name: Public directory field privacy
description: Privacy boundary for public features that reuse member-directory data.
---

Public member projections must enforce two separate policies on the server: whether a member may appear at all, and which front-facing profile fields the tenant allows.

Public carousel display requires its own administrator-approved, default-off source permission, for both primary and dynamic directories. Active flags, unrestricted role lists, guest introduction copy and field publication switches do not constitute this consent. Do not automatically opt in existing directories or change legacy full-directory/embed access while extending carousels.

**Why:** The owner explicitly approved guest carousel access only for directories separately permitted for public display.

**How to apply:** Keep page authors unable to grant consent, project only permitted safe fields, and recheck consent before long reads return. Live permission changes require separate approval.

**Why:** A current, directory-visible member may still have profile photo, job title, organisation, or other fields disabled by tenant directory settings. Hiding those fields only in React still exposes them in the browser response.

**How to apply:** For any public directory-derived presentation, filter row eligibility first, then project only fields whose front visibility is enabled. Return the narrowest response shape needed by that presentation.

Organisation-directory reuse must not treat an empty member-role list as publication consent, or treat domain visibility as permission to expose the core website URL or description.

**Why:** Legacy public handlers can return broader data than the directory's actual member-role and field policies permit. The directory's visible domain is derived from verified-domain preferences, not the organisation's general website field.

**How to apply:** Check the management policy and authoritative directory projection, rather than inferring permission from an endpoint being named public. For long inventory reads, revalidate the full visibility/eligibility authority before returning.

Organisation profile permissions are not directory publication consent. Website, phone and description require explicit directory opt-in, independent of ordering.

**Why:** The user explicitly separated profile permissions from directory publication and required existing tenants not to publish new core values automatically.

**How to apply:** Preserve default-off publication and directory-specific inheritance; never infer website consent from verified-domain visibility or extend these values to front cards, carousel contracts or CSV exports.

Organisation names have an owner-approved carousel-only presentation override:
each element may inherit the directory setting, show names, or hide them.
Do not change full-directory settings when an author changes this option.

**Why:** The user explicitly requested an element-level option so tenants can
align with their directory or override it for that carousel only.

**How to apply:** Keep source access, public-carousel consent and all other field
permissions intact. Never replace a withheld organisation name with generic
visible “Organisation” text. The override does not apply to member-profile fields.

Treat carousel pagination as a front-end showcase interaction, not a directory
search requiring a new network round trip for each slide.

**Why:** The user explicitly requires fast partner/organisation transitions and
does not accept empty placeholders while each next slide loads.

**How to apply:** Load bounded batches and warm images without weakening source
consent, projection checks, or tenant/viewer isolation. Keep already permitted
cards visible during same-source loading; never carry them across access or
source changes.

Reduce carousel read latency by batching server-only inputs into fresh atomic
snapshots, not by dropping final visibility checks or caching permissions.

**Why:** Improving only the eligibility step left the complete request dominated
by repeated remote metadata reads. Full-handler timing exposed the real delay.

**How to apply:** Keep raw snapshot inputs service-role-only and never include
them in public responses. Preserve fresh tenant/role checks and comparisons
between snapshots; measure complete responses and compare their contents.

Include real session resolution when assessing authenticated carousel latency.
An injected tenant context measures data work, not the complete authenticated request.

**Why:** A successful data-handler benchmark missed repeated session/fence reads;
the user's subsequent browser evidence showed a 12.90-second server wait.

**How to apply:** Share a checked session only within one authority pass, never
between passes or requests. Retain fresh revocation checks and use response
phase timings before claiming the deployed authenticated delay is resolved.

Directory Carousel click behaviour must match Dynamic Directory's configured
detail dialog, not a separate logo-only popup.

**Why:** The user explicitly requested the same admin controls and the same
result when clicking an entry.

**How to apply:** Share the opt-in control and guest-safe dialog presentation.
Hydrate details under the carousel's own publication authority, including
primary-source consent; permission to show a lightweight card must not bypass
field visibility or justify a generic CRM entity read.