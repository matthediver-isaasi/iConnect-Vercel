import React, { useState } from "react";
import { Link } from "react-router-dom";
import { BADGE_HELP_PATH, badgeDocumentUrl, previewBadgePdf, useBadgeInstructions, useBadgeTenant } from "@/hooks/useBadgeInstructions";

export default function BadgeInstructionsHelpLink({ memberTenantId }) {
  const tenantId = useBadgeTenant(memberTenantId);
  return <TenantHelpLink key={tenantId || "standard"} tenantId={tenantId} />;
}

function TenantHelpLink({ tenantId }) {
  const query = useBadgeInstructions(tenantId);
  const [error, setError] = useState("");
  const className = "text-indigo-600 hover:text-indigo-700 underline-offset-2 hover:underline font-medium";
  if (!query.isError && query.data?.mode === "pdf" && query.data.document) {
    return <>
      <a href={badgeDocumentUrl(tenantId)} target="_blank" rel="noopener noreferrer" className={className}
        onClick={(event) => previewBadgePdf(event, tenantId, setError)}>How to share your badge<span className="sr-only"> (PDF, opens in a new tab)</span></a>
      {error && <span role="alert" className="block text-sm text-red-700">{error} <Link to={BADGE_HELP_PATH} className={className}>Open standard badge help</Link></span>}
    </>;
  }
  return <Link to={BADGE_HELP_PATH} className={className}>How to share your badge</Link>;
}
