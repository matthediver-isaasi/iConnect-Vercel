---
name: Replacing required relationship owners
description: Why required many-to-one Custom Object owner links need a purpose-built atomic database operation.
---

A required many-to-one relationship owner cannot be changed by updating the edge endpoint or by sequential archive/create calls. Endpoints are immutable, cardinality blocks create-first, and requiredness blocks archive-first.

**Why:** A live import encountered dangling owner edges whose target organisations had been deleted. Repointing was rejected as immutable; safe replacement needs archive-old plus create-new in one transaction that preserves the required-owner invariant.

**How to apply:** When repairing or changing required single-owner relationships, use a narrowly scoped transactional RPC with concurrency protection and exact old/new endpoint checks. Never temporarily disable requiredness across separate requests.