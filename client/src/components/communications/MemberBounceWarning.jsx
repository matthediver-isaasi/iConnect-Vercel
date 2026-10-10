import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import BounceDetails from "./BounceDetails";
import { canQueryMemberBounce } from "./bounceModel.mjs";
import { useMemberBounce } from "./use-bounces";

export default function MemberBounceWarning({ memberId, email, enabled = true }) {
  // Remount dialog state as well as the query when the saved email changes.
  return <MemberBounceState key={`${memberId}:${email || ""}`} memberId={memberId} email={email} enabled={enabled} />;
}

function MemberBounceState({ memberId, email, enabled }) {
  const [open, setOpen] = useState(false);
  const query = useMemberBounce({ memberId, email, enabled });
  if (!enabled || !canQueryMemberBounce(memberId, email)) return null;
  if (query.isLoading) return <span role="status" className="inline-block animate-pulse rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">Checking bounce status…</span>;
  if (query.isError) return <span role="alert" className="inline-flex flex-wrap items-center gap-2 text-xs text-amber-800"><AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />Bounce status unavailable<Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => query.refetch()} disabled={query.isFetching}>Retry</Button></span>;
  const item = query.data?.item;
  if (!item || item.resolved_at) return null;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><button type="button" className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-left text-xs font-medium text-amber-900 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500" data-testid="member-bounce-warning"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Hard bounce · Campaign emails paused</button></DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>Campaign emails paused</DialogTitle><DialogDescription>This address has a hard bounce. This is a delivery restriction, not a change to this member’s subscription preferences.</DialogDescription></DialogHeader>
      <BounceDetails item={item} showMembers={false} />
      <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">An administrator can review this address in Communications Management → Hard-bounced addresses. Resolving a bounce does not send an email or resubscribe the member.</p>
    </DialogContent>
  </Dialog>;
}
