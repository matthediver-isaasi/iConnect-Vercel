---
name: Event invoice recovery authority
description: Recovery snapshots, existing-invoice evidence, payment ownership and rollout constraints.
---

Event invoice retries must use the durable operation authority, not rerun checkout or reconstruct invoices from today's catalogue.

**Why:** Historical booking rows can omit purchaser and tax provenance. Provider success can also precede failed local linkage. A missing local invoice is not proof that creation is safe. A captured Stripe intent must not acquire multiple accounting settlements through separate booking groups.

**How to apply:** Preserve immutable checkout financial evidence; use persisted provider IDs before mutable references; fence workers and claim payment ownership across groups/sources. Ambiguous historical work requires review. Never recreate after an ambiguous write merely because a remote search is empty or an idempotency retention period elapsed.

Health monitoring must read persisted completed-sweep evidence and eligibility-aware delays, never call Xero or trigger recovery. `needs_review` is not automatic recovery.

**Why:** Monitoring must not consume the quota it monitors; a successful empty sweep differs from a never-run worker, and permitted cooldowns differ from overdue work.

The user clarified that the sweep's purpose includes creating missing historical invoices, not merely identifying them. A missing checkout snapshot alone must not be treated as permanently unrepairable when original booking/provider evidence can support recovery.

**Why:** A discovery-only historical sweep did not meet the intended product requirement.

**How to apply:** Reconcile existing provider invoices first, reconstruct from verified evidence under an explicit accounting policy where necessary, then use the same fenced writer. Keep genuinely ambiguous tax, purchaser, payment and duplicate cases distinct from recoverable failures.

As of 2026-10-02, the user narrowed the current recovery scope: bookings before this point can be manually resolved; focus on automatic recovery for new bookings.

**Why:** The user explicitly said historical bookings do not need attention currently.

**How to apply:** Do not expand current rollout work into historical cleanup or treat existing historical review records as blockers for new-booking recovery. Retain existing safety checks and manual recovery capabilities.

Historical Stripe lookup may find a payment in test mode while the tenant currently uses live mode.

**Why:** The fallback between Stripe modes can successfully retrieve test payments from real booking rows; a successful capture alone does not prove live settlement.

**How to apply:** Verify provider livemode before posting live accounting settlement; never reinterpret test payments as live receipts.

Use Xero's normal invoice numbering, not the internal recovery identifier.

**Why:** The user explicitly requested correcting recovery invoices whose internal event hashes appeared as customer-facing invoice numbers. Existing paid invoices must be renamed in place, never recreated or repaid.

**How to apply:** Keep duplicate-prevention identity separate from numbering and retain provider invoice/payment IDs. Xero auto-numbering on creation does not establish that omitting the number on an update regenerates it; do not experiment on paid invoices.

Unchanged event and ticket information is useful reconstruction evidence, but absent ticket VAT does not establish zero VAT or whether a recorded booking amount is gross.

**Why:** Historical checkout omitted Xero's line-amount treatment, relying on its Exclusive default. A recorded amount can therefore conflict with the provider's tax-inclusive invoice total. The user wants reconstruction from booking/event/ticket evidence, not permanent rejection merely because a snapshot is absent.

**How to apply:** Preserve original economic intent and purchaser authority. Resolve explicit tax evidence or obtain the missing net/gross decision; never silently switch to Inclusive or use today's account default as historical proof.

Historical invoice evidence must ignore unrelated survey invitation revisions, while preserving every financial and purchaser field.

**Why:** A recovery-status mirror update caused the survey trigger to increment its revision and invalidate the very evidence just approved. This was reproduced against the actual trigger before a narrowly scoped audited repair was added.

**How to apply:** Avoid no-op mirror updates. For previously rejected evidence, prove that only the survey revision differs and retain the original rejection in append-only audit; never reset ambiguous provider writes to retry.

The user confirmed the BNMS £200 account-event ticket is VAT-inclusive at 20% (£166.67 net, £33.33 VAT).

**Why:** Explicit user confirmation resolved missing historical ticket tax evidence; it does not establish tax policy for other tickets.

**How to apply:** Keep inclusive treatment scoped to that ticket. Publish code that understands the explicit ticket policy before enabling the live policy, or an older Exclusive checkout can add VAT on top.

GFI does not charge VAT on event tickets. Its existing ticket settings and VAT charging behaviour must not change as a consequence of BNMS VAT work.

**Why:** The user explicitly required checking GFI compatibility before enabling the BNMS change.

**How to apply:** Keep BNMS data changes tenant/event/ticket scoped. Test legacy exempt/no-VAT ticket metadata without rewriting GFI tickets; no added VAT and uninterrupted invoice generation are separate requirements.

Legacy ticket tax metadata can be incomplete without being invalid: exempt codes may have no stored numeric percentage. Resolve missing invoice tax evidence against the tenant's provider, not by rewriting its catalogue.

**Why:** Requiring an explicit stored percentage stranded otherwise valid no-VAT invoices; treating every blank as zero would instead misinvoice taxable tenants.

**How to apply:** Preserve the checkout intent and amounts. Resolve provider evidence under the same retry/cooldown authority, freeze the result before any financial write, and reuse it on replay. Older workers must skip unresolved intents they cannot understand during mixed-version rollout.

QuickBooks event revenue and Stripe deposit mappings must not be inferred from a configured membership item or Xero's default account.

**Why:** A provider connection and a working membership item establish neither the event revenue classification nor where the original card receipt belongs. Reusing them silently would introduce financial policy, not merely recover an invoice.

**How to apply:** Obtain explicit event item/revenue and deposit-account policy, freeze it with the checkout intent, and leave missing mappings visibly unresolved without replaying historical bookings.

Missing QuickBooks event mappings are a configuration prerequisite, not a reason to stop implementing recovery.

**Why:** The user explicitly asked to finish the remaining sweeps after an audit stopped at missing account choices.

**How to apply:** Provide configurable mappings and visibly pause financial posting until supplied. Preserve all nonempty checkout mappings; only missing values may be resolved before the immutable prepared envelope is saved.

Event ticket VAT keys belong to Xero, even when checkout runs for a QuickBooks tenant. Do not treat them as QuickBooks TaxCode IDs or gate QuickBooks eligibility on the Xero enable setting.

**Why:** Cross-provider reuse otherwise silently excludes QuickBooks checkouts or resolves a wrong/nonexistent tax code.

**How to apply:** Select the explicit QuickBooks tax mapping and compare its rate and calculated tax with frozen checkout evidence. A mismatched rate requires review rather than inferred substitution.