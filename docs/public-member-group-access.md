# Public member group access

The default-off `member_group.is_public` flag grants **read-only** access through
the host-tenant-scoped `/api/public/member-group-content` endpoint. Install
`supabase/migrations/202701230001_member_group_public.sql` on the intended
destination database before releasing this code. This task does not apply
production migrations or publish the application.

Guest navigation stays within `/MemberGroupDetail?id=...`, with `section`,
`resourceId`, `threadId` and `page` identifying the requested reading view.
Every request independently validates the active public group and its content
relationship. These parameters are locators, never authorization. Direct links,
reloads and back navigation use the same public shell. Authenticated viewers
retain the original group component and its existing joining behavior.

The dedicated reader deliberately does not mount the authenticated resource,
forum or group management components. Existing standalone library, forum,
storage and entity APIs remain unchanged. Resources are eligible only when
owned by the group or tenant-wide with a linked subcategory; independent role,
category, release and attendance restrictions remain enforced, including the
resource's own default-off **Public Resource** consent. Downloads sign
only ordinary upload files with an exact tenant-scoped file-repository match
to the authorized resource's persisted URL, bucket and path. Foreign-group
folders, all other storage namespaces, and files recorded as gallery or
opportunity documents are denied. Missing/ambiguous file provenance fails
closed. Signed URLs last 60 seconds. Disabling Public
prevents subsequent reads and signing; a previously issued URL can remain usable
for its remaining 60-second lifetime.

Forums with configured `forum_enabled_roles` remain member-only; publishing the
group does not publish those role-restricted discussions.
Forum responses omit moderation metadata and member IDs. Author names require
directory eligibility; otherwise a generic label is returned. Only already-public
forum images from this tenant's forum upload folder are included. The legacy
Canvas role-holder publication policy is not changed.

## Verification

```
node scripts/run-isolated-tests.mjs node --test api/public/member-group-content.test.mjs api/public/member-groups.test.mjs api/public/member-group-members.test.mjs api/_lib/singleResourceAccess.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test client/src/components/member-groups/MemberGroupCard.interaction.test.jsx client/src/contexts/RouteLayoutContext.test.jsx
node --test tests/public-member-group.browser.test.mjs
npx vite build
```

API fixtures verify tenant/group lineage, restrictions, mutations, path
substitution and revocation. Browser fixtures exercise the real shared card and
guest reader through resource downloads and discussion reads from directory and
Canvas entry fixtures, including reload/back behavior. Their header/footer are
fixture chrome, not evidence of live tenant branding. Existing route-layout
tests verify shell decisions separately. The workspace preview reports
“Tenant not found”; live tenant chrome, live signing and signed-in end-to-end
joining were not verified. No customer data or membership was changed.
