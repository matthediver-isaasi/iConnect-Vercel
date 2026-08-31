import assert from "node:assert/strict";
import test from "node:test";
import {
  accountingErrorGuidance,
  hasAccountingManagementCapability,
  missingPrerequisiteLabel,
  normalizeSalesAccountingConfiguration,
  serializeSalesAccountingConfiguration,
} from "./salesAccountingConfiguration.js";

test("normalizes readiness, zero tax rate, mappings and QuickBooks item options", () => {
  const configuration = normalizeSalesAccountingConfiguration({
    activeProvider: { id: "quickbooks", name: "QuickBooks" },
    isReady: false,
    missing: ["tax_mapping"],
    requiredTaxRates: [0, 2000],
    mappings: { 0: "zero-code" },
    availableTaxCodes: [{ id: "zero-code", name: "Zero rated" }],
    quickbooksSalesItemId: "item-1",
    availableItems: [{ id: "item-1", name: "Sales" }],
  });

  assert.equal(configuration.providerKey, "quickbooks");
  assert.equal(configuration.isReady, false);
  assert.deepEqual(configuration.requiredTaxRates.map((rate) => rate.label), ["0%", "20%"]);
  assert.equal(configuration.mappings["0"], "zero-code");
  assert.equal(configuration.availableItems[0].label, "Sales");
});

test("serializes Xero mappings as the backend PATCH array including zero", () => {
  const configuration = normalizeSalesAccountingConfiguration({
    activeProvider: "xero",
    isReady: true,
    requiredTaxRates: [0, 2000],
    mappings: [
      { taxRateBps: 0, providerTaxCodeId: "ZERO", providerTaxCodeName: "Zero Rated" },
      { taxRateBps: 2000, providerTaxCodeId: "OUTPUT", providerTaxCodeName: "20% VAT" },
    ],
    availableTaxCodes: [{ id: "ZERO", name: "Zero Rated" }, { id: "OUTPUT", name: "20% VAT" }],
    quickbooksSalesItemId: null,
    availableItems: [],
  });

  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, {
    mappings: configuration.mappings,
    quickbooksSalesItemId: null,
  }), {
    mappings: [
      { taxRateBps: 0, providerTaxCodeId: "ZERO" },
      { taxRateBps: 2000, providerTaxCodeId: "OUTPUT" },
    ],
  });
});

test("serializes QuickBooks mappings and required sales item", () => {
  const configuration = normalizeSalesAccountingConfiguration({
    activeProvider: "quickbooks",
    isReady: true,
    requiredTaxRates: [0, 2000],
    mappings: [
      { taxRateBps: 0, providerTaxCodeId: "NON", providerTaxCodeName: "Non" },
      { taxRateBps: 2000, providerTaxCodeId: "VAT20", providerTaxCodeName: "VAT 20" },
    ],
    availableTaxCodes: [{ id: "NON", name: "Non" }, { id: "VAT20", name: "VAT 20" }],
    quickbooksSalesItemId: "item-sales",
    availableItems: [{ id: "item-sales", name: "Sales" }],
  });

  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, {
    mappings: configuration.mappings,
    quickbooksSalesItemId: configuration.quickbooksSalesItemId,
  }), {
    mappings: [
      { taxRateBps: 0, providerTaxCodeId: "NON" },
      { taxRateBps: 2000, providerTaxCodeId: "VAT20" },
    ],
    quickbooksSalesItemId: "item-sales",
  });
});

test("rejects missing required mappings and QuickBooks item before PATCH", () => {
  const configuration = normalizeSalesAccountingConfiguration({
    activeProvider: "quickbooks",
    requiredTaxRates: [0, 2000],
    mappings: [{ taxRateBps: 0, providerTaxCodeId: "NON" }],
  });
  assert.throws(() => serializeSalesAccountingConfiguration(configuration, {
    mappings: configuration.mappings,
    quickbooksSalesItemId: null,
  }), /20%/);
});

test("requires an explicit accounting-management capability", () => {
  assert.equal(hasAccountingManagementCapability({ permissions: { canManageAccounting: true } }), true);
  assert.equal(hasAccountingManagementCapability({ permissions: { canManageAccounting: false }, is_admin: true }), false);
  assert.equal(hasAccountingManagementCapability(), false);
});

test("returns actionable Sales settings guidance for accounting configuration errors", () => {
  const expected = {
    ACCOUNTING_TAX_MAPPING_REQUIRED: "Map every required tax rate in Sales settings, then try again.",
    ACCOUNTING_SALES_ITEM_REQUIRED: "Choose the QuickBooks sales item in Sales settings, then try again.",
    ACCOUNTING_TAX_CODE_INVALID: "A mapped tax code is no longer available. Update the tax mappings in Sales settings, then try again.",
    ACCOUNTING_SALES_ITEM_INVALID: "The selected QuickBooks sales item is no longer available. Choose another item in Sales settings, then try again.",
  };
  for (const [code, message] of Object.entries(expected)) {
    assert.deepEqual(accountingErrorGuidance({ payload: { code } }), {
      code,
      message,
      href: "/sales/settings",
    });
  }
  assert.equal(accountingErrorGuidance({ payload: { code: "OTHER" } }), null);
  assert.equal(missingPrerequisiteLabel("quickbooksSalesItemId"), "Choose the QuickBooks sales item used for invoice lines.");
});