---
name: Member-group resource subcategory links
description: How admin-linked subcategories surface tenant resources into a group and push group resources tenant-wide.
---

Member groups have a `resource_subcategories` field (TEXT[]) — subcategory NAME
strings an admin links to the group. This drives a deliberate two-way carve-out
in the otherwise-strict group-resource privacy model.

**Matching is by subcategory NAME string, not id.** Subcategory names are NOT
globally unique across ResourceCategory entities (e.g. "Diagnostics" can exist
under both "Focus Area" and "Subject"). This mirrors how `Resource.subcategories`
tags already work — name overlap is intentional and acceptable.

**Two directions of visibility:**
1. Group's Resources card surfaces tenant-wide resources (member_group_id null,
   not draft) whose `subcategories` overlap the group's linked set. These are
   read-only for group admins (only resources owned by THIS group are editable).
2. Group-created resources are auto-tagged with the group's linked subcategories
   (client create payload AND server default in
   `applyGroupResourceSubcategoryDefaults`), which makes them appear tenant-wide
   on /Resources.

**The privacy change:** group resources are normally hidden from tenant-wide
lists (the standard rule — see group-scoped-entity-list-surfaces.md). The carve-out
on /Resources (authenticated path only) lets a group resource through ONLY when it
is tagged with a subcategory in ITS OWN group's linked set — checked per-group via
a `member_group_id -> linked subcategories` map, never against a global union.

**Why:** keeps group privacy intact by default; a group resource leaks tenant-wide
only because an admin deliberately linked that subcategory to the group.

**How to apply:** the public (unauthenticated) /Resources path still excludes all
group resources server-side (`api/public/resources.js` filters
`member_group_id IS NULL`), so "tenant-wide" here means authenticated tenant users
only. Extending to public would require a server-side change there.
