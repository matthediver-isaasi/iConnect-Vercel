import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("./MemberMembershipInstalments.jsx", import.meta.url),
  "utf8",
);
const tabSource = fs.readFileSync(
  new URL("../MemberMembershipTab.jsx", import.meta.url),
  "utf8",
);

test("monthly instalments load only after a linked history row is expanded", () => {
  assert.match(source, /MEMBER_INSTALMENTS_ENDPOINT\s*=\s*["']\/api\/membership\/member-membership["']/);
  assert.match(source, /if\s*\(!expanded\s*\|\|\s*!historyId/);
  assert.match(source, /recordId:\s*String\(historyId\)/);
  assert.match(source, /instalments:\s*"true"/);
  assert.match(source, /page:\s*String\(page\)/);
  assert.match(source, /source:\s*membershipSource/);
  assert.match(source, /source = null/);
  assert.match(tabSource, /MemberMembershipInstalmentsToggle/);
  assert.match(tabSource, /expandedInstalmentHistoryId/);
  assert.match(tabSource, /source=\{membershipSource\}/);
  assert.match(tabSource, /membershipSource.*organisation/);
  assert.match(tabSource, /const personalHistory = history\.filter/);
  assert.match(tabSource, /!config && !isLoading/);
  assert.match(tabSource, /Pricing controls are unavailable, but membership fee history remains visible below/);
  assert.match(tabSource, /Membership Fee History/);
  assert.match(source, /setLoadingPage\(\(current\) => \(current === page \? null : current\)\)/);
});

test("the instalment ledger keeps collection and accounting outcomes distinct", () => {
  for (const status of [
    "pending",
    "failed",
    "skipped",
    "missing_accounting",
    "invoice_unpaid",
    "invoice_created",
    "posted",
  ]) {
    assert.match(source, new RegExp(status));
  }
  assert.match(source, /No monthly collections recorded/);
  assert.match(source, /No accounting provider is connected/);
  assert.match(source, /role="alert"/);
  assert.match(source, /Loading monthly instalments/);
  assert.match(source, /Partial means the term is not fully paid/);
  assert.match(source, /collectionStatus/);
  assert.match(source, /accountingStatus/);
  assert.match(source, /Collection/);
  assert.match(source, /Accounting:/);
  assert.match(tabSource, /Partial is the whole-term status/);
});

test("pagination is bounded and supports both directions", () => {
  assert.match(source, /hasNext/);
  assert.match(source, /hasPrevious/);
  assert.match(source, /button-member-instalments-previous/);
  assert.match(source, /button-member-instalments-next/);
  assert.match(source, /setPage\(\(current\) => current \+ 1\)/);
});

test("monthly invoice actions use the authorized membership invoice endpoint", () => {
  assert.match(source, /onViewInvoice\?\.\(item\.paymentRef, item\.invoiceNumber, "instalment", item\.invoiceUrl, source\)/);
  assert.match(source, /onDownloadInvoice\?\.\(item\.paymentRef, item\.invoiceNumber, "instalment", item\.invoiceUrl, source\)/);
  assert.match(tabSource, /params\.set\('instalment', 'true'\)/);
  assert.match(tabSource, /params\.set\('paymentRef', recordId\)/);
  assert.match(tabSource, /membershipSource === 'organisation' \? 'organisation' : 'personal'/);
  assert.match(source, /item\.invoiceUrl/);
});

test("annual history invoice controls remain on the existing path", () => {
  assert.match(tabSource, /handleViewInvoice\(record\.id, invoiceNumber, membershipSource\)/);
  assert.match(tabSource, /handleDownloadInvoice\(record\.id, invoiceNumber, membershipSource\)/);
  assert.match(tabSource, /isMonthlyMembershipRecord\(record\)/);
});