import { format } from "date-fns";

export const isMembershipChangeVoucher = voucher => voucher?.funding_source === "membership_change";
export const membershipCreditManagementNotice = "Membership-change credit is managed by membership financial operations. Available for eligible membership payments only; ordinary edit, delete and expiry adjustments are unavailable.";
export function voucherExpiryTime(voucher) {
  if (!voucher?.expires_at) return Infinity;
  const time = Date.parse(voucher.expires_at);
  return Number.isFinite(time) ? time : Infinity;
}
export function compareVoucherExpiry(a, b) {
  const first = voucherExpiryTime(a), second = voucherExpiryTime(b);
  return first === second ? 0 : first < second ? -1 : 1;
}
export function VoucherExpiry({ voucher, pattern = "MMM d, yyyy", prefix = "Expires " }) {
  if (!voucher?.expires_at) return "No expiry";
  const time = Date.parse(voucher.expires_at);
  return Number.isFinite(time) ? `${prefix}${format(new Date(time), pattern)}` : "Expiry unavailable";
}
export function MembershipCreditNotice({ voucher }) {
  if (!isMembershipChangeVoucher(voucher)) return null;
  return <p className="text-xs text-muted-foreground mt-2" data-testid={`membership-credit-managed-${voucher.id}`}>{membershipCreditManagementNotice}</p>;
}
