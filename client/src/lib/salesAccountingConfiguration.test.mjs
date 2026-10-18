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

test("normalizes product defaults and natural-name options including unavailable saved defaults", () => {
  const saved = { provider: "xero", id: "OUTPUT", name: "Standard sales", rateBps: 2000 };
  const configuration = normalizeSalesAccountingConfiguration({ data: {
    productTaxOptions: { provider: "xero", items: [{ id: "OUTPUT", name: "Standard sales", rateBps: 2000, selectable: true }] },
    defaultProductTaxCode: saved, defaultProductTaxCodeUnavailable: true,
    availableTaxCodes: [{ id: "PRIVATE", label: "Internal code", name: "Zero rated" }, { id: "SECRET" }],
  } });
  assert.deepEqual(configuration.defaultProductTaxCode, saved);
  assert.equal(configuration.defaultProductTaxCodeUnavailable, true);
  assert.deepEqual(configuration.productTaxOptions.items[0], { ...saved, selectable: true });
  assert.deepEqual(configuration.availableTaxCodes.map((code) => code.label), ["Zero rated", "VAT code unavailable"]);
  assert.equal(normalizeSalesAccountingConfiguration().defaultProductTaxCode, null);
});

test("default PATCH is opt-in, identity-only, clearable, and preserves all existing mappings", () => {
  const code = { provider: "xero", id: "OUTPUT", name: "Standard sales", rateBps: 2000, selectable: true };
  const configuration = normalizeSalesAccountingConfiguration({
    activeProvider: "xero", mappings: { 0: "ZERO", 2000: "OLD" },
    productTaxOptions: { provider: "xero", items: [code] }, defaultProductTaxCode: code,
  });
  const mappings = [{ taxRateBps: 0, providerTaxCodeId: "ZERO" }, { taxRateBps: 2000, providerTaxCodeId: "OLD" }];
  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, { defaultProductTaxCode: code }), { mappings });
  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, { defaultProductTaxCode: code, defaultProductTaxCodeChanged: true }), {
    mappings, defaultProductTaxCode: { provider: "xero", id: "OUTPUT" },
  });
  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, { defaultProductTaxCode: null, defaultProductTaxCodeChanged: true }), { mappings, defaultProductTaxCode: null });
  assert.throws(() => serializeSalesAccountingConfiguration(configuration, {
    defaultProductTaxCodeChanged: true, defaultProductTaxCode: { provider: "quickbooks", id: "OUTPUT" },
  }), /Select a synced provider VAT code/);
  configuration.defaultProductTaxCodeUnavailable = true;
  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, {}), { mappings });
  configuration.productTaxOptions.items[0].selectable = false;
  assert.throws(() => serializeSalesAccountingConfiguration(configuration, { defaultProductTaxCode: code, defaultProductTaxCodeChanged: true }), /Select a synced provider VAT code/);
});

test("provider sync errors allow unrelated saves and clearing, but not selecting a default", () => {
  const code = { provider: "xero", id: "VAT", name: "Sales VAT", selectable: true };
  const configuration = normalizeSalesAccountingConfiguration({
    productTaxOptions: { provider: "xero", items: [code], error: "Sync unavailable" },
    defaultProductTaxCode: code,
  });
  assert.equal(configuration.productTaxOptions.error, "Sync unavailable");
  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, {}), { mappings: [] });
  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, { defaultProductTaxCodeChanged: true, defaultProductTaxCode: null }), { mappings: [], defaultProductTaxCode: null });
  assert.throws(() => serializeSalesAccountingConfiguration(configuration, { defaultProductTaxCodeChanged: true, defaultProductTaxCode: code }), /Select a synced provider VAT code/);
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

test("general settings need no mandatory zero or default percentage mapping", () => {
  const configuration = normalizeSalesAccountingConfiguration({ activeProvider: "xero" });
  assert.deepEqual(configuration.requiredTaxRates, []);
  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, { mappings: {} }), { mappings: [] });
});

test("QuickBooks item remains required without any legacy rates", () => {
  const configuration = normalizeSalesAccountingConfiguration({ activeProvider: "quickbooks", requiredTaxRates: [] });
  assert.throws(() => serializeSalesAccountingConfiguration(configuration, {}), /QuickBooks sales item/);
  assert.deepEqual(serializeSalesAccountingConfiguration(configuration, { quickbooksSalesItemId: "sales-item" }), { mappings: [], quickbooksSalesItemId: "sales-item" });
});

test("small legacy basis-point rates display accurately", () => {
  const configuration = normalizeSalesAccountingConfiguration({ requiredTaxRates: [0, 50, 100, 725] });
  assert.deepEqual(configuration.requiredTaxRates.map((rate) => rate.label), ["0%", "0.5%", "1%", "7.25%"]);
});

test("returns actionable Sales settings guidance for accounting configuration errors", () => {
  const expected = {
    ACCOUNTING_TAX_MAPPING_REQUIRED: "Map every required tax rate in Sales settings, then try again.",
    ACCOUNTING_SALES_ITEM_REQUIRED: "Choose the QuickBooks sales item in Sales settings, then try again.",
    ACCOUNTING_TAX_CODE_INVALID: "A saved provider tax code is no longer available. Sync provider codes and explicitly select a replacement on the product or quote line.",
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