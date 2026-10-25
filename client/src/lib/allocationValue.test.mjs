import test from "node:test";
import assert from "node:assert/strict";
import { allocationNetMinor, allocationMoney } from "./allocationValue.mjs";
import { registrationPricePaidPresentation, registrationTicketPricePresentation, registrationTicketPriceExport } from "./eventRegistrationRecordedFinancial.js";
import { formatRegistrationPricePaid } from "./eventRegistrationPricePaid.js";

test("allocation total converts exact decimal currency into safe whole minor units", () => {
  assert.equal(allocationNetMinor("127.43", "GBP"), 12743);
  assert.equal(allocationNetMinor("0", "GBP"), 0);
  assert.equal(allocationNetMinor(" 18.1 ", "GBP"), 1810);
  assert.equal(allocationNetMinor("12", "JPY"), 12);
  assert.equal(allocationNetMinor("12.345", "KWD"), 12345);
  for (const invalid of ["", "-1", "-0", "12.345", "1e3", "Infinity", "NaN", "1,000", ".5", "2.", "9007199254740992"]) {
    assert.equal(allocationNetMinor(invalid, "GBP"), null, invalid);
  }
  assert.equal(allocationNetMinor("1.1", "JPY"), null);
  assert.equal(allocationMoney(null, "GBP"), "Unavailable");
});

test("pending proposal prices never render or export zero, nor suggest an unpaid invoice", () => {
  for (const value of [0, null, 127.43]) {
    const attendee = { price_paid_status: "proposal_pending", price_paid: value, ticket_price: value };
    assert.deepEqual(registrationPricePaidPresentation(attendee), { label: "Pending allocation", pending: false });
    assert.equal(registrationTicketPricePresentation(attendee).amount, null);
    assert.equal(registrationTicketPriceExport(attendee), "Pending allocation");
    assert.equal(formatRegistrationPricePaid(attendee), "Pending allocation");
  }
});

test("assigned proposal values display after allocation instead of Unavailable", () => {
  const attendee = { price_paid_status: "proposal_attributed", price_paid: 120, ticket_price: 120 };
  assert.equal(registrationPricePaidPresentation(attendee).label, "£120.00");
  assert.equal(formatRegistrationPricePaid(attendee), "£120.00");
});
