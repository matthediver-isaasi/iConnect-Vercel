import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import DirectoryGuestDetailDialog from "@/components/directory/DirectoryGuestDetailDialog";
import { publicClient } from "@/api/publicClient";
import { readDirectoryCarouselDetails } from "./directoryCarouselDetails.mjs";

// Guest-safe presentation is intentional even for authenticated editors/readers:
// opting into details is not a grant to reveal member-only directory content.
export default function CanvasDirectoryDetails({ record, directorySlug, entityType, config = {}, onClose, carousel }) {
  const trigger = useRef(typeof document === "undefined" ? null : document.activeElement);
  const tenant = publicClient.getTenantSlug();
  const details = useQuery({
    queryKey: ["canvas", "directory-details", tenant, directorySlug, record.id, entityType,
      carousel?.source || "", carousel?.directoryId || "", carousel?.viewerIdentity || ""],
    queryFn: async ({ signal }) => {
      if (carousel) return readDirectoryCarouselDetails({
        ...carousel, directorySlug, tenant, recordId: record.id, entityType, signal,
      });
      const params = new URLSearchParams({ slug: directorySlug, organizationId: record.id });
      if (tenant) params.set("tenant", tenant);
      // The canonical organisation dialog reads its projected reverse-card
      // data from this directory-scoped endpoint, never Organization.get().
      const response = await fetch(`/api/dynamic-directory/config?${params}`, { credentials: "include", signal, cache: "no-store" });
      if (!response.ok) throw new Error("Directory details unavailable");
      const data = await response.json();
      const organization = data.organizations?.find(item => item.id === record.id);
      if (!organization || data.directory?.slug !== directorySlug) throw new Error("Record no longer in directory");
      return {
        record: organization,
        directory: data.directory,
        displaySettings: data.displaySettings,
        fields: data.orgCustomFields || [],
        values: Object.fromEntries((data.allOrgPreferenceValues || [])
          .filter(value => value.organization_id === record.id)
          .map(value => [value.field_id, value.value])),
      };
    },
    enabled: !!carousel || entityType === "organization",
    retry: false,
    staleTime: 0,
    gcTime: 0,
    placeholderData: () => undefined,
  });
  const close = () => {
    onClose();
    // Cards are not Radix DialogTriggers. Restore focus explicitly to the
    // activating card when closing by Escape, overlay or Close.
    const element = trigger.current;
    if (element?.isConnected) requestAnimationFrame(() => element.focus());
  };
  // Match the canonical page's configFetching/configError gate: never keep
  // displaying a prior publication projection while authority is revalidated.
  const approvedDetails = !details.isFetching && !details.isError ? details.data : undefined;
  const props = carousel ? {
    record: approvedDetails?.record || { id: record.id },
    directory: approvedDetails?.config.directory || {},
    displaySettings: approvedDetails?.config.displaySettings || {},
    fields: (entityType === "organization" ? approvedDetails?.config.orgCustomFields : approvedDetails?.config.directoryCustomFields) || [],
    values: approvedDetails?.record.customValues || {},
    roles: approvedDetails?.config.roles || [],
    organization: approvedDetails?.record.organization_name ? { name: approvedDetails.record.organization_name } : undefined,
    loading: details.isPending || details.isFetching,
    error: details.isError,
    onRetry: () => details.refetch(),
  } : entityType === "organization" ? {
    // Do not fall back to a stale list projection after a denied detail read.
    record: approvedDetails?.record || { id: record.id, name: record.name },
    directory: approvedDetails?.directory || config.directory,
    displaySettings: approvedDetails?.displaySettings || config.displaySettings,
    fields: approvedDetails?.fields || [],
    values: approvedDetails?.values || {},
    loading: details.isPending || details.isFetching,
    error: details.isError,
    onRetry: () => details.refetch(),
  } : {
    record,
    directory: config.directory,
    displaySettings: config.displaySettings,
    fields: config.directoryCustomFields || [],
    values: record.customValues || {},
    roles: config.roles || [],
    organization: record.organization_name ? { name: record.organization_name } : undefined,
  };
  return <DirectoryGuestDetailDialog {...props} entityType={entityType} onClose={close} />;
}
