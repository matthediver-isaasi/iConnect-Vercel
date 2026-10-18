---
name: Sales quote naming scope
description: Product boundary between tenant internal terminology and customer-facing or financial identities.
---

Tenant-configurable quote terminology is for the internal Sales interface only.
Public quote pages, sent email content, PDFs, historical snapshots, API/permission
identifiers and quote numbers retain their established names. Project task-list
names are independent settings and must not track module-name changes.

**Why:** The user explicitly requested an internal terminology change without
altering customer-facing documents, financial records or existing task lists.

**How to apply:** Use singular and plural labels supplied by the tenant rather
than deriving inflections. Keep the original `/sales/quotes` compatibility route
permanently; previous custom aliases are deliberately not retained after later
renames. Do not expand this into general-purpose module renaming.
