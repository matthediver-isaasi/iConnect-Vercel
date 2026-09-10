import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Database, Loader2 } from "lucide-react";
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

/** One orderable custom-object field on an organisation card back. */
export function DirectoryObjectSourceField({
  source,
  organizationId,
  directoryId = "main",
  enabled = true,
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
    retry: false,
  });

  const items = (query.data?.pages || []).flatMap(page => page.items || []);
  const resolvedSource = query.data?.pages?.[0]?.source || source;
  const isRevalidating = query.isFetching && !query.isPending && !query.isFetchingNextPage;

  // A removed or no-longer-authorized source is absent content. Infrastructure
  // failures remain explicit and retryable rather than masquerading as empty.
  if (query.isError && [401, 403, 404].includes(query.error?.status)) return null;

  // An empty terminal result is absent content, not a blank card-back section.
  // An empty page with a cursor remains visible so every subsequent page is
  // reachable without unbounded eager loading.
  if (!query.isPending && !query.isError && !isRevalidating && items.length === 0 && !query.hasNextPage) {
    return null;
  }

  return (
    <div className="space-y-3 pt-2 border-t" data-testid={`directory-object-source-${source.key}`}>
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-blue-600" />
        <h4 className="font-medium text-slate-900">{source.label}</h4>
      </div>
      {query.isPending || isRevalidating ? (
        <div className="flex justify-center py-3">
          <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
        </div>
      ) : query.isError ? (
        <div className="flex items-center justify-between gap-3 text-sm text-red-700">
          <span className="flex items-center gap-2"><AlertCircle className="w-4 h-4" />Values unavailable</span>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>Retry</Button>
        </div>
      ) : (
        <>
          {items.length > 0 && (
            <div className="space-y-3">
              {items.map((item, index) => (
                <div
                  key={`${item.record_id}-${index}`}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4"
                >
                  <span className="text-sm text-slate-600 break-words">{item.label || "Record"}</span>
                  <div className="min-w-0 text-sm font-medium text-slate-900 break-words">
                    <PresentValue source={resolvedSource} item={item} />
                  </div>
                </div>
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
    </div>
  );
}
