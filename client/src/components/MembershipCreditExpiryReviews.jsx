import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, History } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTicketViewerKey } from "@/hooks/useTicketViewerKey";
import { adminFetch } from "@/lib/adminFetch";

const endpoint = "/api/membership/member-amendments";
const stamp = value => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? `${parsed.toISOString()} (UTC)` : "Not supplied";
};
const money = (minor, currency) => {
  if (!Number.isSafeInteger(minor) || !/^[A-Z]{3}$/.test(currency || "")) return "Not supplied";
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100); }
  catch { return "Invalid currency"; }
};
async function readResponse(response) {
  let body;
  try { body = await response.json(); }
  catch { throw new Error("The server response could not be read. No review outcome has been confirmed."); }
  if (!response.ok) {
    const error = new Error(body?.error?.message || (typeof body?.error === "string" ? body.error : null) || body?.message || `Review request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}
function validItem(item) {
  return !!(typeof item?.amendmentId === "string" && item.amendmentId
    && typeof item.memberId === "string" && item.memberId
    && typeof item.voucherCode === "string" && item.voucherCode
    && Number.isSafeInteger(item.availableMinor) && item.availableMinor >= 0
    && /^[A-Z]{3}$/.test(item.currency || "")
    && (item.expiresAt == null || Number.isFinite(Date.parse(item.expiresAt)))
    && (item.lastReview == null || validReview(item.lastReview))
    && typeof item.needsReview === "boolean");
}
const validReview = value => !!(typeof value?.note === "string" && value.note.trim()
  && typeof value.actorId === "string" && value.actorId && Number.isFinite(Date.parse(value.reviewedAt))
  && Number.isSafeInteger(value.availableMinor) && value.availableMinor >= 0);

// Use the same validated role/feature and tenant-viewer hooks as VoucherManagement.
// A denied or unresolved role never mounts the tenant-wide finance query.
export default function MembershipCreditExpiryReviews() {
  const { isAdmin, isFeatureExcluded, isAccessReady, memberInfo, sessionValidated, roleStatus } = useMemberAccess();
  const [tenantId, actorId] = useTicketViewerKey(memberInfo);
  const allowed = isAccessReady && sessionValidated && roleStatus === "ready"
    && isAdmin && !!memberInfo?.id && !!actorId && !!tenantId
    && (!memberInfo.tenant_id || memberInfo.tenant_id === tenantId)
    && !isFeatureExcluded("page_VoucherManagement")
    && !isFeatureExcluded("commerce.monthly-finance-report");
  if (!allowed) return null;
  return <ExpiryReviews key={JSON.stringify([tenantId, actorId, memberInfo.role_id || ""])} tenantId={tenantId} actorId={actorId} />;
}

function ExpiryReviews({ tenantId, actorId }) {
  const queryClient = useQueryClient();
  const queryKey = ["membership-credit-expiry-reviews", tenantId, actorId];
  const denialKey = ["membership-credit-expiry-review-access-denied", tenantId, actorId];
  const [expanded, setExpanded] = useState(false);
  const [denied, setDenied] = useState(false);
  const loadingMore = useRef(false);
  // A cached denial must not become a new request when the panel is reopened.
  const cachedDenial = queryClient.getQueryData(denialKey) === true || queryClient.getQueryState(queryKey)?.error?.status === 403;
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null,
    queryFn: async ({ signal, pageParam }) => {
      const suffix = pageParam === null ? "" : `&after=${encodeURIComponent(pageParam)}`;
      const result = await readResponse(await adminFetch(`${endpoint}?action=credit_expiry_reviews${suffix}`, { signal }, tenantId));
      if (!Array.isArray(result?.items) || result.items.length > 100
        || !(result.nextCursor === null || (typeof result.nextCursor === "string" && result.nextCursor.length > 0))) {
        throw new Error("The server did not return a valid expiry-review list and pagination cursor. Loaded records are retained; no complete or empty outcome is inferred.");
      }
      return result;
    },
    getNextPageParam: (lastPage, _pages, _lastParam, pageParams) => {
      const cursor = lastPage.nextCursor;
      return cursor !== null && !pageParams.includes(cursor) ? cursor : undefined;
    },
    enabled: expanded && !denied && !cachedDenial,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: 30_000,
  });
  const forbidden = denied || cachedDenial || query.error?.status === 403;
  useEffect(() => {
    if (query.error?.status === 403) {
      setDenied(true);
      queryClient.setQueryData(["membership-credit-expiry-review-access-denied", tenantId, actorId], true);
    }
  }, [query.error, queryClient, tenantId, actorId]);
  const pages = query.data?.pages || [];
  const itemsByOwner = new Map();
  for (const page of pages) {
    for (const item of page.items) {
      // Overlapping pages must not duplicate forms or hide a newer review.
      itemsByOwner.set(JSON.stringify([item?.amendmentId, item?.memberId]), item);
    }
  }
  const items = [...itemsByOwner.values()];
  const nextCursor = pages.length ? pages[pages.length - 1].nextCursor : null;
  const repeatedCursor = nextCursor !== null && query.data?.pageParams.includes(nextCursor);
  const invalid = items.some(item => !validItem(item));
  const expired = items.filter(item => validItem(item) && item.availableMinor > 0
    && item.expiresAt && Date.parse(item.expiresAt) <= Date.now());
  function refresh() {
    if (!forbidden) void query.refetch();
  }
  async function loadMore() {
    if (forbidden || loadingMore.current || query.isFetching || !query.hasNextPage || repeatedCursor) return;
    loadingMore.current = true;
    try { await query.fetchNextPage({ cancelRefetch: false }); }
    finally { loadingMore.current = false; }
  }
  function saved() {
    // This discrete audit action must refresh current balance and review status.
    void queryClient.invalidateQueries({ queryKey, exact: true });
  }
  function deny() {
    setDenied(true);
    queryClient.setQueryData(denialKey, true);
  }
  return <Card className="border-slate-200 shadow-sm mb-6" data-testid="membership-credit-expiry-reviews">
    <div className="p-4">
      <Button type="button" variant="ghost" className="h-auto w-full justify-between gap-3 whitespace-normal text-left p-0 hover:bg-transparent" aria-expanded={expanded} aria-controls="membership-credit-expiry-review-content" onClick={() => setExpanded(previous => !previous)}>
        <span className="flex items-center gap-2"><History className="h-4 w-4 shrink-0" /><span>Expired membership-change credit · finance review</span></span>
        <ChevronDown className={`h-4 w-4 shrink-0 ${expanded ? "rotate-180" : ""}`} />
      </Button>
      <p className="mt-2 text-sm text-muted-foreground">Audit review only. Recording a note never writes off liability, changes credit balances, extends expiry or restores spendability.</p>
    </div>
    <CardContent id="membership-credit-expiry-review-content" hidden={!expanded} className="space-y-4 pt-0">
      {forbidden ? <div role="alert" className="rounded-md border p-3 text-sm">
        Finance access was denied. Review records are hidden and no automatic retry will be made. Contact your tenant administrator if finance access is required.
      </div> : <>
        {expanded && query.isPending && <div role="status" aria-label="Loading expired membership-change credits" className="space-y-2">
          <div className="h-5 w-2/3 rounded bg-muted" /><div className="h-20 rounded bg-muted" />
        </div>}
        {query.isError && <div role="alert" className="space-y-2 text-sm">
          <p>{query.isFetchNextPageError ? "More expiry reviews could not be loaded" : "Expiry reviews could not be loaded"}: {query.error?.message}. {query.data ? "Previously loaded balances and review states remain visible; saving is disabled until loading succeeds." : "No review outcome is inferred."}</p>
          <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={query.isFetchNextPageError ? loadMore : refresh}>{query.isFetchNextPageError ? "Retry loading more expiry reviews" : "Retry loading expiry reviews"}</Button>
        </div>}
        {query.data && <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p>{expired.length} reviewable outstanding expired membership-change {expired.length === 1 ? "credit" : "credits"} loaded.{query.hasNextPage ? " More records are available." : ""} Expiry does not remove the outstanding liability.</p>
            <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={query.isFetching}>{query.isFetching ? "Refreshing expiry reviews…" : "Refresh expiry reviews"}</Button>
          </div>
          {invalid && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">Some records contain incomplete balance, currency or expiry evidence and cannot be reviewed. Refresh or ask finance support to resolve the evidence.</p>}
          {repeatedCursor && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">Pagination stopped because the server returned a previously used cursor. Loaded records remain visible; refresh the list or ask finance support to resolve pagination before assuming the list is complete.</p>}
          {!expired.length ? <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{invalid ? "No reviewable records can be shown until incomplete evidence is resolved. No liability outcome is inferred." : query.hasNextPage ? "No reviewable expired credits on the loaded pages. Load more to check the remaining records." : "No outstanding expired membership-change credits to review. Unexpired credits, credits without an expiry and zero balances are excluded. This is not a liability write-off."}</div> :
            <ol className="space-y-3">{expired.map(item => <li key={`${item.amendmentId}:${item.memberId}`}>
              <ExpiryReviewItem item={item} tenantId={tenantId} enabled={!query.isError && !query.isFetching && !forbidden} onSaved={saved} onDenied={deny} onRefresh={refresh} />
            </li>)}</ol>}
          {query.hasNextPage && !repeatedCursor && <div className="space-y-2">
            <Button type="button" variant="outline" disabled={query.isFetching || forbidden} onClick={loadMore}>{query.isFetchingNextPage ? "Loading more expiry reviews…" : "Load more"}</Button>
            {query.isFetchingNextPage && <div role="status" aria-label="Loading more expired membership-change credits" className="h-12 rounded bg-muted" />}
          </div>}
        </>}
      </>}
    </CardContent>
  </Card>;
}

function ExpiryReviewItem({ item, tenantId, enabled, onSaved, onDenied, onRefresh }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [savedReview, setSavedReview] = useState(null);
  const active = useRef(true);
  const busy = useRef(false);
  const attempted = useRef(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const previous = savedReview && (!item.lastReview || Date.parse(savedReview.reviewedAt) >= Date.parse(item.lastReview.reviewedAt))
    ? savedReview : item.lastReview;
  const serverReviewStamp = JSON.stringify(item.lastReview || null);
  useEffect(() => {
    // A read-only reload can resolve a lost acknowledgement without another POST.
    if (attempted.current && item.lastReview?.note === attempted.current && validReview(item.lastReview)) {
      setSavedReview(item.lastReview);
      setUncertain(false);
      setFailure("");
      setNote("");
    }
  }, [serverReviewStamp]);
  async function save(event) {
    event.preventDefault();
    if (busy.current || !enabled || uncertain || !note.trim() || note.length > 2000) return;
    busy.current = true;
    setPending(true);
    setFailure("");
    const submittedNote = note.trim();
    attempted.current = submittedNote;
    try {
      const result = await readResponse(await adminFetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "review_credit_expiry", memberId: item.memberId, amendmentId: item.amendmentId, note: submittedNote }),
      }, tenantId));
      if (!active.current) return;
      if (!validReview(result?.review) || result.review.note !== submittedNote) throw new Error("The server did not confirm a complete matching review audit record.");
      setSavedReview(result.review);
      setNote("");
      onSaved();
    } catch (error) {
      if (!active.current) return;
      if (error.status === 403) { onDenied(); return; }
      setFailure(error.message || "Review outcome is unconfirmed.");
      // Network/unreadable responses can hide a successful audit insert.
      // Never automatically repeat the POST; read current review evidence first.
      if (!error.status || error.status >= 500) setUncertain(true);
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }
  return <article data-testid={`credit-expiry-review-${item.amendmentId}`} className="rounded-md border p-4 space-y-3 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1"><h3 className="font-medium break-all">{item.voucherCode}</h3>
        <a className="underline underline-offset-4 break-all" href={`/members/${encodeURIComponent(item.memberId)}?tab=membership`}>View member {item.memberId}</a>
      </div>
      <Badge variant="outline">{item.needsReview ? "Finance review required" : "Review recorded"}</Badge>
    </div>
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div><dt className="text-muted-foreground">Current available balance · expired, not spendable</dt><dd className="font-medium">{money(item.availableMinor, item.currency)}</dd></div>
      <div><dt className="text-muted-foreground">Expired at</dt><dd>{stamp(item.expiresAt)}</dd></div>
    </dl>
    <div className="rounded-md bg-muted/50 p-3 space-y-1">
      <p className="font-medium">Previous finance review</p>
      {previous ? <>
        <p className="whitespace-pre-wrap break-words">{previous.note || "Note not supplied"}</p>
        <p>Reviewed: {stamp(previous.reviewedAt)} · Actor: {previous.actorId || "Not supplied"}</p>
        <p>Available balance at review: {money(previous.availableMinor, item.currency)}. Current balance remains {money(item.availableMinor, item.currency)}.</p>
      </> : <p className="text-muted-foreground">No finance review recorded.</p>}
    </div>
    <form onSubmit={save} className="space-y-2">
      <Label htmlFor={`credit-expiry-note-${item.amendmentId}`}>Finance expiry-review note (required)</Label>
      <Textarea id={`credit-expiry-note-${item.amendmentId}`} required maxLength={2000} value={note} disabled={!enabled || pending || uncertain} onChange={event => setNote(event.target.value)} aria-describedby={`credit-expiry-help-${item.amendmentId}`} />
      <p id={`credit-expiry-help-${item.amendmentId}`} className="text-xs text-muted-foreground">Up to 2,000 characters. This records finance audit only; it never writes off liability or restores spendability.</p>
      <Button type="submit" variant="outline" disabled={!enabled || pending || uncertain || !note.trim() || note.length > 2000}>{pending ? "Saving finance review…" : "Save finance review"}</Button>
    </form>
    {savedReview && <p role="status">Finance review recorded. Liability and spendability are unchanged.</p>}
    {failure && <div role="alert" className="space-y-2">
      <p>{failure}</p>
      {uncertain && <><p>Review outcome unconfirmed. Check current review evidence before saving another note; no automatic retry will be made. If no matching review is returned, contact finance support before submitting another audit note.</p>
        <Button type="button" variant="outline" size="sm" disabled={!enabled || pending} onClick={onRefresh}>Check review outcome</Button>
      </>}
    </div>}
  </article>;
}
