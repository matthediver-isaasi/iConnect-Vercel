# GoCardless Monthly Membership Invoicing

**Author:** isaasi  
**Last Updated:** September 2026  
**Module:** Membership Payments / GoCardless Direct Debit

---

## Table of Contents

1. [Overview](#overview)
2. [The Common Monthly Journey](#the-common-monthly-journey)
3. [Annual Invoice with Monthly Part-Payments](#annual-invoice-with-monthly-part-payments)
4. [One Invoice per Monthly Instalment](#one-invoice-per-monthly-instalment)
5. [Comparison](#comparison)
6. [GoCardless Statuses and Timing](#gocardless-statuses-and-timing)
7. [When an Invoice or Payment Is Missing](#when-an-invoice-or-payment-is-missing)
8. [Further Information](#further-information)

---

## Overview

Monthly GoCardless membership plans collect an agreed amount by Direct Debit over a fixed number of instalments. The member or organisation first authorises a mandate, the monthly collection is then scheduled with GoCardless, and accounting is updated after GoCardless confirms that collection.

Administrators can use either of two accounting methods:

- **Annual invoice:** one invoice covers the full membership commitment, and each confirmed monthly collection is recorded against it as a part-payment.
- **Per-instalment invoices:** each confirmed monthly collection creates its own invoice, followed by a matching payment in Xero or QuickBooks.

The selected method is recorded when the plan starts. Changing the tier setting later affects new plans, not an existing plan already in progress.

---

## The Common Monthly Journey

Both accounting methods share the same GoCardless journey:

1. **Membership setup:** the member or organisation accepts the monthly terms and authorises a Direct Debit mandate, unless an active mandate can be reused.
2. **Collection scheduled:** once the mandate is active, the application creates the monthly collection schedule with GoCardless.
3. **Bank processing:** GoCardless requests the instalment through the banking system.
4. **Collection confirmed:** GoCardless changes the payment to **confirmed**. This is the point at which the application attempts the relevant Xero or QuickBooks accounting update.
5. **Payout:** GoCardless later includes the collected funds in a payout to the organisation's bank account.

**Timing is indicative, not guaranteed.** Direct Debit dates and processing times are controlled by GoCardless and the banking scheme. Setup and collection commonly take several working days, and a first collection can take longer while a new mandate is established. A scheduled collection should not be treated as confirmed money.

---

## Annual Invoice with Monthly Part-Payments

In annual mode, a separate membership invoicing process raises one invoice for the full annual membership amount and links it to the membership record. The GoCardless setup itself does not raise that annual invoice.

### Typical sequence

1. The monthly membership plan and Direct Debit mandate are set up.
2. The normal automatic, scheduled, or manual membership invoicing process raises the annual invoice.
3. GoCardless schedules and processes the first monthly collection.
4. When that collection reaches **confirmed**, a payment for the instalment amount is recorded against the linked annual invoice in Xero or QuickBooks.
5. Each later confirmed collection is applied to the same invoice as another part-payment.
6. GoCardless pays collected funds out separately according to its payout timetable.

The annual invoice therefore shows the overall membership charge and a reducing balance as monthly payments are applied.

**Important:** the annual invoice must already exist and be linked before a confirmed collection can be applied to it. If it has not been raised or linked, the collection can still succeed in GoCardless, but the accounting part-payment will be missing and needs investigation.

---

## One Invoice per Monthly Instalment

In per-instalment mode, no annual invoice should be raised for that membership year. Instead, accounting follows each successful monthly collection.

### Typical sequence

1. The monthly membership plan and Direct Debit mandate are set up.
2. GoCardless schedules and processes a monthly collection.
3. Nothing is invoiced merely because the payment was scheduled or submitted to the bank.
4. When the payment reaches **confirmed**, the application creates one invoice for that instalment in Xero or QuickBooks.
5. It then records a matching accounting payment against that invoice.
6. GoCardless pays the collected funds out separately according to its payout timetable.
7. The same sequence repeats for each later instalment.

An instalment invoice may occasionally exist without its matching accounting payment if, for example, the dedicated GoCardless bank account is not configured in the accounting connection. The invoice is retained so that a retry can add the payment without creating another invoice.

---

## Comparison

| Question | Annual invoice | Per-instalment invoices |
|----------|----------------|-------------------------|
| How many invoices are expected? | One for the membership year | One for each confirmed instalment |
| When is the invoice raised? | Separately through the normal membership invoicing process | Only after the corresponding GoCardless payment is confirmed |
| What happens on confirmation? | The instalment is applied as a part-payment to the linked annual invoice | An instalment invoice is created, then a matching payment is recorded |
| Should an annual invoice exist? | Yes | No |
| Does payout trigger invoicing? | No | No |

---

## GoCardless Statuses and Timing

The following stages should not be treated as interchangeable:

| Stage | Meaning |
|-------|---------|
| **Scheduled / pending** | A collection is planned or moving through the banking process. It has not yet been confirmed. |
| **Confirmed** | GoCardless has confirmed collection. This triggers the Xero or QuickBooks accounting update. |
| **Paid out** | GoCardless has included the funds in a payout to the organisation's bank account. This normally happens after confirmation and does not create the invoice or accounting payment. |

Confirmation is stronger than a scheduled or submitted status, but it is not an irreversible guarantee. Direct Debit refunds, reversals, or chargebacks can still occur later and should be handled through the organisation's normal finance and GoCardless processes.

Do not promise a fixed collection date or a one-working-day turnaround. Weekends, bank holidays, mandate setup, the Direct Debit scheme, and GoCardless processing all affect timing.

---

## When an Invoice or Payment Is Missing

Check the following in order:

1. **Check the GoCardless payment status.** If it is only scheduled, pending, or submitted, allow for the normal several-working-day Direct Debit process. Accounting is attempted at **confirmed**.
2. **Confirm the plan's invoicing method.** An existing plan keeps the method selected when it was started, even if the tier setting has since changed.
3. **For annual mode, find the annual invoice.** Confirm that it was raised by the expected membership invoicing process and is linked to the correct membership year. Without that link, the monthly part-payment cannot be applied.
4. **For per-instalment mode, look for both records.** Check whether the small invoice exists but remains unpaid in Xero or QuickBooks. This usually points to a payment-posting or bank-account configuration issue rather than a need to create another invoice.
5. **Check the accounting connection and GoCardless bank account setting.** Confirm that the tenant's Xero or QuickBooks connection is active and that the dedicated GoCardless bank account is configured.
6. **Review reconciliation and error information.** Per-instalment failures can be retried by reconciliation. Annual-mode part-payments require separate investigation when the annual invoice was missing at confirmation.
7. **Compare the correct events.** Confirmation and payout happen at different times. A collection can be confirmed but not yet paid out, and waiting for payout will not trigger a missing invoice.

Avoid manually creating a duplicate invoice until the plan mode, existing accounting records, and retry state have been checked.

---

## Further Information

For technical lifecycle details, safeguards, reconciliation behavior, known operational caveats, and deployment-readiness information, see [GoCardless Membership Lifecycle](./gocardless-membership-lifecycle.md).

This guide describes the intended user-facing behavior supported by the implementation. It does not claim that every Xero or QuickBooks sandbox scenario has been completed, and it is not banking or accounting-policy advice.