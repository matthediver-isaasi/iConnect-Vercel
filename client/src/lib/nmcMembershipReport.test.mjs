import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BNMS_TENANT_ID, NMC_REPORT_FEATURE, canAccessNmcReport, formatNmcReportDate, isNmcReportDestination, nmcExportFilename, nmcReviewGuidance, nmcDiagnosticRows, nmcDiagnosticIdentity, NMC_DIAGNOSTIC_PAGE_SIZE } from "./nmcMembershipReport.mjs";

const permitted = {
  brandingId: BNMS_TENANT_ID,
  memberInfo: { id: "member-23", tenant_id: BNMS_TENANT_ID },
  isAccessReady: true, sessionValidated: true, isAdmin: true,
  isFeatureExcluded: () => false,
};

test("diagnostics fail closed for missing, incomplete, malformed and duplicate identities", () => {
  const row = { memberId: "m1", firstName: null, lastName: null, email: null, memberClass: null };
  const snapshot = (rows, total = 1) => ({ reviewCounts: { missing_class: total }, diagnostics: { review: { missing_class: rows } } });
  for (const bad of [
    {}, { reviewCounts: { missing_class: 0 } }, snapshot(null), snapshot({}), snapshot([]),
    snapshot([row], 2), snapshot([row], "1"), snapshot([row], -1),
    snapshot([row, row], 2), snapshot([{ ...row, memberId: "" }]),
    snapshot([{ ...row, memberId: null }]), snapshot([{ ...row, memberId: 42 }]),
    snapshot([{ ...row, memberId: " " }]), snapshot([null]),
    ...["firstName", "lastName", "email", "memberClass"].flatMap(field => {
      const missing = { ...row }; delete missing[field];
      return [snapshot([missing]), snapshot([{ ...row, [field]: ["ambiguous"] }]), snapshot([{ ...row, [field]: {} }])];
    }),
  ]) assert.equal(nmcDiagnosticRows(bad, "review", "missing_class"), null);
  assert.deepEqual(nmcDiagnosticRows(snapshot([], 0), "review", "missing_class"), []);
  assert.deepEqual(nmcDiagnosticRows(snapshot([row]), "review", "missing_class"), [row]);
  assert.equal(nmcDiagnosticRows(snapshot([row]), "excluded", "missing_class"), null);
});

test("diagnostics sort deterministically without changing cached data and preserve honest fallbacks", () => {
  const base = { firstName: "Leah", lastName: "Shaw", email: null, memberClass: null };
  const rows = [{ ...base, memberId: "z" }, { ...base, memberId: "a" }, { ...base, firstName: "Abel", memberId: "b" }, { ...base, lastName: "Abbot", memberId: "c" }];
  const snapshot = { pendingCounts: { awaiting_first_payment: 4 }, diagnostics: { pending: { awaiting_first_payment: rows } } };
  assert.deepEqual(nmcDiagnosticRows(snapshot, "pending", "awaiting_first_payment").map(row => row.memberId), ["c", "b", "a", "z"]);
  assert.equal(rows[0].memberId, "z");
  assert.deepEqual(nmcDiagnosticIdentity({ firstName: null, lastName: " ", email: "", memberClass: null }), {
    name: "Name unavailable", email: "Email unavailable", memberClass: "Class missing or ambiguous",
  });
  assert.equal(nmcDiagnosticIdentity({ ...base, firstName: null }).name, "Shaw (partial name)");
  assert.equal(nmcDiagnosticIdentity({ ...base, memberClass: "Full member" }).memberClass, "Full member");
  assert.equal(NMC_DIAGNOSTIC_PAGE_SIZE, 25);
});

test("access fails closed for every trust boundary", () => {
  assert.equal(canAccessNmcReport(permitted), true);
  for (const override of [
    { brandingId: "another-tenant" }, { brandingId: undefined },
    { memberInfo: { id: "member-23", tenant_id: "another-tenant" } },
    { memberInfo: null }, { memberInfo: { tenant_id: BNMS_TENANT_ID } },
    { isAccessReady: false }, { isAccessReady: undefined }, { sessionValidated: false }, { sessionValidated: undefined }, { isAdmin: false },
    { isFeatureExcluded: id => id === NMC_REPORT_FEATURE },
    { isFeatureExcluded: id => id === "admin.role-management" },
  ]) assert.equal(canAccessNmcReport({ ...permitted, ...override }), false);
});

test("menu detection handles canonical, legacy and customised destinations", () => {
  for (const item of [
    { featureId: NMC_REPORT_FEATURE }, { feature_id: "page_admin_NMCMembershipReport" },
    { value: "NMCMembershipReport" }, { value: "page_NMCMembershipReport" },
    { url: "/nmcmembershipreport?format=xlsx", feature_id: "unrelated.permission" },
    { url: "NMCMembershipReport" }, { url: "https://portal.example/NMCMembershipReport/" },
  ]) assert.equal(isNmcReportDestination(item), true);
  assert.equal(isNmcReportDestination({ url: "/MembershipPaymentReport" }), false);
});

test("report date uses UTC date-only semantics and rejects invalid dates", () => {
  assert.equal(formatNmcReportDate("2026-01-31"), "31 Jan 2026");
  assert.equal(formatNmcReportDate("2026-02-30"), "Unavailable");
  assert.equal(formatNmcReportDate("2026-01-31T00:00:00Z"), "Unavailable");
  assert.equal(formatNmcReportDate(undefined), "Unavailable");
});

test("Excel filename is sanitised and malformed encoding does not fail export", () => {
  const response = value => ({ headers: new Headers({ "content-disposition": value }) });
  assert.equal(nmcExportFilename(response('attachment; filename="../../report.xlsx"'), "2026-01-31"), "report.xlsx");
  assert.equal(nmcExportFilename(response("attachment; filename*=UTF-8''bnms%20report.xlsx"), "2026-01-31"), "bnms report.xlsx");
  assert.equal(nmcExportFilename(response("attachment; filename*=UTF-8''%ZZ"), "2026-01-31"), "bnms-nmc-membership-report-2026-01-31.xlsx");
});

test("review guidance is actionable, including unknown backend reasons", () => {
  assert.match(nmcReviewGuidance("imported_legacy_expiry"), /not sufficient/);
  assert.match(nmcReviewGuidance("missing_membership_history"), /Verify/);
  assert.match(nmcReviewGuidance("new_backend_reason"), /source membership records.*data issue/);
  for (const reason of ["missing_membership_evidence", "missing_class", "unknown_class", "duplicate_custom_values", "unresolved_organisation", "invalid_expiry_or_term", "missing_expiry", "unproven_membership_evidence", "ambiguous_membership_evidence"]) {
    assert.ok(nmcReviewGuidance(reason).length > 70, reason);
    assert.doesNotMatch(nmcReviewGuidance(reason), /Review worksheet/);
    assert.notEqual(nmcReviewGuidance(reason), nmcReviewGuidance("new_backend_reason"));
  }
});

test("page and permission registration preserve existing routing conventions", () => {
  const source = path => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(source("../pages/index.jsx"), /path="\/NMCMembershipReport" element={<NMCMembershipReport/);
  assert.match(source("../pages/pageRegistry.js"), /"NMCMembershipReport"/);
  assert.match(source("./roleAccessMap.ts"), /id: "membership.nmc-membership-report"/);
  assert.match(source("./roleAccessMap.ts"), /"page_admin_NMCMembershipReport": "membership.nmc-membership-report"/);
  assert.match(source("../pages/NMCMembershipReport.jsx"), /enabled: allowed/);
  assert.match(source("../pages/Layout.jsx"), /adminPages.push\("NMCMembershipReport"\)/);
});
