---
name: Preserve deprecated form history
description: Deprecated forms should be archived, not deleted with their submissions.
---

The user explicitly chose archiving deprecated forms while preserving submissions.

**Why:** Generic form deletion failed on the submission foreign key even though
the old confirmation misleadingly promised to delete all submissions. Removing
forms also loses the metadata needed to render historical answers.

**How to apply:** Use the tenant-admin archive action and archived_at, keeping
the original form row and submissions. Hide archived forms from the default
working list, expose an Archived filter, and restore as inactive (never silently
republish). Keep the protected department form's existing password-confirmed
deactivation flow. Do not cascade-delete submissions as a cleanup fix.

Schema is supplied by 20261126_form_archive.sql; check deployment status before
assuming it has been applied. Archive/restore does not need a historical data
backfill and should not modify any existing submissions.