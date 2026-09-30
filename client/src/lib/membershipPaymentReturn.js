// Shared, deliberately small policy for the dedicated membership provider
// return pages. Provider redirect query strings are untrusted: they may choose
// a page inside this site, but never an external destination.

export const MEMBERSHIP_RETURN_ROUTES = Object.freeze([
  Object.freeze({ provider: "direct-debit", outcome: "complete", path: "/membership/direct-debit/complete", pageName: "DirectDebitReturn" }),
  Object.freeze({ provider: "direct-debit", outcome: "cancelled", path: "/membership/direct-debit/cancelled", pageName: "DirectDebitReturn" }),
  Object.freeze({ provider: "monthly-card", outcome: "complete", path: "/membership/monthly-card/complete", pageName: "MonthlyCardReturn" }),
  Object.freeze({ provider: "monthly-card", outcome: "cancelled", path: "/membership/monthly-card/cancelled", pageName: "MonthlyCardReturn" }),
]);

function normalisePathname(pathname = "") {
  const path = pathname.split("?")[0].split("#")[0].toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function getMembershipReturnRoute(pathname) {
  const normalised = normalisePathname(pathname);
  return MEMBERSHIP_RETURN_ROUTES.find((route) => route.path === normalised) || null;
}

export function getMembershipReturnPageName(pathname) {
  return getMembershipReturnRoute(pathname)?.pageName || null;
}

/**
 * Return a bounded same-origin path suitable for a React Router Link.
 * Hashes are deliberately removed and only a relative path is returned.
 */
export function safeMembershipReturnPath(value, origin = "https://membership-return.invalid") {
  if (typeof value !== "string" || !value || value.length > 1024 || value !== value.trim()) {
    return null;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return null;
  }

  try {
    const target = new URL(value, origin);
    if (
      target.origin !== origin
      || target.username
      || target.password
      || !target.pathname.startsWith("/")
    ) {
      return null;
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return null;
  }
}

export function membershipLoginPath(pathname, search = "") {
  const returnTo = safeMembershipReturnPath(`${pathname || ""}${search || ""}`);
  return returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login";
}

/**
 * This is presentation policy only. Agreement status comes exclusively from
 * the existing authenticated, read-only provider endpoints; a callback URL is
 * never treated as proof that a mandate or card payment succeeded.
 */
export function classifyMembershipReturn({ provider, outcome, agreement, verification = "verified" }) {
  if (verification === "loading") return "loading";
  if (verification !== "verified") return "unverified";

  if (!agreement) {
    return outcome === "cancelled" ? "cancelled" : "unverified";
  }

  switch (agreement.status) {
    case "active":
      return "active";
    case "mandate_pending":
      return provider === "direct-debit" ? "setup_pending" : "verification_pending";
    case "first_payment_pending":
      return "payment_pending";
    case "payment_setup_required":
      return "verification_pending";
    case "payment_grace_period":
    case "payment_overdue":
      return "payment_attention";
    case "payment_plan_cancelled":
    case "expired":
      return "cancelled";
    default:
      return "unverified";
  }
}