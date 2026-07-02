import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertTriangle } from "lucide-react";

const REASON_LABELS = {
  login_disabled: "Login Disabled",
  guest_expired: "Guest Expired",
  account_locked: "Account Locked",
  soft_deleted: "Member Deleted",
  tenant_mismatch: "Wrong Tenant",
  no_membership: "No Tenant Membership",
  no_member: "No Member Record",
};

const REASON_DETAILS = {
  login_disabled: "An admin has disabled login on this account.",
  guest_expired: "Guest access has expired.",
  account_locked: "Account is temporarily locked due to failed login attempts.",
  soft_deleted: "The auth flow resolves a soft-deleted (anonymized) member row for this account.",
  tenant_mismatch: "This account does not belong to the current tenant.",
  no_membership: "There is no tenant_membership record for this account in this tenant.",
  no_member: "No active member record was found for this account.",
};

/**
 * Badge that mirrors what `api/auth/login.js` would actually decide for the
 * given member, by querying `/api/admin/members/:memberId/login-status`.
 *
 * - Green "Active" if effective login is allowed.
 * - Red badge labelled with the real reason if blocked.
 * - Orange "Mismatch" warning if the auth flow would resolve a *different*
 *   member row than the one being viewed (stale tenant_membership) or if
 *   duplicate active member rows are detected for the same (tenant, email).
 */
export default function MemberLoginStatusBadge({ memberId, fallbackEnabled }) {
  const { data: status } = useQuery({
    queryKey: ["member-login-status", memberId],
    enabled: !!memberId,
    queryFn: async () => {
      const res = await fetch(`/api/admin/members/${memberId}/login-status`, {
        credentials: "include",
      });
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 30 * 1000,
  });

  // While loading or if the endpoint failed, fall back to the legacy
  // login_enabled flag so the badge never appears blank.
  if (!status) {
    if (fallbackEnabled === false) {
      return (
        <Badge
          variant="secondary"
          className="bg-red-100 text-red-700"
          data-testid="badge-login-status"
        >
          Login Disabled
        </Badge>
      );
    }
    return (
      <Badge
        variant="secondary"
        className="bg-green-100 text-green-700"
        data-testid="badge-login-status"
      >
        Active
      </Badge>
    );
  }

  const duplicates = status.duplicateActiveMembers || [];
  const hasDuplicates = duplicates.length > 1;

  const renderBadges = () => {
    const badges = [];
    if (status.canLogin) {
      badges.push(
        <Badge
          key="status"
          variant="secondary"
          className="bg-green-100 text-green-700"
          data-testid="badge-login-status"
        >
          Active
        </Badge>
      );
    } else {
      const label = REASON_LABELS[status.reason] || "Login Disabled";
      const detail = REASON_DETAILS[status.reason] || status.message || "";
      badges.push(
        <Tooltip key="status">
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="bg-red-100 text-red-700"
              data-testid="badge-login-status"
            >
              {label}
            </Badge>
          </TooltipTrigger>
          {detail && <TooltipContent>{detail}</TooltipContent>}
        </Tooltip>
      );
    }

    if (status.mismatch) {
      badges.push(
        <Tooltip key="mismatch">
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="bg-warning/10 text-warning inline-flex items-center gap-1"
              data-testid="badge-login-status-mismatch"
            >
              <AlertTriangle className="w-3 h-3" />
              Auth resolves different record
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            The login flow would authenticate against a different member row
            than the one shown here. Resolved id: {status.resolvedMemberId || "none"}.
          </TooltipContent>
        </Tooltip>
      );
    }

    if (status.hasTenantMembership === false) {
      badges.push(
        <Tooltip key="no-tm">
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="bg-warning/10 text-warning inline-flex items-center gap-1"
              data-testid="badge-login-status-no-tenant-membership"
            >
              <AlertTriangle className="w-3 h-3" />
              No tenant membership
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            There is no tenant_membership record for this account in this
            tenant. Login currently still works via legacy fallbacks but this
            should be reconciled.
          </TooltipContent>
        </Tooltip>
      );
    }

    if (hasDuplicates) {
      badges.push(
        <Tooltip key="dupes">
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="bg-warning/10 text-warning inline-flex items-center gap-1"
              data-testid="badge-login-status-duplicates"
            >
              <AlertTriangle className="w-3 h-3" />
              {duplicates.length} duplicate member rows
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            More than one active member row exists for this email in this
            tenant. This is the class of data inconsistency that causes the
            admin badge and the auth flow to disagree.
          </TooltipContent>
        </Tooltip>
      );
    }

    return badges;
  };

  return <>{renderBadges()}</>;
}
