"""Build and render the BNMS guide using only verified synthetic UI evidence."""
from pathlib import Path
import pymupdf as fitz

out = Path("generated-artifacts/stripe-payout")
out.mkdir(parents=True, exist_ok=True)
doc = fitz.open()
css = """
body { font-family: sans-serif; font-size: 11pt; color: #24343b; line-height: 1.4; }
h1 { font-size: 24pt; color: #185459; margin: 0 0 10pt; }
h2 { font-size: 15pt; color: #185459; margin: 15pt 0 6pt; }
p { margin: 0 0 9pt; }
li { margin-bottom: 6pt; }
.note { background: #edf5f4; padding: 10pt; }
"""

def page(number, html, bottom=775):
    p = doc.new_page(width=595, height=842)
    p.insert_text((42, 30), "BNMS  /  FINANCE USER GUIDE", fontsize=9, color=(0.1, 0.33, 0.35))
    remaining, scale = p.insert_htmlbox(fitz.Rect(42, 52, 553, bottom), html, css=css, scale_low=1)
    if remaining < 0:
        raise RuntimeError(f"Guide page {number} overflows")
    p.insert_text((42, 811), "Stripe Payout Reconciliation  |  Safe examples only  |  November 2026", fontsize=8)
    p.insert_text((540, 811), str(number), fontsize=9)
    return p

p = page(1, """
<h1>Find a Stripe bank payout</h1>
<p>This read-only report connects automatic Stripe payouts with their transactions
and the invoice references stored in the member portal. It does not change
payments, memberships, Stripe or Xero.</p>
<h2>1. Open the report</h2>
<p>Sign in to the BNMS portal as an authorised finance administrator. Open
<b>Stripe Payout Reconciliation</b> from the navigation menu. If it is not visible,
ask your administrator to check your access to that report under Commerce.</p>
<h2>2. Choose the payout</h2>
<p>Under <b>Stripe mode</b>, choose <b>Live</b> for real funds. <b>Test</b> is only
test data; changing this choice does not change payment settings.</p>
<p>Set <b>Arrival from</b> and <b>Arrival to</b>. These filter the expected bank
arrival date, not the dates customers paid. Use <b>Previous</b> and <b>Next</b> to
browse more payouts. Select <b>View</b> beside the required payout.</p>
<p>Wait for <b>Retrieval: Complete</b>. Check the payout ID, arrival date,
currency and status against Stripe and your bank statement. “Paid” is Stripe's
status; confirm receipt with your bank separately.</p>
""", bottom=455)
image = out / "report-example.png"
if image.exists():
    source = fitz.open(str(image))
    rect = source[0].rect
    pix = source[0].get_pixmap(clip=fitz.Rect(rect.width * .20, 0, rect.width * .98, rect.height * .90))
    p.insert_image(fitz.Rect(42, 465, 553, 763), stream=pix.tobytes("png"), keep_proportion=True)
    source.close()
    p.insert_text((42, 780), "Verified example screen: fictional payout and invoice, not BNMS financial data.", fontsize=8)

page(2, """
<h1>Read the totals and invoice links</h1>
<h2>Three separate checks</h2>
<ul>
<li><b>Retrieval: Complete</b> means all transaction and supported stored-link
pages have been read. It does not mean every invoice was found.</li>
<li><b>Balance: Balanced</b> means the transaction net total equals the payout
amount, with no other currency mixed in. It does not prove all invoices match.</li>
<li><b>Invoices</b> shows how many transaction rows have matched invoice evidence.
Read each row's match status and explanation, even when the balance is zero.</li>
</ul>
<h2>Gross, Fee and Net</h2>
<p><b>Gross</b> is the signed transaction amount before the Stripe fee.
<b>Fee</b> is Stripe's reported fee; <b>Net = Gross minus Fee</b>. For example,
a fictional GBP 150.00 payment with a GBP 3.00 fee contributes GBP 147.00 net.</p>
<p>Refunds normally reduce the payout. A fictional GBP -20.00 refund with no fee
contributes GBP -20.00 net. Fee reversals may themselves be negative. The report
keeps Stripe's signs; it does not assume every fee is a positive charge.</p>
<p><b>Currency totals</b> keeps currencies separate.
<b>Variance (net − payout)</b> should be zero for a balanced payout. A non-zero
variance needs investigation; do not adjust records simply to force it to zero.</p>
<h2>Open an invoice</h2>
<p>In <b>Balance transactions</b>, scroll horizontally to see source references,
Stripe identifiers, invoice evidence and the match explanation. Select a linked
invoice number or ID to open Xero. You may need to sign in to Xero with access
to the correct organisation.</p>
<p>Several bookings may share one payment. Several invoice references may appear
on one transaction. The report counts that transaction once and does not split
or allocate its amount between invoices.</p>
<p class="note"><b>Refund caution:</b> invoice links on a refund refer to the original
payment's invoices. They do not prove that a credit note was created or allocated.</p>
""")

page(3, """
<h1>Export and investigate exceptions</h1>
<h2>Download the CSV</h2>
<p>When retrieval is complete, select <b>Download CSV</b> in <b>Payout detail</b>.
The download contains the same complete transaction set, source identifiers,
invoice references and links, match explanations, currency totals and variance.
It can still contain unmatched items or a non-zero variance.</p>
<p>The CSV labels amounts in <b>minor units</b>: for GBP, 100 means GBP 1.00.
Check the currency before converting; not every currency uses 100 minor units.
The mode is recorded so Test data cannot be confused with Live. Text is protected
against spreadsheet formulas. Keep exports in your approved finance storage and
share only with authorised colleagues.</p>
<h2>What the match status means</h2>
<ul>
<li><b>Matched:</b> exact stored payment and Xero invoice evidence was found.</li>
<li><b>Missing invoice:</b> a payment record exists, but an invoice ID or accounting
provider is missing. Ask your finance administrator to check the original record.</li>
<li><b>Unmatched:</b> no supported exact link was found. This can include historical,
external or recurring payments. It does not prove an invoice never existed.</li>
<li><b>Ambiguous:</b> stored evidence conflicts. Links are withheld rather than guessed.</li>
<li><b>Other accounting provider:</b> the stored invoice is not a Xero invoice.</li>
<li><b>Unsupported source:</b> the row may be a fee, dispute, reserve, adjustment
or another source without a supported payment link. Its amount stays in totals.</li>
</ul>
<h2>Limits and next steps</h2>
<p>Manual and instant payout attribution is unsupported. Historic automatic payouts
depend on accessible Stripe account history and retained payment references.
BNMS's historical matching completeness has not been verified. This report does
not combine multiple Stripe accounts or cover platform subscription billing.</p>
<p>If retrieval fails, no complete CSV is offered. Select <b>Retry</b>. If the issue
persists, or a variance or missing link remains, give your finance administrator
the mode, date range, payout ID, relevant transaction IDs and displayed explanation
through your usual secure support channel. Ask them to compare Stripe, the original
booking/payment record and Xero. Do not send account keys or customer card details.</p>
<p class="note">This report does not update Xero, create credit notes, repair history,
post fees or reconcile your bank account. It supports investigation and does not
replace accounting advice.</p>
""")
pdf = out / "BNMS-Stripe-Payout-Reconciliation-Guide.pdf"
doc.set_metadata({"title": "BNMS Stripe Payout Reconciliation Guide", "author": "BNMS finance guidance"})
doc.save(pdf)
for i, p in enumerate(doc):
    p.get_pixmap(matrix=fitz.Matrix(1.25, 1.25)).save(out / f"guide-page-{i + 1}.png")
    for block in p.get_text("blocks"):
        if block[3] > 825:
            raise RuntimeError(f"Page {i + 1} text clipped")
print(f"Created and rendered {pdf} ({len(doc)} pages)")
