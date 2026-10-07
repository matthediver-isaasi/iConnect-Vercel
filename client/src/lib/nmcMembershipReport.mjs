export const BNMS_TENANT_ID = "ff2df806-b321-4254-b651-3af11fccf1db";
export const NMC_REPORT_FEATURE = "membership.nmc-membership-report";
export const NMC_REPORT_ENDPOINT = "/api/admin/nmc-membership-report";

export function isNmcReportDestination(item) {
  const feature = item?.featureId || item?.feature_id || item?.value || "";
  if ([NMC_REPORT_FEATURE, "page_NMCMembershipReport", "page_admin_NMCMembershipReport", "NMCMembershipReport"].includes(feature)) return true;
  const path = String(item?.url || item?.path || "").split(/[?#]/)[0].replace(/^https?:\/\/[^/]+/i, "").replace(/^\/|\/$/g, "");
  return path.toLowerCase() === "nmcmembershipreport";
}

export function canAccessNmcReport({ brandingId, memberInfo, isAccessReady, sessionValidated, isAdmin, isFeatureExcluded }) {
  return Boolean(isAccessReady && sessionValidated && isAdmin && !!memberInfo?.id
    && brandingId === BNMS_TENANT_ID && memberInfo.tenant_id === BNMS_TENANT_ID
    && !isFeatureExcluded("admin.role-management")
    && !isFeatureExcluded(NMC_REPORT_FEATURE));
}

export function formatNmcReportDate(value) {
  // Report date is a UTC date-only value, never a local-time instant.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "Unavailable";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return "Unavailable";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function nmcReasonLabel(reason) {
  return String(reason).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^\w/, letter => letter.toUpperCase());
}

export function nmcReviewGuidance(reason) {
  const guidance = {
    missing_membership_evidence: "Check the source membership record and add or reconcile evidenced membership history. Do not infer entitlement from an imported Active status or legacy expiry alone.",
    missing_class: "Confirm and populate the member’s membership class in the source record, then refresh the report.",
    unknown_class: "Check the recorded class against the supported BNMS membership classes and correct an unrecognised value before refreshing.",
    duplicate_custom_values: "Inspect the member’s custom field values and reconcile duplicate entries so membership evidence has one unambiguous value per field.",
    unresolved_organisation: "Verify the member’s linked organisation and resolve the missing or invalid organisation reference in the source record.",
    invalid_expiry_or_term: "Check the expiry date and membership term against source evidence. Correct invalid dates or terms before refreshing the report.",
    missing_expiry: "Confirm the evidenced membership expiry and populate the source record where required. Do not invent an expiry; Active Honorary records with no expiry or history are recognised as non-expiring.",
    unproven_membership_evidence: "Verify the recorded status and legacy expiry against evidenced membership history. Imported Active status plus a legacy expiry alone is review only, not proof of entitlement.",
    ambiguous_membership_evidence: "Compare the available membership history and resolve conflicting or ambiguous evidence in the source record before refreshing.",
  };
  if (Object.hasOwn(guidance, reason)) return guidance[reason];
  const key = String(reason).toLowerCase().replace(/[_-]/g, " ");
  if (/legacy|import/.test(key)) return "Check the imported record against evidenced membership history. Imported Active status plus a legacy expiry alone is not sufficient for automatic fulfilment.";
  if (/conflict|overlap|multiple|ambiguous/.test(key)) return "Compare membership periods and resolve conflicting evidence before using this record for fulfilment.";
  if (/class|tier|category/.test(key)) return "Confirm the member’s membership class and its journal entitlement in the membership record.";
  if (/address|postal|postcode/.test(key)) return "Confirm the member’s delivery address. Blank address fields are retained as blank; this report does not fill them in.";
  if (/date|expiry|history|evidence|period/.test(key)) return "Verify the membership history and expiry against source records. Correct missing or inconsistent dates before rerunning the report.";
  if (/status|active/.test(key)) return "Check the membership status against its evidenced membership period before using the record for fulfilment.";
  return "Investigate the stated reason in the source membership records, resolve the underlying data issue, then refresh this report. Review counts are diagnostics only; the workbook does not contain review rows.";
}

export function nmcExportFilename(response, reportDate) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const supplied = disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
  let filename = supplied;
  if (encoded) {
    try { filename = decodeURIComponent(encoded); } catch { /* Fall back to the plain filename. */ }
  }
  filename = filename?.split(/[\\/]/).pop().replace(/[\r\n"]/g, "");
  return filename?.toLowerCase().endsWith(".xlsx") ? filename : `bnms-nmc-membership-report-${/^\d{4}-\d{2}-\d{2}$/.test(reportDate || "") ? reportDate : "export"}.xlsx`;
}
