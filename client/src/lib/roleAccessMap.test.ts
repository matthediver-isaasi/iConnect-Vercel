import test from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_TO_NEW_MAPPING,
  ROLE_ACCESS_MAP,
  getAllResourceIds,
  migrateLegacyFeatureId,
  migrateLegacyExcludedFeatures,
} from "./roleAccessMap.ts";
import { isResourceExcluded, isResourceVisible } from "./roleVisibility.ts";

const validResourceIds = new Set(getAllResourceIds());

/**
 * Snapshot of known legacy feature IDs and the canonical key each must resolve
 * to. This is the regression guard: if a page URL or feature ID is renamed in
 * ROLE_ACCESS_MAP but LEGACY_TO_NEW_MAPPING is not updated in lockstep, the
 * assertions below fail before the gap can reach production and silently leave
 * pages visible that should be hidden.
 *
 * Covers every legacy naming family found in the codebase:
 *   page_user_*, page_admin_*, page_*, element_*, action_*, payment_*,
 *   feature_*, edit_*, view_*, admin_can_*, and dotted legacy aliases.
 */
const LEGACY_ID_SNAPSHOT: Record<string, string> = {
  // page_user_* family
  page_user_BuyProgramTickets: "commerce.buy-tickets",
  page_user_Events: "events.browse-events",
  page_user_Preferences: "user.about-me",
  page_user_MyJobPostings: "jobs.my-postings",
  // page_admin_* family
  page_admin_RoleManagement: "admin.role-management",
  page_admin_DiscountCodeManagement: "events.discount-codes",
  page_admin_PageBuilder: "site-builder",
  page_admin_EventCheckInDashboard: "events.event-checkin",
  page_admin_BriefSettings: "content.brief-settings",
  // page_* family
  page_Events: "events.browse-events",
  page_CancellationRequests: "commerce.event-cancellations",
  page_MembersList: "crm.members",
  page_BriefManagement: "publications.briefmanagement",
  page_BriefSettings: "content.brief-settings",
  page_PhotoGalleries: "content.gallery",
  page_EventCheckIn: "events.event-checkin",
  // element_* family
  element_EventsSearch: "events.browse-events.search-filters",
  element_SelfRegistration: "events.event-details.self-registration",
  element_NewsTickerBar: "system.news-ticker.display",
  // action_* / payment_* / feature_* / edit_* / view_* / admin_can_* families
  action_org_logo_edit: "membership.organisation-directory.edit-logo",
  action_article_edit: "content.articles.edit",
  payment_training_vouchers: "commerce.buy-tickets.use-vouchers",
  payment_training_fund: "commerce.buy-tickets.use-training-fund",
  feature_PostJobOnBehalfOfOrg: "jobs.post-job.post-on-behalf",
  edit_professional_biography: "communication.preferences.edit-biography",
  view_member_biography: "membership.member-directory.view-biography",
  admin_can_edit_members: "admin.member-role-assignment.edit-members",
  admin_can_manage_communications: "communication",
  // dotted legacy aliases (old canonical keys that were later renamed)
  "membership.my-organisation": "organisation.my-organisation",
  "membership.organisation-preferences": "organisation.field-permissions",
  // "communication.preferences" is a live resource, NOT a legacy alias: it must
  // resolve to itself so its exclusions are honored (a stale alias to
  // "user.about-me" previously shadowed it and prevented hiding the page).
  "communication.preferences": "communication.preferences",
};

test("snapshot: every known legacy ID resolves to its expected canonical key", () => {
  for (const [legacyId, expected] of Object.entries(LEGACY_ID_SNAPSHOT)) {
    assert.equal(
      migrateLegacyFeatureId(legacyId),
      expected,
      `Legacy ID "${legacyId}" should resolve to "${expected}"`,
    );
  }
});

test("snapshot: every expected canonical key exists in ROLE_ACCESS_MAP", () => {
  for (const [legacyId, expected] of Object.entries(LEGACY_ID_SNAPSHOT)) {
    assert.ok(
      validResourceIds.has(expected),
      `Snapshot for "${legacyId}" points at "${expected}", which is not a real resource in ROLE_ACCESS_MAP`,
    );
  }
});

test("every LEGACY_TO_NEW_MAPPING target is a real resource in ROLE_ACCESS_MAP", () => {
  const broken: string[] = [];
  for (const [legacyId, canonicalId] of Object.entries(LEGACY_TO_NEW_MAPPING)) {
    if (!validResourceIds.has(canonicalId)) {
      broken.push(`${legacyId} -> ${canonicalId}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    `These legacy mappings point at canonical keys that no longer exist in ROLE_ACCESS_MAP. ` +
      `Update the mapping (or re-add the resource) so stored exclusions are not silently ignored:\n` +
      broken.join("\n"),
  );
});

test("migrateLegacyFeatureId is idempotent (no legacy target is itself legacy)", () => {
  for (const legacyId of Object.keys(LEGACY_TO_NEW_MAPPING)) {
    const once = migrateLegacyFeatureId(legacyId);
    const twice = migrateLegacyFeatureId(once);
    assert.equal(
      once,
      twice,
      `Mapping for "${legacyId}" resolves to "${once}" which is itself a legacy ID resolving to "${twice}". ` +
        `Mapping targets must be canonical, not chained.`,
    );
  }
});

test("canonical resource IDs are passed through unchanged", () => {
  for (const canonicalId of validResourceIds) {
    assert.equal(
      migrateLegacyFeatureId(canonicalId),
      canonicalId,
      `Canonical ID "${canonicalId}" must not be rewritten by migrateLegacyFeatureId`,
    );
  }
});

test("unknown IDs pass through unchanged", () => {
  assert.equal(migrateLegacyFeatureId("totally_unknown_id"), "totally_unknown_id");
  assert.equal(migrateLegacyFeatureId(""), "");
});

test("stored legacy exclusions still hide the canonical resource", () => {
  // A role storing a stale legacy ID must still hide the canonical resource...
  assert.equal(isResourceExcluded(["page_CancellationRequests"], "commerce.event-cancellations"), true);
  assert.equal(isResourceVisible(["page_CancellationRequests"], "commerce.event-cancellations"), false);

  // ...and querying with a legacy ID against a canonical exclusion also works.
  assert.equal(isResourceExcluded(["commerce.event-cancellations"], "page_CancellationRequests"), true);

  // A legacy module/page exclusion cascades to its children.
  assert.equal(isResourceExcluded(["page_admin_PageBuilder"], "site-builder.pages"), true);

  // Unrelated resources remain visible.
  assert.equal(isResourceExcluded(["page_CancellationRequests"], "events.browse-events"), false);
});

test("migrateLegacyExcludedFeatures maps only known legacy IDs", () => {
  const result = migrateLegacyExcludedFeatures([
    "page_CancellationRequests",
    "totally_unknown_id",
  ]);
  assert.deepEqual(result, ["commerce.event-cancellations"]);
});

test("ROLE_ACCESS_MAP has no duplicate resource IDs", () => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const module of ROLE_ACCESS_MAP) {
    const push = (id: string) => {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    };
    push(module.id);
    for (const page of module.pages) {
      push(page.id);
      for (const feature of page.features ?? []) push(feature.id);
    }
  }
  assert.deepEqual(duplicates, [], `Duplicate resource IDs found: ${duplicates.join(", ")}`);
});
