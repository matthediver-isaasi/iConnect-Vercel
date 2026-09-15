import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRecordValue } from "@/pages/customObjects/recordHelpers";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { isDirectoryEmbedLocation } from "@/hooks/useDirectoryObjectSources";

export function DirectoryObjectSourcesStatus({ query }) {
  if (query?.isFetching) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-slate-500" role="status">
        <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
        Loading custom object fields…
      </div>
    );
  }
  if (query?.isError) {
    return (
      <div className="flex items-center justify-between gap-3 py-2 text-sm text-red-700" role="alert">
        <span className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Custom object fields unavailable
        </span>
        <Button size="sm" variant="outline" onClick={() => query.refetch()}>Retry</Button>
      </div>
    );
  }
  return null;
}

function PresentValue({ source, item }) {
  if (source?.field?.field_type === "file") {
    if (item.value?.unavailable) {
      return <span className="text-sm font-normal text-slate-600">
        This file must be re-uploaded in Data Studio before it can appear in a directory.
      </span>;
    }
    const files = (Array.isArray(item.value) ? item.value : [item.value])
      .filter(file => typeof file?.file_url === "string"
        && file.file_url.startsWith("/api/organisation-directory/custom-object-file?"));
    return (
      <div className="space-y-1">
        {files.map((file, index) => (
          <a key={index} className="block text-blue-600 hover:underline break-all"
            href={file.file_url} target="_blank" rel="noopener noreferrer">
            {file.file_name || "Download file"}
          </a>
        ))}
      </div>
    );
  }
  const field = source?.field || {};
  const displayValue = formatRecordValue(field, item.value);
  if (field.field_type === "url") {
    try {
      const url = new URL(String(item.value));
      if (url.protocol === "http:" || url.protocol === "https:") {
        return (
          <a
            href={url.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline break-all"
          >
            {displayValue}
          </a>
        );
      }
    } catch {
      // Invalid and non-web URL values remain inert text.
    }
  }
  if (field.field_type === "email") {
    const email = String(item.value || "").trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[\r\n]/.test(email)) {
      return <a href={`mailto:${email}`} className="text-blue-600 hover:underline break-all">{displayValue}</a>;
    }
  }
  return <span>{displayValue}</span>;
}

export function getDirectoryObjectSourceContext(source) {
  const labels = [source?.object_label, source?.relationship_label]
    .filter(label => typeof label === "string" && label.trim());
  return [...new Set(labels)].join(" · ");
}

export function getDirectoryObjectSourceGroupId(source) {
  const relationshipId = source?.relationship_id || source?.relationship?.id;
  const objectId = source?.object_id || source?.object?.id;
  if (relationshipId || objectId) return `${relationshipId || ""}:${objectId || ""}:${source?.direction || ""}`;
  return source?.key || "";
}

function FieldValueRow({ source, item, showRecordLabel, showFieldLabel = true }) {
  const fieldLabel = source?.field_label || source?.field?.label || source?.label || "Field";
  return (
    <div className={showRecordLabel ? "rounded-md bg-slate-50 px-3 py-2.5" : ""}>
      {showRecordLabel && (
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 break-words">
          {item.label || "Related record"}
        </p>
      )}
      <dl className={`grid grid-cols-1 gap-1.5 ${showFieldLabel ? "sm:grid-cols-[minmax(7rem,0.8fr)_minmax(0,1.7fr)] sm:gap-3" : ""}`}>
        {showFieldLabel && <dt className="text-sm text-slate-600 break-words">{fieldLabel}</dt>}
        <dd className="min-w-0 text-sm font-medium text-slate-900 break-words">
          <PresentValue source={source} item={item} />
        </dd>
      </dl>
    </div>
  );
}

/** One orderable custom-object field on an organisation card back. */
export function DirectoryObjectSourceField({
  source,
  organizationId,
  directoryId = "main",
  enabled = true,
  showContext,
  precedingContextSourceKeys = [],
  visibleSourceKeys = {},
  onVisibilityChange,
}) {
  const { memberInfo, authResolved } = useMemberAccess();
  const isEmbedded = isDirectoryEmbedLocation();
  const queryKey = [
    "directory-object-source-values",
    memberInfo?.tenant_id || null,
    memberInfo?.id || null,
    directoryId,
    organizationId || null,
    source?.key || null,
  ];
  const query = useInfiniteQuery({
    queryKey,
    enabled: Boolean(
      enabled && authResolved && memberInfo?.id && memberInfo?.tenant_id
      && organizationId && source?.key && !isEmbedded
    ),
    initialPageParam: null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        organization_id: organizationId,
        source_key: source.key,
      });
      if (directoryId && directoryId !== "main") params.set("directory_id", directoryId);
      if (pageParam) params.set("cursor", pageParam);
      const response = await fetch(`/api/organisation-directory/custom-object-fields?${params}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        const error = new Error("Unable to load field values");
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      if (!payload?.source || !Array.isArray(payload.items)) {
        throw new Error("Invalid custom object field values response");
      }
      return payload;
    },
    getNextPageParam: lastPage => lastPage?.nextCursor || undefined,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    // Requests never retry in the background. The explicit, one-click retry
    // keeps failures bounded and prevents repeated work for every open card.
    retry: false,
  });

  const items = (query.data?.pages || []).flatMap(page => page.items || []);
  const resolvedSource = query.data?.pages?.[0]?.source || source;
  const firstPage = query.data?.pages?.[0];
  const hasMultipleRecords = Boolean(
    firstPage?.values?.has_multiple_records
    ?? firstPage?.has_multiple_records
    ?? resolvedSource?.values?.has_multiple_records
    ?? resolvedSource?.has_multiple_records,
  );
  const isRevalidating = query.isFetching && !query.isPending && !query.isFetchingNextPage;
  const context = getDirectoryObjectSourceContext(resolvedSource);
  const accessRevoked = query.isError && [401, 403, 404].includes(query.error?.status);
  const emptyTerminal = !query.isPending && !query.isError && !isRevalidating
    && items.length === 0 && !query.hasNextPage;
  const isVisible = !accessRevoked && !emptyTerminal;
  const hasVisiblePredecessor = precedingContextSourceKeys.some(key => visibleSourceKeys[key]);
  const shouldShowContext = showContext ?? !hasVisiblePredecessor;

  useEffect(() => {
    onVisibilityChange?.(source?.key, isVisible);
    return () => onVisibilityChange?.(source?.key, false);
  }, [isVisible, onVisibilityChange, source?.key]);

  // A removed or no-longer-authorized source is absent content. Infrastructure
  // failures remain explicit and retryable rather than masquerading as empty.
  if (accessRevoked) return null;

  // An empty terminal result is absent content, not a blank card-back section.
  // An empty page with a cursor remains visible so every subsequent page is
  // reachable without unbounded eager loading.
  if (emptyTerminal) {
    return null;
  }

  return (
    <section className="space-y-2.5 py-2" data-testid={`directory-object-source-${source.key}`}>
      {shouldShowContext && context && (
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 break-words">
          {context}
        </p>
      )}
      {query.isPending || isRevalidating ? (
        <div className="flex items-center gap-2 py-1 text-sm text-slate-500" role="status">
          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
          Loading field…
        </div>
      ) : query.isError ? (
        <div className="flex items-center justify-between gap-3 text-sm text-red-700">
          <span className="flex items-center gap-2"><AlertCircle className="w-4 h-4" />Values unavailable</span>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>Retry</Button>
        </div>
      ) : (
        <>
          {items.length > 0 && (
            <div className="space-y-2">
              {hasMultipleRecords && (
                <p className="text-sm text-slate-600 break-words">
                  {resolvedSource?.field_label || resolvedSource?.field?.label || resolvedSource?.label || "Field"}
                </p>
              )}
              {items.map((item, index) => (
                <FieldValueRow
                  key={`${item.record_id}-${index}`}
                  source={resolvedSource}
                  item={item}
                  showRecordLabel={hasMultipleRecords}
                  showFieldLabel={!hasMultipleRecords}
                />
              ))}
            </div>
          )}
          {items.length === 0 && query.hasNextPage && (
            <p className="text-sm text-slate-500">More related records are available.</p>
          )}
          {query.hasNextPage && (
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
            >
              {query.isFetchingNextPage && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Load more
            </Button>
          )}
        </>
      )}
    </section>
  );
}
