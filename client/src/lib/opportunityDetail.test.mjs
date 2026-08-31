import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpportunityDetail } from "./opportunityDetail.js";

test("preserves contacts and stage history from the flattened fullDetail response", () => {
  const contact = { id: "role-1", member_id: "member-1", role: "Decision maker" };
  const history = { id: "history-1", from_stage_id: "stage-a", to_stage_id: "stage-b" };
  const response = {
    id: "opportunity-1",
    name: "Renewal",
    permissions: { canEdit: true, canManage: false },
    "contact-roles": [contact],
    history: [history],
    collaborators: [],
    notes: [],
    tasks: [],
    documents: [],
    activity: [],
  };

  const normalized = normalizeOpportunityDetail(response);

  assert.equal(normalized.opportunity.id, "opportunity-1");
  assert.deepEqual(normalized.collections.contacts, [contact]);
  assert.deepEqual(normalized.collections.stageHistory, [history]);
  assert.deepEqual(normalized.permissions, response.permissions);
});

test("keeps legacy nested aliases compatible", () => {
  const contact = { id: "role-legacy" };
  const history = { id: "history-legacy" };
  const normalized = normalizeOpportunityDetail({
    data: {
      opportunity: { id: "opportunity-2" },
      contact_roles: { items: [contact] },
      stage_history: { data: [history] },
    },
  });

  assert.deepEqual(normalized.collections.contacts, [contact]);
  assert.deepEqual(normalized.collections.stageHistory, [history]);
});

test("preserves invoice DTO and its accepted quote identity", () => {
  const invoice = { id: "invoice-1", quote_id: "quote-1" };
  const normalized = normalizeOpportunityDetail({
    opportunity: { id: "opportunity-1" },
    permissions: { canViewInvoice: true },
    invoice,
  });

  assert.equal(normalized.invoice, invoice);
  assert.equal(normalized.invoiceQuoteId, "quote-1");
});

test("keeps a null current invoice distinct from historical invoices", () => {
  const normalized = normalizeOpportunityDetail({
    opportunity: { id: "opportunity-1", invoice: { id: "stale-invoice" } },
    invoice: null,
    active_provider: "New provider",
    invoice_history: [{ id: "stale-invoice", provider: "Old provider" }],
  });

  assert.equal(normalized.invoice, null);
  assert.equal(normalized.activeProvider, "New provider");
  assert.equal(normalized.invoices.length, 1);
});